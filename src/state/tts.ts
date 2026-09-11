// Read-aloud playback state. Kept as a store (not component state) because two
// places drive it — the action bar on a message and the artifact pane's
// toolbar — and every play button in the transcript needs to know whether IT is
// the one currently speaking (to render Stop instead of Play).
import { create } from "zustand";

/** `buffering` is a read parked on the voice engine *between* sentences, after
 *  playback has started. Distinct from `loading` (nothing has played yet)
 *  because the transport stays live, and distinct from `playing` because the
 *  bar must not claim to be speaking through a silence it can explain. */
export type TtsPhase = "idle" | "loading" | "buffering" | "playing" | "paused";

export interface TtsPlaybackState {
  /** Identity of whatever is being read (`msg:<id>`, `artifact:<path>`, …).
   *  Null when nothing is loaded. */
  key: string | null;
  /** Short human label for the player bar ("Answer", "report.md"). */
  label: string | null;
  /** 1-based position of the sentence being spoken (0 when not playing). */
  index: number;
  /** Total sentences in the current text. */
  total: number;
  phase: TtsPhase;
  /** Last failure, surfaced inline instead of as a toast — a read-aloud
   *  failure is never important enough to interrupt with a popup. */
  error: string | null;
  /** Mirrors the persisted `tts.autoRead` setting. Kept in the store so a turn
   *  finishing can act on it without an IPC round-trip per turn. */
  autoRead: boolean;
  set: (patch: Partial<Omit<TtsPlaybackState, "set">>) => void;
}

export const useTtsStore = create<TtsPlaybackState>((set) => ({
  key: null,
  label: null,
  index: 0,
  total: 0,
  phase: "idle",
  error: null,
  autoRead: false,
  set: (patch) => set(patch),
}));

/** True when `key` is the thing currently loaded in the player. */
export function isSpeakingKey(state: TtsPlaybackState, key: string | null | undefined): boolean {
  return !!key && state.key === key && state.phase !== "idle";
}
