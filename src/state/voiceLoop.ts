// Voice loop store — the hands-free conversation mode's shared state.
//
// The loop itself is wired in hooks/useVoiceLoop.tsx (one controller mounted
// at the app root); this store is what the UI reads: the mic mode, where the
// loop currently sits (listening / sending / waiting / speaking), the live
// transcript while listening, and the mic level for the bars. The turn-
// complete notification rides a tiny module-level listener here rather than
// an event bus: useTtsAutoRead (called after every persisted turn) needs to
// tell the loop a response landed, and importing the hook the other way
// round would be a cycle.
import { create } from "zustand";
import { getSetting, setSetting } from "../lib/ipc";

export type VoiceMode = "off" | "handsfree";
export type VoiceLoopPhase = "idle" | "listening" | "sending" | "waiting" | "speaking";

/** Persisted under app_settings. "handsfree" implies read-aloud of answers
 *  (the loop listens again when playback ends) and arms barge-in. */
const K_MODE = "voice.mode";

export interface VoiceLoopStore {
  mode: VoiceMode;
  phase: VoiceLoopPhase;
  /** Live transcript of the utterance being captured (committed segments +
   *  partial). Written through the dictation engine's virtual target. */
  transcript: string;
  /** Mic level 0..1 for the bar's meters (fed from the capture's RMS EMA). */
  level: number;
  error: string | null;
  set: (patch: Partial<Omit<VoiceLoopStore, "set" | "setMode" | "load">>) => void;
  setMode: (mode: VoiceMode) => void;
  /** Load the persisted mode once per app run. */
  load: () => Promise<void>;
}

export const useVoiceLoopStore = create<VoiceLoopStore>((set) => ({
  mode: "off",
  phase: "idle",
  transcript: "",
  level: 0,
  error: null,
  set: (patch) => set(patch),
  setMode: (mode) => {
    set({ mode, error: null });
    // Off always tears the loop down (the controller watches mode); persist
    // fire-and-forget — a failed write costs one reverted toggle next boot.
    void setSetting(K_MODE, mode).catch(() => {});
  },
  load: async () => {
    try {
      const stored = await getSetting(K_MODE);
      if (stored === "handsfree") {
        // Deliberately NOT re-armed: restoring a lit toggle over a loop that
        // isn't running (the mic must never open without a click) reads as a
        // dead button. Hands-free is per-run; the toggle's click re-arms it.
        void setSetting(K_MODE, "off").catch(() => {});
      }
    } catch {
      /* no backend (tests / browser dev) — mode stays off */
    }
  },
}));

// ---- Turn-complete notification (module-level, no cycles) ----

type TurnCompleteListener = (chatSessionId: string) => void;
let turnCompleteListener: TurnCompleteListener | null = null;

/** The loop registers one listener; the last registration wins (there is
 *  exactly one controller). */
export function onVoiceTurnComplete(fn: TurnCompleteListener): void {
  turnCompleteListener = fn;
}

/** Fired by useTtsAutoRead after a persisted turn — voice mode or not — so
 *  the loop knows its sent message got its answer. */
export function notifyVoiceTurnComplete(chatSessionId: string): void {
  turnCompleteListener?.(chatSessionId);
}

// ---- Start / stop requests from UI surfaces ----
//
// The composer's hands-free toggle and the loop bar's stop button live in
// different components from the controller that owns the mic; these module
// listeners let them poke the controller without prop drilling through App.

type LoopRequestListener = () => void;
let startListener: LoopRequestListener | null = null;
let stopListener: LoopRequestListener | null = null;

/** The controller registers these; last registration wins (one controller). */
export function onVoiceLoopStartRequest(fn: LoopRequestListener): void {
  startListener = fn;
}
export function onVoiceLoopStopRequest(fn: LoopRequestListener): void {
  stopListener = fn;
}
/** Composer hands-free toggle turning ON — begin listening now. */
export function requestVoiceLoopStart(): void {
  startListener?.();
}
/** Loop bar's stop button — end the current loop episode and go idle. */
export function requestVoiceLoopStop(): void {
  stopListener?.();
}
