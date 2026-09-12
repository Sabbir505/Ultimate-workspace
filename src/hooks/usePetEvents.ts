// Pet event wiring — bridges real app state into the pet's mood machine.
// Everything here reads signals that already exist: the chat store's
// streaming map, the panes store's per-pane working state, automation run
// events, the notification center, and plain user-presence listeners. No new
// backend surface.
import { useCallback, useEffect, useRef } from "react";

import { listenAutomationRunFinished } from "../lib/ipc";
import { isFailureStatus } from "../components/automations/shared";
import { petLine } from "../lib/pets/lines";
import { useChatStore } from "../state/chat";
import { useNotificationsStore } from "../state/notifications";
import { usePanesStore } from "../state/panes";
import { installPetDebugHook, setPetReducedMotion, usePetStore } from "../state/pet";
import { useEventSubscription } from "./useTauriEvent";

const STREAM_REFRESH_MS = 2000; // below the watching cooldown (2.5s)
const WORK_REFRESH_MS = 2500; // below the working cooldown (3s)
const ACTIVITY_THROTTLE_MS = 30_000;

/** Keep a mood alive while its source stays active: emit an event now, then
 *  every `ms` until the caller's effect re-runs or cleans up. */
function useRefreshSignal(active: boolean, emit: () => void, ms: number): void {
  useEffect(() => {
    if (!active) return;
    emit();
    const id = window.setInterval(emit, ms);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ms]);
}

export function usePetEvents(): void {
  const pet = useCallback(() => usePetStore.getState(), []);

  // ── Built-in chat streaming → watching ────────────────────────────────
  // The sidebar lights rows from this same map; the pet watches whenever ANY
  // session streams (background chats count — the agent is still working).
  // A fresh stream also pulls the pet to the composer home so it can watch
  // from there (teleport animation plays).
  const streamingCount = useChatStore(useCallback((s) => Object.keys(s.streaming).length, []));
  const prevStreaming = useRef(0);
  useEffect(() => {
    if (streamingCount > 0 && prevStreaming.current === 0) {
      usePetStore.getState().teleportTo("composer");
    }
    prevStreaming.current = streamingCount;
  }, [streamingCount]);
  useRefreshSignal(streamingCount > 0, () => pet().event({ type: "chatToken" }), STREAM_REFRESH_MS);

  // ── Agent panes working → working ─────────────────────────────────────
  const anyPaneWorking = usePanesStore(
    useCallback((s) => s.panes.some((p) => p.state === "working"), []),
  );
  useRefreshSignal(anyPaneWorking, () => pet().event({ type: "agentOutput" }), WORK_REFRESH_MS);

  // ── Automation run results (exact statuses straight from the emitter) ──
  useEventSubscription(
    listenAutomationRunFinished,
    (p) => {
      if (p.status === "ok") pet().event({ type: "celebrate", source: "automation" });
      else if (isFailureStatus(p.status)) {
        pet().event({ type: "concerned", source: "error" });
      } else {
        // skipped / stopped / running — a sign of life, not a mood
        pet().event({ type: "activity" });
      }
    },
    [],
  );

  // ── Notification center: turn completions, errors, crashes ────────────
  // The bell store is the normalized event log; watch its head for the kinds
  // the automation listener above doesn't already cover.
  const lastNotifId = useRef<string | null>(null);
  useEffect(() => {
    // Seed with the current head so restart-time history doesn't replay.
    lastNotifId.current = useNotificationsStore.getState().items[0]?.id ?? null;
    return useNotificationsStore.subscribe((s) => {
      const first = s.items[0];
      if (!first || first.id === lastNotifId.current) return;
      lastNotifId.current = first.id;
      if (first.kind === "completed") pet().event({ type: "celebrate", source: "turn" });
      else if (first.kind === "error" || first.kind === "crash") {
        pet().event({ type: "concerned", source: first.kind === "crash" ? "crash" : "error" });
      } else {
        pet().event({ type: "activity" });
      }
    });
  }, [pet]);

  // ── User presence: real input wakes and keeps the pet out of doze ─────
  useEffect(() => {
    let lastActivity = 0;
    const onActivity = () => {
      if (Date.now() - lastActivity < ACTIVITY_THROTTLE_MS) return;
      lastActivity = Date.now();
      usePetStore.getState().event({ type: "activity" });
    };
    const onVisible = () => {
      if (!document.hidden) usePetStore.getState().event({ type: "wake" });
    };
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ── Reduced motion: poses still change, strolls don't happen ──────────
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return; // environments without matchMedia
    }
    setPetReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setPetReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // ── App-open greeting: "while you were away" if long absence + news,
  //    otherwise a simple species hello ──────────────────────────────────
  useEffect(() => {
    const t = window.setTimeout(() => {
      const s = usePetStore.getState();
      const unseen = useNotificationsStore.getState().items.some((n) => n.unseen);
      const line = s.morningReport(unseen);
      if (!line) {
        const greet = petLine(s.species, "greet", s.name);
        if (greet) s.showBubble(greet);
      }
    }, 1600);
    return () => window.clearTimeout(t);
  }, []);

  // ── DEV console hook: __pet.celebrate() / work() / concern() / debug() ─
  useEffect(() => {
    installPetDebugHook();
  }, []);
}
