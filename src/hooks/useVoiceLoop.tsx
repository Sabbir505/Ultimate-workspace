// The hands-free voice loop controller (Phase D of the voice-mode research,
// docs/research/REALTIME_VOICE_MODE_RESEARCH.md).
//
// One instance is mounted at the app root; it renders nothing. It composes
// the three existing pieces into a continuous loop instead of reimplementing
// any of them:
//
//   listening  — the DICTATION ENGINE (useVoiceDictationCore) captures the mic
//                against a VIRTUAL target backed by the loop store, so live
//                partials, silence-commits, and the repair pass are the exact
//                proven code the composer dictates with. An extended-silence
//                episode (~1.5 s of quiet after a committed segment) yields
//                the turn.
//   sending    — the captured text goes through the chat store's normal
//                sendMessage: same tools, permissions, checkpoints, cost.
//   waiting    — the answer streams. Turn persistence fires
//                notifyVoiceTurnComplete (useTtsAutoRead), which also starts
//                read-aloud (voice mode implies it).
//   speaking   — read-aloud plays; a VOICE-ACTIVITY GATE watches the mic for
//                barge-in (Phase A): suspect → pause-and-check through the
//                player's own pause/resume (echo guard for speakers), confirm
//                → stop playback, cancel the stream, and go straight back to
//                listening. Playback ending naturally also returns to
//                listening.
//
// The loop is engine-agnostic by construction: "waiting/speaking" are driven
// by the TTS store's phase, so a future S2S or cloud-realtime engine slots in
// behind the same state machine.
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  VoiceActivityGate,
  startMicLevelFeed,
} from "../lib/voiceActivity";
import {
  useVoiceDictationCore,
  type DictationTarget,
} from "../lib/voiceDictationCore";
import { ttsPlayer } from "../lib/tts";
import { useChatStore } from "../state/chat";
import { useTtsStore } from "../state/tts";
import {
  onVoiceLoopStartRequest,
  onVoiceLoopStopRequest,
  onVoiceTurnComplete,
  useVoiceLoopStore,
} from "../state/voiceLoop";

/** How long after turn-persistence to wait for read-aloud to actually start
 *  before concluding there is no voice engine and resuming the mic. */
const SPEAK_START_GRACE_MS = 1500;

export function VoiceLoopController(): null {
  const mode = useVoiceLoopStore((s) => s.mode);
  const phase = useVoiceLoopStore((s) => s.phase);

  // Load the persisted mode once per run. The mic is deliberately NOT opened
  // here — restoring hands-free at boot without a gesture would silently open
  // a microphone; the composer's toggle (a click) starts listening.
  useEffect(() => {
    void useVoiceLoopStore.getState().load();
  }, []);

  // The dictation engine writes into a VIRTUAL target backed by the loop
  // store: `read` is authoritative (the splice validator checks the span
  // against it), write/setCaret/focus land in state instead of a DOM buffer.
  const virtualTarget = useMemo<DictationTarget>(
    () => ({
      read: () => useVoiceLoopStore.getState().transcript,
      write: (from, to, text) => {
        const doc = useVoiceLoopStore.getState().transcript;
        const next = doc.slice(0, from) + text + doc.slice(to);
        useVoiceLoopStore.getState().set({ transcript: next });
        return { from, to: from + text.length };
      },
      setCaret: () => {},
      focus: () => {},
      isFocused: () => false,
    }),
    [],
  );

  const dict = useVoiceDictationCore({
    target: virtualTarget,
    pushToTalk: false,
    isActiveTarget: () => true,
    onExtendedSilence: () => onYieldRef.current(),
  });
  // Mirror for the async paths (the yield callback, the TTS subscription),
  // which would otherwise read a stale `recording` from a closed-over render.
  const recordingRef = useRef(false);
  recordingRef.current = dict.recording;

  // ---- listening → sending → waiting ----
  const yieldingRef = useRef(false);
  /** The session the loop sent to — turn-complete notifications for other
   *  sessions (background chats finishing) must not move this loop. */
  const pendingSessionRef = useRef<string | null>(null);
  /** Set by the loop bar's stop button: the next natural "back to listening"
   *  transition lands on idle instead, and the latch clears. */
  const stopRequestedRef = useRef(false);

  const startListening = useCallback(() => {
    const store = useVoiceLoopStore.getState();
    if (store.mode !== "handsfree") return;
    if (recordingRef.current) return;
    store.set({ phase: "listening", transcript: "", level: 0, error: null });
    dict.toggleRecording(); // not recording → begins capture
  }, [dict]);
  const startListeningRef = useRef(startListening);
  startListeningRef.current = startListening;

  const yieldTurn = useCallback(async () => {
    const store = useVoiceLoopStore.getState();
    if (store.mode !== "handsfree" || store.phase !== "listening") return;
    if (yieldingRef.current) return; // one yield per silence episode
    const text = store.transcript.trim();
    if (!text) return; // quiet room, nothing said — keep listening
    yieldingRef.current = true;
    try {
      // Finish the capture: stops the mic and waits out the commit chain, so
      // the transcript is the full utterance (the trailing segment included).
      if (recordingRef.current) await dict.toggleRecording();
      const finalText = useVoiceLoopStore.getState().transcript.trim();
      const sessionId = useChatStore.getState().activeChatSessionId;
      if (!finalText || !sessionId) return;
      pendingSessionRef.current = sessionId;
      useVoiceLoopStore.getState().set({ phase: "sending" });
      // Fire, not await — sendMessage resolves when the TURN completes; the
      // waiting state is ours to manage from here via the turn-complete
      // notification.
      void useChatStore
        .getState()
        .sendMessage(finalText)
        .catch(() => {
          // The chat store toasts the failure itself; free the loop.
          if (useVoiceLoopStore.getState().phase === "sending") {
            useVoiceLoopStore.getState().set({ phase: "idle", transcript: "" });
          }
        });
      if (useVoiceLoopStore.getState().phase === "sending") {
        useVoiceLoopStore.getState().set({ phase: "waiting", transcript: "" });
      }
    } finally {
      yieldingRef.current = false;
    }
  }, [dict]);
  const onYieldRef = useRef(() => {});
  onYieldRef.current = () => {
    // Runs on the audio tick — defer everything.
    void yieldTurn();
  };

  // ---- waiting → speaking → listening ----

  /** Barge-in (Phase A): stop playback, cut the stream if it is still running,
   *  and hand the floor straight back to the listener. */
  const bargeIn = useCallback(() => {
    ttsPlayer.stop();
    const store = useVoiceLoopStore.getState();
    if (store.phase === "speaking") {
      const session =
        pendingSessionRef.current ?? useChatStore.getState().activeChatSessionId;
      // Harmless no-op when the turn already finished streaming.
      if (session) void useChatStore.getState().cancelStream(session);
      startListeningRef.current();
    }
  }, []);
  const bargeInRef = useRef(bargeIn);
  bargeInRef.current = bargeIn;

  // The TTS store's phase IS the speaking state machine: loading/buffering/
  // playing = speaking (watcher armed); idle = the read finished → listen
  // again, unless the loop bar's stop asked to end the episode.
  useEffect(
    () =>
      useTtsStore.subscribe((s) => {
        const store = useVoiceLoopStore.getState();
        if (store.mode !== "handsfree") return;
        if (store.phase === "waiting" && (s.phase === "playing" || s.phase === "buffering")) {
          store.set({ phase: "speaking" });
          return;
        }
        if (store.phase === "speaking" && s.phase === "idle") {
          if (stopRequestedRef.current) {
            stopRequestedRef.current = false;
            store.set({ phase: "idle" });
            return;
          }
          startListeningRef.current();
        }
      }),
    [],
  );

  // Turn persistence landed: either read-aloud starts (the subscription above
  // flips us to speaking) or there is no voice engine — resume the mic after
  // a grace beat so a TTS-less setup still loops.
  useEffect(() => {
    onVoiceTurnComplete((sessionId) => {
      const store = useVoiceLoopStore.getState();
      if (store.mode !== "handsfree" || store.phase !== "waiting") return;
      if (sessionId !== pendingSessionRef.current) return;
      window.setTimeout(() => {
        const s = useVoiceLoopStore.getState();
        if (s.mode !== "handsfree" || s.phase !== "waiting") return;
        // The subscription owns the happy path; this catches "no TTS model".
        if (useTtsStore.getState().phase === "idle") {
          s.set({ phase: "idle", transcript: "" });
          startListeningRef.current();
        }
      }, SPEAK_START_GRACE_MS);
    });
  }, []);

  // The barge-in watcher (Phase A): mic open, energy-only, no transcription —
  // it exists to catch speech while Relay is talking. Armed exactly while the
  // loop is in the speaking state.
  useEffect(() => {
    if (mode !== "handsfree" || phase !== "speaking") return;
    const gate = new VoiceActivityGate({ echoGuard: true });
    let dead = false;
    let stop: (() => void) | null = null;
    void startMicLevelFeed((rms) => {
      if (dead) return;
      useVoiceLoopStore.getState().set({ level: Math.min(1, rms * 8) });
      const ev = gate.feed(rms);
      if (ev === "suspect") {
        // Could be echo: pause-and-check. The player remembers its offset; a
        // "clear" resumes exactly there.
        ttsPlayer.pause();
      } else if (ev === "confirm") {
        gate.reset();
        bargeInRef.current();
      } else if (ev === "clear") {
        ttsPlayer.resume();
      }
    })
      .then((stopFn) => {
        if (dead) {
          stopFn();
          return;
        }
        stop = stopFn;
      })
      .catch(() => {
        // Mic blocked or absent: the loop keeps working, barge-in just
        // doesn't — surface why instead of silently ignoring the feature.
        useVoiceLoopStore.getState().set({
          error: "Barge-in unavailable — the microphone is blocked.",
        });
      });
    return () => {
      dead = true;
      stop?.();
    };
  }, [mode, phase]);

  // Mode toggled off (or still off while a stale episode winds down): stop
  // capturing and go idle. Playback in flight is left alone — turning the
  // voice mode off should not cut audio the user is listening to.
  useEffect(() => {
    if (mode !== "off") return;
    if (recordingRef.current) dict.cancelRecording();
    useVoiceLoopStore.getState().set({ phase: "idle", transcript: "" });
  }, [mode, dict]);

  // Composer toggle turning hands-free ON: start listening immediately (this
  // IS the user gesture that justifies the mic prompt).
  useEffect(() => {
    onVoiceLoopStartRequest(() => {
      stopRequestedRef.current = false;
      startListeningRef.current();
    });
    onVoiceLoopStopRequest(() => {
      const store = useVoiceLoopStore.getState();
      stopRequestedRef.current = true;
      if (store.phase === "listening") {
        dict.cancelRecording();
        store.set({ phase: "idle", transcript: "" });
        stopRequestedRef.current = false;
      } else if (store.phase === "speaking") {
        ttsPlayer.stop(); // idle transition consumes the latch above
      } else {
        store.set({ phase: "idle", transcript: "" });
        stopRequestedRef.current = false;
      }
    });
  }, [dict]);

  return null;
}
