// Global keyboard shortcuts (§7.6). The keybinding map comes from the settings
// store (remappable in Settings); this hook just registers listeners from it.
import { useEffect } from "react";
import { matchesAccelerator, type KeybindingAction } from "../lib/keybindings";
import { defaultHarness, newSessionFlow } from "../lib/sessionLauncher";
import { activeTerminalPair, cycleTerminalPair, usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";
import { useSettingsStore } from "../state/settings";
import { useUiStore } from "../state/ui";

export function useKeybindings(): void {
  const keybindings = useSettingsStore((s) => s.keybindings);

  // Chat text zoom (Ctrl/Cmd + or - to scale, Ctrl/Cmd 0 to reset). Runs on
  // its own listener BEFORE the editable-target gate so the combos also work
  // while typing in the composer, and preventDefaults so the webview's native
  // page zoom never double-fires.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      let next: number | null = null;
      if (e.key === "=" || e.key === "+") {
        next = useSettingsStore.getState().chatZoom + 0.1;
      } else if (e.key === "-" || e.key === "_") {
        next = useSettingsStore.getState().chatZoom - 0.1;
      } else if (e.key === "0") {
        next = 1;
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      useSettingsStore.getState().setChatZoom(next);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire global shortcuts while typing in inputs/textareas, except
      // for the palette toggle and pane shortcuts which are expected to work
      // from inside terminals too (xterm renders into a textarea helper).
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA") &&
        !target.classList.contains("xterm-helper-textarea");

      const actions: Array<[KeybindingAction, () => void]> = [
        ["openPalette", () => useUiStore.getState().togglePalette()],
        ["focusPane1", () => usePanesStore.getState().focusPaneByIndex(0)],
        ["focusPane2", () => usePanesStore.getState().focusPaneByIndex(1)],
        ["focusPane3", () => usePanesStore.getState().focusPaneByIndex(2)],
        ["focusPane4", () => usePanesStore.getState().focusPaneByIndex(3)],
        ["focusPane5", () => usePanesStore.getState().focusPaneByIndex(4)],
        ["focusPane6", () => usePanesStore.getState().focusPaneByIndex(5)],
        ["cyclePane", () => usePanesStore.getState().cycleFocus()],
        [
          "newSession",
          () => {
            const projectId = useProjectsStore.getState().selectedProjectId;
            const harness = defaultHarness();
            if (projectId && harness) void newSessionFlow(projectId, harness);
          },
        ],
        [
          "closePane",
          () => {
            const { focusedPaneId, closePane } = usePanesStore.getState();
            if (focusedPaneId) closePane(focusedPaneId);
          },
        ],
        [
          "toggleBroadcast",
          () => {
            const { broadcast, setBroadcastEnabled } = usePanesStore.getState();
            setBroadcastEnabled(!broadcast.enabled);
          },
        ],
        ["openSettings", () => useUiStore.getState().setActiveView("settings")],
        [
          "spotlightNext",
          () => {
            const { panes, spotlightOverride, setSpotlight } = usePanesStore.getState();
            const pair = activeTerminalPair(panes, spotlightOverride);
            const next = cycleTerminalPair(panes, pair, 1);
            if (next[0]) setSpotlight(next[0]);
          },
        ],
        [
          "spotlightPrev",
          () => {
            const { panes, spotlightOverride, setSpotlight } = usePanesStore.getState();
            const pair = activeTerminalPair(panes, spotlightOverride);
            const prev = cycleTerminalPair(panes, pair, -1);
            if (prev[0]) setSpotlight(prev[0]);
          },
        ],
      ];

      for (const [action, run] of actions) {
        if (inEditable && action !== "openPalette") continue;
        const accel = keybindings[action];
        if (accel && matchesAccelerator(accel, e)) {
          // Once one action matches, stop checking — otherwise a second
          // binding whose accelerator ALSO matches (e.g. a custom binding
          // colliding with a default) would double-fire and the first
          // handler's side effects would already be applied.
          e.preventDefault();
          run();
          return;
        }
      }
    };

    // Capture phase: xterm's core keydown handler calls stopPropagation() on
    // its helper-textarea for many key combos (Ctrl+1, Ctrl+W, etc.), which
    // would prevent a bubble-phase window listener from ever seeing them. These
    // shortcuts are documented to fire from inside terminals too, so we must
    // listen on the way DOWN (capture), before xterm can swallow the event.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [keybindings]);
}
