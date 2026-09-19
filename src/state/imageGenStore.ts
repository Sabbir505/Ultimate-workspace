// Live local-image-generation state for the chat UI: one app-wide listener
// feeds every chat pane. While a render is in flight the composer locks
// (a generation behaves like a streaming turn — the next message waits for
// it, and sending/cancelling abandons it), the finished image shows in the
// message flow of the pane that owns it, and finished renders are kept per
// session so their previews survive app restarts (paths live in
// localStorage; the PNG files live in generated-images/). Backend contract:
// src-tauri/src/commands/image_gen.rs (emit_update → `image-gen:update`).
import { create } from "zustand";
import { onImageGenUpdate, type ImageGenUpdate } from "../lib/ipc";
import { useArtifactsStore } from "./artifacts";

export interface ImageGenHistoryEntry {
  sessionId: string;
  path: string;
  width: number;
  height: number;
}

const HISTORY_KEY = "imageGen.history";
const HISTORY_MAX = 12;

function loadHistory(): ImageGenHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as ImageGenHistoryEntry[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function persistHistory(history: ImageGenHistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_MAX)));
  } catch {
    /* quota/privacy mode — previews just won't survive restarts */
  }
}

interface ImageGenState {
  /** Latest lifecycle event (starting/rendering/done/error). */
  update: ImageGenUpdate | null;
  /** True while a render is in flight — locks the composer like a stream. */
  busy: boolean;
  /** User cancelled: swallow in-flight completion events until the next
   *  generation starts (the diffusion server has no cancellation, so the
   *  current pass finishes silently and its file simply lands unused). */
  suppressed: boolean;
  /** Bumped at every generation boundary — the chat timeline keys the live
   *  card row with it, so a new generation remounts the card (fresh elapsed
   *  timer) instead of inheriting the previous one's. */
  genId: number;
  /** Session the current generation belongs to — set from the event's
   *  `owner` when the backend tags it (chat tool path), else claimed by the
   *  first pane that sees the generation's first event. Scopes the preview
   *  card so a NEW chat never shows another session's image. */
  anchorSessionId: string | null;
  /** Owner armed before the next generation's first event (panel try-it). */
  pendingOwner: string | null;
  /** Finished renders, newest last, persisted across restarts. */
  history: ImageGenHistoryEntry[];
  /** Claim the pane/session an (ownerless) generation belongs to. */
  attachSession: (sessionId: string) => void;
  /** Pre-claim the NEXT generation for a non-chat owner (the Images panel's
   *  try-it runs get a sentinel id so they never surface in a chat flow). */
  arm: (owner: string) => void;
  /** Drop a pending pre-claim (the armed generation failed before its first
   *  event) — without this the sentinel would swallow the next CHAT render. */
  disarm: () => void;
  apply: (u: ImageGenUpdate) => void;
  cancel: () => void;
}

/** Owner sentinel for generations started outside any chat (Images panel
 *  try-it) — never equals a real session id, so no chat pane renders it. */
export const IMAGE_GEN_PANEL_OWNER = "__images_panel__";

export const useImageGenStore = create<ImageGenState>((set, get) => ({
  update: null,
  busy: false,
  suppressed: false,
  genId: 0,
  anchorSessionId: null,
  pendingOwner: null as string | null,
  history: loadHistory(),
  attachSession: (sessionId) => {
    if (get().anchorSessionId == null) set({ anchorSessionId: sessionId });
  },
  arm: (owner) => set({ pendingOwner: owner }),
  disarm: () => set({ pendingOwner: null }),
  apply: (u) => {
    // A new generation begins at its FIRST event ("starting" — emitted by the
    // chat tool AND the direct command, but only once the backend gate is
    // held, so it can never arrive mid-render of another generation).
    // Re-claim ownership per generation: the previous generation's session
    // must not swallow this one, and a user-cancelled run must stop
    // suppressing events. The event's `owner` (chat tool path) wins over the
    // panel's pre-armed sentinel; ownerless events (relay/bridge renders)
    // still fall back to first-pane-claims.
    const prev = get().update;
    const newGen =
      u.phase === "starting" ||
      (u.phase === "rendering" &&
        (prev == null || prev.phase === "done" || prev.phase === "error"));
    // A cancelled generation's late events stay swallowed until a new one
    // starts — the user moved on; don't pop a stale preview on them.
    if (!newGen && get().suppressed) return;
    set({
      update: u,
      busy: u.phase === "starting" || u.phase === "rendering",
      ...(newGen
        ? {
            suppressed: false,
            genId: get().genId + 1,
            anchorSessionId: u.owner ?? get().pendingOwner ?? null,
            pendingOwner: null,
          }
        : {}),
    });
    if (u.phase === "done" && u.path) {
      const sessionId = get().anchorSessionId ?? "";
      const history = [
        ...get().history.filter((h) => h.path !== u.path),
        { sessionId, path: u.path, width: u.width ?? 0, height: u.height ?? 0 },
      ].slice(-HISTORY_MAX);
      persistHistory(history);
      set({ history });
      // The sidecar wrote the PNG and inserted the artifacts row while the
      // chat sidebar's store was already loaded — re-fetch so the new image
      // shows in the gallery without a restart.
      void useArtifactsStore.getState().load().catch(() => {});
    }
  },
  // "Cancel" is abandon-and-suppress (sd-server has no cancellation): the
  // render keeps running and its late step events must stay swallowed.
  // KEEPING `update` is what makes that hold — the next step event then sees
  // prev === "rendering" and is NOT a new generation, so `suppressed` sticks
  // and the abandoned render's finished image never pops into the chat.
  // ChatView hides the live row while suppressed && !busy, so the card still
  // disappears the moment this fires.
  cancel: () => set({ busy: false, suppressed: true }),
}));

// One app-wide listener (module singleton — every pane's card reads the same
// store). sd-server has no cancellation API, so "cancel" is abandon-and-
// suppress: the current pass finishes silently, nothing queues behind it.
void onImageGenUpdate((u) => useImageGenStore.getState().apply(u)).catch((e) =>
  console.error("image-gen listener failed", e),
);
