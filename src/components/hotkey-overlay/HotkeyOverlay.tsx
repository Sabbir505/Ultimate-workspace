// Keyboard-shortcuts cheatsheet. Opens with Mod+/ (toggleHotkeyOverlay)
// or from the command palette — the discoverability surface for every global
// binding, since the app deliberately registers most of them invisibly.
//
// Rows are grouped by surface (general / chat panes / vault) and read the
// LIVE keybindings map from the settings store, so user overrides show up
// here too. Same overlay/glass conventions as the command palette; occlusion
// is registered so native browser panes hide beneath it.
import { useEffect } from "react";
import { useOcclusion } from "../../hooks/useOcclusion";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

/** "Mod+Shift+K" → "⌘⇧K" (macOS) / "Ctrl+Shift+K" (Windows/Linux). */
function formatAccelerator(accel: string): string {
  const parts = accel
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const out = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === "mod") return IS_MAC ? "⌘" : "Ctrl";
    if (lower === "shift") return IS_MAC ? "⇧" : "Shift";
    if (lower === "alt" || lower === "option") return IS_MAC ? "⌥" : "Alt";
    if (lower === "space" || lower === "spacebar") return "Space";
    if (lower === "escape") return "Esc";
    if (lower === "backquote") return "`";
    return part.length === 1 ? part.toUpperCase() : part;
  });
  return out.join(IS_MAC ? "" : "+");
}

interface HotkeyRow {
  label: string;
  /** Keys from the LIVE map; empty string = no binding (row hidden). */
  keys: (keybindings: Record<string, string>) => string;
}

interface HotkeyGroup {
  title: string;
  rows: HotkeyRow[];
}

const GROUPS: HotkeyGroup[] = [
  {
    title: "General",
    rows: [
      { label: "Command palette", keys: (k) => k.openPalette ?? "" },
      { label: "Keyboard shortcuts (this overlay)", keys: (k) => k.toggleHotkeyOverlay ?? "" },
      { label: "New session", keys: (k) => k.newSession ?? "" },
      { label: "Open settings", keys: (k) => k.openSettings ?? "" },
      { label: "Toggle broadcast", keys: (k) => k.toggleBroadcast ?? "" },
    ],
  },
  {
    title: "Chat panes",
    rows: [
      // Six per-pane bindings rendered as one row — the pattern, not six
      // near-identical lines.
      { label: "Focus chat pane 1…6", keys: (k) => k.focusPane1 ?? "" },
      { label: "Cycle chat panes", keys: (k) => k.cyclePane ?? "" },
      { label: "Close focused pane", keys: (k) => k.closePane ?? "" },
      { label: "Next terminal spotlight", keys: (k) => k.spotlightNext ?? "" },
      { label: "Previous terminal spotlight", keys: (k) => k.spotlightPrev ?? "" },
    ],
  },
  {
    title: "Vault",
    rows: [
      { label: "Toggle edit / preview", keys: (k) => k.vaultModeToggle ?? "" },
      { label: "Quick switcher", keys: (k) => k.vaultQuickSwitcher ?? "" },
      { label: "New note", keys: (k) => k.vaultNewNote ?? "" },
      { label: "Search notes", keys: (k) => k.vaultSearch ?? "" },
      { label: "Graph view", keys: (k) => k.vaultGraph ?? "" },
      { label: "Today's daily note", keys: (k) => k.vaultDailyNote ?? "" },
      { label: "Insert template", keys: (k) => k.vaultInsertTemplate ?? "" },
      { label: "Save note", keys: (k) => k.vaultSaveNote ?? "" },
      { label: "Read note aloud", keys: (k) => k.vaultReadAloud ?? "" },
      { label: "Dictate into note", keys: (k) => k.vaultDictate ?? "" },
    ],
  },
];

export function HotkeyOverlay() {
  const open = useUiStore((s) => s.hotkeyOverlayOpen);
  const setOpen = useUiStore((s) => s.setHotkeyOverlayOpen);
  const keybindings = useSettingsStore((s) => s.keybindings);

  useOcclusion("app:hotkey-overlay", open);

  // Escape closes (capture, like Modal.tsx — contenteditable and inputs must
  // not swallow it). Mod+/ closes too: the keybinding loop's toggle
  // fires through, so no extra handling is needed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  const toggleKeys = keybindings.toggleHotkeyOverlay ?? "";

  return (
    <div
      className="hotkey-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="hotkey-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header className="hotkey-head">
          <h3>Keyboard shortcuts</h3>
          {toggleKeys ? (
            <span className="hotkey-head-hint">
              Press <kbd>{formatAccelerator(toggleKeys)}</kbd> or Esc to close
            </span>
          ) : (
            <span className="hotkey-head-hint">Press Esc to close</span>
          )}
        </header>
        <div className="hotkey-columns">
          {GROUPS.map((group) => {
            const rows = group.rows
              .map((row) => ({ label: row.label, keys: row.keys(keybindings) }))
              .filter((row) => row.keys !== "");
            if (rows.length === 0) return null;
            return (
              <section key={group.title} className="hotkey-group">
                <h4>{group.title}</h4>
                {rows.map((row) => (
                  <div key={row.label} className="hotkey-row">
                    <span className="hotkey-row-label">{row.label}</span>
                    <kbd>{formatAccelerator(row.keys)}</kbd>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
