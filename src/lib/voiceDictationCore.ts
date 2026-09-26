// Voice dictation engine — the text-agnostic half, shared by the chat
// composer and the vault note editor. Capture raw mic samples on a 16 kHz
// AudioContext, commit each silence-bounded segment as stable words, re-render
// the live partial in place every tick, and run one repair pass on stop for
// any audio whose commit failed. The same STT server either way — the sidecar
// lazy-starts itself.
//
// Everything here is about AUDIO and about a SPAN OF TEXT. How that span maps
// onto a real buffer (a <textarea> draft, a CodeMirror document) is the
// caller's business, through DictationTarget. That split is what lets two
// surfaces share one engine instead of forking ~400 lines of subtle
// concurrency code.
import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeAudio, cancelTranscription, toastError } from "./ipc";
import { blobToBase64, encodeWav16k, joinSamples } from "./voiceRecording";

/** Live-partial cadence and segment limits. While the mic is open the
 *  un-committed segment is re-transcribed every 1.5s so dictated text lands
 *  in the target as you speak; a ~0.77s pause (3 audio chunks) commits the
 *  segment, and a segment with no pause at all is force-committed at 20s to
 *  bound each request's cost. */
export const PARTIAL_TICK_MS = 1500;
export const VOICE_SILENCE_CHUNKS = 3;
export const SEGMENT_MAX_SECONDS = 20;

/** Whisper was trained on subtitle-style transcripts and sprinkles newline
 *  tokens at segment boundaries — mid-flow, semi-random — plus bracketed
 *  non-speech markers ([BLANK_AUDIO], [MUSIC], …) for quiet tails. Flatten
 *  both away into one predictable paragraph. */
export function flattenVoiceText(text: string): string {
  return text
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Diagnostics helper: seconds of audio in a captured chunk list (the list's
 *  `.length` is the CHUNK count — chunks are 256ms each at 16 kHz — so sum
 *  the samples, never divide the count). */
export function chunkSeconds(chunks: Float32Array[], rate: number): number {
  return chunks.reduce((n, c) => n + c.length, 0) / rate;
}

/** Dictation diagnostics — dev builds only (these lines diagnosed the
 *  Alt-release menu-mode IPC stall; keep them for the next one). */
export const voiceLog = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.info(...args);
};

/** A half-open [from, to) range of the target's text. */
export interface DictationSpan {
  from: number;
  to: number;
}

/** The editable buffer dictation writes into.
 *
 *  Positions are plain character offsets into `read()` — CodeMirror document
 *  positions and textarea offsets are both exactly that, so no adapter has to
 *  translate a line/column pair. Implementations MUST make `read()`
 *  synchronously authoritative: the engine reads it to validate the dictated
 *  span and then writes, and a stale read would clobber concurrent typing. */
export interface DictationTarget {
  /** The full current text of the buffer. */
  read(): string;
  /** Replace [from, to) with `text`, returning the range now occupied by it. */
  write(from: number, to: number, text: string): DictationSpan;
  /** Put the caret at `pos` (mirror + visible selection), clamped by the impl. */
  setCaret(pos: number): void;
  /** Focus the buffer. */
  focus(): void;
  /** Whether the buffer currently holds focus. */
  isFocused(): boolean;
}

/** Decide which range of the target's text the next dictated chunk replaces.
 *
 *  The engine tracks the [from, to) span it last wrote along with the exact
 *  text it put there. If the document still holds that text, the region is
 *  still ours and the new text replaces it in place. If it does NOT — the user
 *  hand-edited or deleted inside the dictated region — writing there would
 *  silently destroy their edit, so the update is appended at the end instead.
 *
 *  This is the whole "don't clobber the user" rule, isolated so it can be
 *  tested without a microphone.
 */
export function resolveDictationWrite(
  doc: string,
  span: DictationSpan | null,
  rendered: string,
): { from: number; to: number } {
  const owned = !!span && doc.slice(span.from, span.to) === rendered;
  return owned && span ? { from: span.from, to: span.to } : { from: doc.length, to: doc.length };
}

export function useVoiceDictationCore({
  target,
  pushToTalk = false,
  isActiveTarget,
}: {
  target: DictationTarget;
  /** Enable window-global Alt-hold push-to-talk. */
  pushToTalk?: boolean;
  /** Push-to-talk handlers are window-global, so a surface mounted more than
   *  once (split chat, two open notes) must nominate the focused one — a solo
   *  Alt press would otherwise open a mic capture in every instance. */
  isActiveTarget?: () => boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // The target is a fresh object on most renders, but every callback below
  // must stay referentially stable: the push-to-talk effect re-registers
  // window listeners whenever its deps change. Read it through a ref instead
  // of listing it as a dependency.
  const targetRef = useRef(target);
  targetRef.current = target;
  // Live dictation lands directly in the target: while the mic is open,
  // Float32 sample chunks from a ScriptProcessor on a 16 kHz AudioContext
  // (no MediaRecorder) fill two buffers — the not-yet-committed clip tail
  // (chunks are dropped the moment their segment commits, so stop's repair
  // pass only ever replays failed/un-committed audio), and the current
  // SEGMENT (audio since the last pause) for the live partial. A short
  // silence commits the segment's text, so it can never vanish when speech
  // continues; the partial after it is re-rendered in place every tick.
  const samplesRef = useRef<Float32Array[]>([]);
  const segmentRef = useRef<Float32Array[]>([]);
  const segmentLenRef = useRef(0);
  const silenceRunRef = useRef(0);
  const segmentHadSoundRef = useRef(false);
  /** Bumped whenever a segment is handed to the commit chain; live-partial
   *  results tagged with an older gen are dropped so a transcription that
   *  overlaps a flush can't duplicate committed words. */
  const segmentGenRef = useRef(0);
  /** Serializes segment-commit transcriptions so their text appends in
   *  audio order even when two flushes overlap. */
  const commitChainRef = useRef<Promise<void>>(Promise.resolve());
  /** How many commit jobs are queued or in flight on the chain. Stop uses it
   *  to show the mic spinner exactly while the last text is still landing —
   *  and to skip the spinner (and its one-frame flash) when nothing pends. */
  const pendingCommitsRef = useRef(0);
  /** At most one live-partial request may be outstanding. The whisper server
   *  transcribes strictly serially, so every extra queued request delays the
   *  segment commits and the stop-flush behind it — a pile-up of stale
   *  partials was the main "dictation gets slower the longer I talk" cause. */
  const partialInFlightRef = useRef(false);
  /** Commit results apply only while this equals the value captured when the
   *  segment was flushed. Cancel and re-begin bump it so a stale commit can
   *  never land in the wrong buffer; stop deliberately does NOT — commits
   *  still in flight when recording stops must finish landing, because the
   *  full-clip safety pass no longer re-transcribes everything. */
  const commitArmRef = useRef(0);
  /** Latched when a segment commit fails; stop runs the old full-clip repair
   *  pass only when this is set, instead of after every dictation. */
  const commitFailedRef = useRef(false);
  // Where the live dictation text sits in the target: [from, to) span, plus
  // the exact text last rendered there (the splice validates against it — if
  // the user edited that region by hand, the next update appends at the end
  // instead of clobbering their edit).
  const voiceSpanRef = useRef<DictationSpan | null>(null);
  const voiceRenderedRef = useRef("");
  const voiceCommittedRef = useRef("");
  const voicePartialRef = useRef("");
  const voiceFocusAppliedRef = useRef(false);
  const rateRef = useRef(16000);
  const levelRef = useRef(0);
  const generationRef = useRef(0);
  const partialTimerRef = useRef<number | null>(null);
  const waveBarsRef = useRef<(HTMLSpanElement | null)[]>([]);
  // Mirrors `recording` for hotkey/async paths where state may be stale, plus
  // a "released while the mic was still opening" latch (push-to-talk during
  // the first-run permission prompt).
  const recordingRef = useRef(false);
  const pendingStopRef = useRef(false);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const captureNodesRef = useRef<{
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    sink: GainNode;
  } | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);

  const stopCapture = useCallback(() => {
    recordingRef.current = false;
    pendingStopRef.current = false;
    if (partialTimerRef.current !== null) {
      window.clearInterval(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    // A live partial still in flight is stale from this moment (its result
    // would be dropped) — cancel it so the server's serial inference queue is
    // free for the commits that actually matter. The whisper server aborts
    // inference early when its client disconnects.
    if (partialInFlightRef.current) {
      cancelTranscription("partial").catch(() => {});
    }
    const nodes = captureNodesRef.current;
    captureNodesRef.current = null;
    if (nodes) {
      try {
        nodes.source.disconnect();
        nodes.processor.disconnect();
        nodes.sink.disconnect();
      } catch {
        // graph already torn down
      }
    }
    void captureCtxRef.current?.close().catch(() => {});
    captureCtxRef.current = null;
    captureStreamRef.current?.getTracks().forEach((t) => t.stop());
    captureStreamRef.current = null;
  }, []);

  // Unmount mid-recording (view switch, note close, window close) must not
  // leak the mic.
  useEffect(() => stopCapture, [stopCapture]);

  // Diagnostics: WebView2 throttles occluded/hidden windows hard enough to
  // stall invoke delivery (observed: a finished transcription's response sat
  // undelivered for 68s while the server had completed in 0.96s). Log
  // visibility/focus transitions so a slow stop can be correlated with the
  // window going to the background.
  useEffect(() => {
    const stamp = () => new Date().toISOString().slice(11, 23);
    const onVis = () =>
      voiceLog(
        `[voice] ${stamp()} window ${document.visibilityState === "hidden" ? "HIDDEN (renderer throttled)" : "visible"} focus=${document.hasFocus()}`,
      );
    const onBlur = () =>
      voiceLog(`[voice] ${stamp()} window lost focus (visibility=${document.visibilityState})`);
    const onFocus = () =>
      voiceLog(`[voice] ${stamp()} window gained focus (visibility=${document.visibilityState})`);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Wave animation: bars breathe with the live input level (levelRef is fed
  // by onaudioprocess). rAF writes heights straight to the DOM — React state
  // at 60fps would re-render the whole surface.
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    let phase = 0;
    const tick = () => {
      phase += 0.35;
      const lvl = Math.min(1, levelRef.current * 6);
      for (let i = 0; i < waveBarsRef.current.length; i++) {
        const el = waveBarsRef.current[i];
        if (!el) continue;
        const wobble = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase * 2 + i * 0.55));
        const h = lvl > 0.01 ? 3 + Math.min(21, lvl * 26 * wobble + 2) : 3;
        el.style.height = `${h.toFixed(1)}px`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  // Splice the current dictation text (committed segments + live partial)
  // into the target at the tracked span. Validation runs against the
  // freshest text; if the user hand-edited the region, the update appends at
  // the end rather than clobbering their edit.
  const renderVoiceText = useCallback(() => {
    const committed = voiceCommittedRef.current;
    const partial = voicePartialRef.current;
    const text = partial ? (committed ? `${committed} ` : "") + partial : committed;
    if (!text) return;
    const t = targetRef.current;
    const rendered = voiceRenderedRef.current;
    voiceRenderedRef.current = text;
    const range = resolveDictationWrite(t.read(), voiceSpanRef.current, rendered);
    voiceSpanRef.current = t.write(range.from, range.to, text);
    // Caret follows the dictated text once the write has landed; the real
    // selection is only moved once the target has focus.
    requestAnimationFrame(() => {
      const s = voiceSpanRef.current;
      if (!s) return;
      if (!t.isFocused()) {
        if (voiceFocusAppliedRef.current) return;
        voiceFocusAppliedRef.current = true; // focus once per recording, at the first words
        t.focus();
      }
      t.setCaret(s.to);
    });
  }, []);

  // Undo everything dictation put in the buffer (push-to-talk aborted).
  const removeVoiceSpan = useCallback(() => {
    const span = voiceSpanRef.current;
    const rendered = voiceRenderedRef.current;
    voiceSpanRef.current = null;
    voiceRenderedRef.current = "";
    voiceCommittedRef.current = "";
    voicePartialRef.current = "";
    voiceFocusAppliedRef.current = false;
    if (!span || !rendered) return;
    const t = targetRef.current;
    const doc = t.read();
    if (doc.slice(span.from, span.to) === rendered) t.write(span.from, span.to, "");
  }, []);

  // Hand the current segment to the commit chain: swap it out, transcribe,
  // and append its text as stable committed words. The chain is the record
  // now — commits keep landing after stop (only cancel/re-begin disarm them
  // via commitArmRef), so they must not check the recording generation or the
  // segment gen: a later flush overlapping an in-flight commit would silently
  // drop that segment's words. A failure latches commitFailedRef so stop's
  // repair pass can fill the gap.
  const flushVoiceSegment = useCallback(() => {
    const chunks = segmentRef.current;
    if (chunks.length === 0) return;
    segmentRef.current = [];
    segmentLenRef.current = 0;
    silenceRunRef.current = 0;
    segmentHadSoundRef.current = false;
    segmentGenRef.current += 1;
    const arm = commitArmRef.current;
    // The partial in flight (if any) was transcribing the segment just
    // swapped out — stale now, and its result would be dropped. Cancel it so
    // this commit doesn't queue behind wasted server work.
    if (partialInFlightRef.current) {
      cancelTranscription("partial").catch(() => {});
    }
    pendingCommitsRef.current += 1;
    commitChainRef.current = commitChainRef.current.then(async () => {
      const t0 = performance.now();
      try {
        const wav = encodeWav16k(joinSamples(chunks, rateRef.current));
        const res = await transcribeAudio(await blobToBase64(wav), "audio/wav", "commit");
        if (arm !== commitArmRef.current) return;
        const text = res?.text ? flattenVoiceText(res.text) : "";
        if (text) {
          voiceCommittedRef.current = voiceCommittedRef.current
            ? `${voiceCommittedRef.current} ${text}`
            : text;
          voicePartialRef.current = "";
          renderVoiceText();
        }
        // This segment's words landed, so its raw audio can go: the full-clip
        // buffer only ever feeds stop's repair pass (a commit that FAILED),
        // and keeping just the un-committed tail bounds memory on long
        // dictations instead of retaining the whole session's samples.
        const done = new Set(chunks);
        samplesRef.current = samplesRef.current.filter((c) => !done.has(c));
        voiceLog(
          `[voice] commit ${Math.round(performance.now() - t0)}ms for ${chunkSeconds(chunks, rateRef.current).toFixed(1)}s audio`,
        );
      } catch {
        voiceLog(`[voice] commit failed after ${Math.round(performance.now() - t0)}ms`);
        // Best-effort: the ghost text (if any) stays on screen, and stop's
        // repair pass fills the gap.
        commitFailedRef.current = true;
      } finally {
        pendingCommitsRef.current -= 1;
      }
    });
  }, [renderVoiceText]);

  const finishVoiceRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    generationRef.current += 1; // disarm live partials — their results drop via the gen check
    stopCapture();
    setRecording(false);
    // Hand the trailing (never-paused) segment to the commit chain, then wait
    // out every commit — in-flight ones included — before finalizing. The old
    // always-on full-clip re-transcription is gone: it queued behind the
    // partial pile-up AND re-decoded the whole session, so the last line
    // froze for ages after stop. Commit results keep landing past this point
    // (commitArmRef is deliberately not bumped); they now carry the text.
    if (segmentHadSoundRef.current) {
      voiceLog(
        `[voice] ${new Date().toISOString().slice(11, 23)} stop: flushing trailing segment (${(segmentLenRef.current / rateRef.current).toFixed(1)}s audio), ${pendingCommitsRef.current} commit(s) already pending, visibility=${document.visibilityState}, focus=${document.hasFocus()}`,
      );
      flushVoiceSegment();
    }
    segmentRef.current = [];
    segmentLenRef.current = 0;
    // Segment text already sits in the buffer and stays visible through the
    // repair pass — and survives it if the pass fails or comes back empty.
    try {
      // The trailing segment was just queued above and earlier commits may
      // still be in flight: keep the mic spinner on while the last text is
      // landing, and only when something is actually pending (a settled
      // chain must not flash the spinner for a frame).
      if (pendingCommitsRef.current > 0) setTranscribing(true);
      const settleT0 = performance.now();
      await commitChainRef.current;
      voiceLog(`[voice] stop: commits settled ${Math.round(performance.now() - settleT0)}ms after flush`);
      // Successful commits already dropped their own raw chunks, so whatever
      // remains in samplesRef is exactly the audio whose words never landed —
      // the repair pass replays ONLY that, not the whole session.
      const chunks = samplesRef.current;
      samplesRef.current = [];
      if (commitFailedRef.current && chunks.length > 0) {
        // Some segment commit failed, so words may be missing.
        // Fall back to a transcription of the retained audio to fill the gap —
        // normally (every commit succeeded) this cost is skipped entirely.
        setTranscribing(true);
        const repairT0 = performance.now();
        const wav = encodeWav16k(joinSamples(chunks, rateRef.current));
        const res = await transcribeAudio(await blobToBase64(wav), "audio/wav");
        const text = res?.text ? flattenVoiceText(res.text) : "";
        if (text) {
          // APPEND, not replace: earlier segments' audio was released as they
          // committed, so a full-clip replacement would erase their words.
          voiceCommittedRef.current = voiceCommittedRef.current
            ? `${voiceCommittedRef.current} ${text}`
            : text;
          voicePartialRef.current = "";
          renderVoiceText();
        }
        voiceLog(`[voice] repair pass ${Math.round(performance.now() - repairT0)}ms for ${chunkSeconds(chunks, rateRef.current).toFixed(1)}s audio`);
      }
    } catch {
      toastError(
        "Speech-to-text failed partway — the text already there is kept, but some words may be missing. Check Settings → Local Models → Speech if this keeps happening.",
      );
    } finally {
      setTranscribing(false);
      // Whatever the buffer holds is ordinary text now.
      voiceSpanRef.current = null;
      voiceRenderedRef.current = "";
      voiceCommittedRef.current = "";
      voicePartialRef.current = "";
    }
  }, [flushVoiceSegment, renderVoiceText, stopCapture]);

  const beginVoiceRecording = useCallback(async () => {
    if (recordingRef.current || transcribing) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // getUserMedia fails when: the host (WebView2) hasn't granted mic
      // permission, the device has no mic, or the user denied the prompt.
      // Surface the reason instead of dying silently — this is the #1 cause
      // of "mic doesn't work" reports.
      const name = (e as Error)?.name ?? "Error";
      if (name === "NotAllowedError" || name === "SecurityError") {
        // WebView2 denies mic permission requests silently (wry handles only
        // clipboard); the additionalBrowserArgs media switch in
        // tauri.conf.json is what makes the grant happen. If users still hit
        // this, it's an old build or Windows privacy settings.
        toastError("Microphone access was blocked. Restart the app — if it persists, check Windows → Privacy → Microphone.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        toastError("No microphone found on this device.");
      } else {
        toastError("Could not start microphone.", e);
      }
      return;
    }
    try {
      const ac = new AudioContext({ sampleRate: 16000 });
      // Registered before anything below can throw, so the catch's
      // stopCapture() can close the context even if the graph is half-built.
      captureCtxRef.current = ac;
      rateRef.current = ac.sampleRate;
      const source = ac.createMediaStreamSource(stream);
      const processor = ac.createScriptProcessor(4096, 1, 1);
      const sink = ac.createGain();
      sink.gain.value = 0; // silent sink keeps the graph pulled without echo
      processor.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        samplesRef.current.push(data);
        segmentRef.current.push(data);
        segmentLenRef.current += data.length;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        levelRef.current = levelRef.current * 0.7 + rms * 0.3;
        // Silence-gap detection: ~0.77s of quiet ends a dictation segment,
        // committing its words so they can never vanish when speech continues
        // past the live-partial span.
        if (rms < 0.008) {
          silenceRunRef.current += 1;
          if (
            silenceRunRef.current >= VOICE_SILENCE_CHUNKS &&
            segmentLenRef.current > 0 &&
            segmentHadSoundRef.current
          ) {
            flushVoiceSegment();
          }
        } else {
          silenceRunRef.current = 0;
          segmentHadSoundRef.current = true;
        }
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ac.destination);
      captureNodesRef.current = { source, processor, sink };
      captureStreamRef.current = stream;

      samplesRef.current = [];
      segmentRef.current = [];
      segmentLenRef.current = 0;
      silenceRunRef.current = 0;
      segmentHadSoundRef.current = false;
      levelRef.current = 0;
      voiceFocusAppliedRef.current = false;
      // Fresh session: commits still in flight from the previous one must not
      // land here, and a hung partial from it must not block this one.
      commitArmRef.current += 1;
      commitFailedRef.current = false;
      partialInFlightRef.current = false;
      recordingRef.current = true;
      setRecording(true);

      // Live partials: re-transcribe the un-committed segment every tick and
      // re-render it in place. Each request is tagged with both the recording
      // generation (dropped after stop/cancel/restart) and the segment
      // generation (dropped if a silence flush swapped the segment
      // mid-request — the commit path owns that text instead).
      partialTimerRef.current = window.setInterval(() => {
        const recGen = generationRef.current;
        const segGen = segmentGenRef.current;
        // A segment that never pauses is force-committed at the cap so the
        // next live partial starts small again.
        if (segmentLenRef.current >= SEGMENT_MAX_SECONDS * rateRef.current) {
          flushVoiceSegment();
          return;
        }
        if (segmentLenRef.current === 0) return; // committed text stays put
        // The server transcribes one request at a time, so a second queued
        // partial would only delay the segment commits behind it — skip the
        // tick while one is still out. Stale results were already dropped
        // via the gen checks below.
        if (partialInFlightRef.current) return;
        partialInFlightRef.current = true;
        void (async () => {
          const t0 = performance.now();
          try {
            const segSamples = segmentRef.current.reduce((n, c) => n + c.length, 0);
            const wav = encodeWav16k(joinSamples(segmentRef.current, rateRef.current));
            const res = await transcribeAudio(await blobToBase64(wav), "audio/wav", "partial");
            if (generationRef.current !== recGen || segGen !== segmentGenRef.current) return;
            voicePartialRef.current = res?.text ? flattenVoiceText(res.text) : "";
            renderVoiceText();
            voiceLog(
              `[voice] partial ${Math.round(performance.now() - t0)}ms for ${(segSamples / rateRef.current).toFixed(1)}s audio`,
            );
          } catch {
            voiceLog(`[voice] partial dropped/cancelled after ${Math.round(performance.now() - t0)}ms`);
            // Partials are best-effort — the commit chain owns the real text.
          } finally {
            partialInFlightRef.current = false;
          }
        })();
      }, PARTIAL_TICK_MS);

      // Released while the mic was still opening (first-run permission
      // prompt): stop immediately so a quick tap can't leave a stuck
      // recording running with no key held.
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        void finishVoiceRecording();
      }
    } catch (e) {
      // Tear down whatever half-built graph exists — stopping only the stream
      // tracks could leak the AudioContext/processor wiring created above.
      stopCapture();
      stream.getTracks().forEach((t) => t.stop());
      toastError("Could not initialize audio recorder.", e);
    }
  }, [transcribing, finishVoiceRecording, flushVoiceSegment, renderVoiceText]);

  // Discard the current clip without transcribing — push-to-talk aborted
  // because a real shortcut (Alt+Tab, Alt+arrows, …) joined the hold. The
  // words already written are undone with it.
  const cancelVoiceRecording = useCallback(() => {
    if (!recordingRef.current) return;
    generationRef.current += 1;
    // Disarm in-flight/queued commits too — an aborted take must never insert
    // text later. Stop deliberately skips this: there, commits are the record.
    commitArmRef.current += 1;
    // Free the serial server as well: any commit still running would be
    // dropped by the arm check above, so let it stop early.
    cancelTranscription("commit").catch(() => {});
    stopCapture();
    setRecording(false);
    removeVoiceSpan();
    samplesRef.current = [];
    segmentRef.current = [];
    segmentLenRef.current = 0;
  }, [removeVoiceSpan, stopCapture]);

  const toggleRecording = useCallback(() => {
    if (recordingRef.current) void finishVoiceRecording();
    else void beginVoiceRecording();
  }, [beginVoiceRecording, finishVoiceRecording]);

  // Push-to-talk: HOLD the Alt key to dictate, release to transcribe+insert.
  // Solo Alt only — any other key joining the hold (Alt+Tab, Alt+arrows, …)
  // cancels the dictation so keyboard shortcuts keep working untouched.
  // The mic button still toggles for click users.
  const altTalkRef = useRef(false);
  useEffect(() => {
    if (!pushToTalk) return;
    const owns = () => (isActiveTarget ? isActiveTarget() : true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        if (!owns()) return;
        // Ignore AltGr (reports as Ctrl+Alt on intl layouts) and shortcuts
        // already in flight — only a solo Alt press starts dictation.
        if (e.ctrlKey || e.metaKey || e.repeat) return;
        // Suppress the default: an Alt release otherwise toggles Win32 menu
        // mode, whose modal loop stalls the whole WebView2 transport —
        // dictation results sat 10-30s undelivered until the next click
        // dismissed the menu mode (the "app freezes, click fixes it" bug).
        e.preventDefault();
        if (recordingRef.current || transcribing) return;
        altTalkRef.current = true;
        void beginVoiceRecording();
        return;
      }
      if (altTalkRef.current && e.altKey) {
        // A shortcut joined the hold — abort without transcribing.
        altTalkRef.current = false;
        cancelVoiceRecording();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Alt" || !altTalkRef.current) return;
      // See onKeyDown: the release must not reach the default menu-mode toggle.
      e.preventDefault();
      altTalkRef.current = false;
      if (recordingRef.current) {
        void finishVoiceRecording();
      } else {
        // Mic still opening (first-run permission prompt) — stop the moment
        // it does, so a quick tap doesn't leave a stuck recording.
        pendingStopRef.current = true;
      }
    };
    const onBlur = () => {
      if (altTalkRef.current && recordingRef.current) {
        altTalkRef.current = false;
        cancelVoiceRecording();
      }
      altTalkRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [pushToTalk, isActiveTarget, transcribing, beginVoiceRecording, finishVoiceRecording, cancelVoiceRecording]);

  return { recording, transcribing, waveBarsRef, toggleRecording, cancelRecording: cancelVoiceRecording };
}
