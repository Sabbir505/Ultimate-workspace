// Keybinding map parsing & matching (PRD §7.6).
// Accelerator format: "Mod+Shift+K" where Mod = Cmd (metaKey) on macOS and
// Ctrl elsewhere; we accept EITHER metaKey or ctrlKey for Mod so the same map
// works on both platforms (PRD: "implement with Meta OR Ctrl").

export type KeybindingAction =
  | "openPalette"
  | "toggleHotkeyOverlay"
  | "focusPane1"
  | "focusPane2"
  | "focusPane3"
  | "focusPane4"
  | "focusPane5"
  | "focusPane6"
  | "cyclePane"
  | "newSession"
  | "closePane"
  | "toggleBroadcast"
  | "openSettings"
  | "spotlightNext"
  | "spotlightPrev"
  // Expand/collapse the browser pane over the whole window. F11 is the
  // platform's full-screen key and free across the map — Mod+Shift+F (the
  // "obvious" pick) is already vaultSearch, and Mod+F is the page's own
  // find-in-page once the webview has focus.
  | "browserFullscreen"
  // Vault surface (only fire while activeView === "vault").
  | "vaultModeToggle"
  | "vaultQuickSwitcher"
  | "vaultNewNote"
  | "vaultSearch"
  | "vaultGraph"
  | "vaultDailyNote"
  | "vaultInsertTemplate"
  | "vaultSaveNote"
  | "vaultReadAloud"
  | "vaultDictate";

export type KeybindingMap = Record<KeybindingAction, string>;

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  openPalette: "Mod+K",
  // The shortcuts cheatsheet. Mod+/ is the Slack/Gmail-style "show keyboard
  // shortcuts" slot and is free across the map. Alt is deliberately NOT used:
  // solo Alt is the push-to-talk modifier for voice dictation
  // (voiceDictationCore), and Alt+Space also collides with the Win32 system
  // menu the WebView would otherwise have to suppress.
  toggleHotkeyOverlay: "Mod+/",
  focusPane1: "Mod+1",
  focusPane2: "Mod+2",
  focusPane3: "Mod+3",
  focusPane4: "Mod+4",
  focusPane5: "Mod+5",
  focusPane6: "Mod+6",
  cyclePane: "Mod+`",
  newSession: "Mod+N",
  closePane: "Mod+W",
  toggleBroadcast: "Mod+Shift+B",
  openSettings: "Mod+,",
  spotlightNext: "Mod+Shift+]",
  spotlightPrev: "Mod+Shift+[",
  // Unmodified, like every browser's full-screen key. Only fires while the
  // DOM has focus — a focused native webview swallows its own key events, so
  // this is a chrome-and-chat shortcut, and Escape (handled in BrowserPane,
  // not here) is the way back out.
  browserFullscreen: "F11",
  // Obsidian-flavoured vault defaults. Mod+P is the quick switcher (the
  // browser's print dialog doesn't exist inside Tauri); Mod+E toggles the
  // live/reading note surface like Obsidian's edit/preview toggle.
  vaultModeToggle: "Mod+E",
  vaultQuickSwitcher: "Mod+P",
  vaultNewNote: "Mod+Shift+N",
  vaultSearch: "Mod+Shift+F",
  vaultGraph: "Mod+G",
  vaultDailyNote: "Mod+Shift+D",
  vaultInsertTemplate: "Mod+T",
  // Save must work while typing in the note editor, like the palette.
  vaultSaveNote: "Mod+S",
  // Voice for the active note. Both fire with the editor focused (the note
  // body is a contenteditable div, which the editable-exemption check doesn't
  // match, so every binding is already live there).
  vaultReadAloud: "Mod+Shift+R",
  vaultDictate: "Mod+Shift+V",
};

export interface ParsedAccelerator {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Normalized key name, e.g. "k", "1", "`", ",", "enter", "escape". */
  key: string;
}

/** Parse an accelerator string like "Mod+Shift+B". Throws on empty/invalid. */
export function parseAccelerator(accel: string): ParsedAccelerator {
  const parts = accel
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(`Invalid accelerator: "${accel}"`);

  const parsed: ParsedAccelerator = { mod: false, shift: false, alt: false, key: "" };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod" || lower === "cmd" || lower === "meta" || lower === "ctrl" || lower === "control") {
      parsed.mod = true;
    } else if (lower === "shift") {
      parsed.shift = true;
    } else if (lower === "alt" || lower === "option") {
      parsed.alt = true;
    } else {
      if (parsed.key !== "") throw new Error(`Accelerator has multiple keys: "${accel}"`);
      parsed.key = normalizeKeyName(lower);
    }
  }
  if (parsed.key === "") throw new Error(`Accelerator has no key: "${accel}"`);
  return parsed;
}

function normalizeKeyName(key: string): string {
  const aliases: Record<string, string> = {
    esc: "escape",
    space: " ",
    spacebar: " ",
    del: "delete",
    backquote: "`",
    comma: ",",
  };
  return aliases[key] ?? key;
}

/** Normalize a KeyboardEvent's `key` to our canonical form. */
export function keyFromEvent(e: Pick<KeyboardEvent, "key">): string {
  let key = e.key.toLowerCase();
  if (key === " ") return " ";
  if (key.length === 1) return key;
  return normalizeKeyName(key);
}

/** US-layout shift pairs: Shift+] produces "}", etc. Used as a fallback so
 *  accelerators like Mod+Shift+] match the "}" the event actually reports. */
const UNSHIFTED: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

/** Does this keyboard event match the accelerator? Mod accepts meta OR ctrl. */
export function matchesAccelerator(
  accel: string,
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  let parsed: ParsedAccelerator;
  try {
    parsed = parseAccelerator(accel);
  } catch {
    return false;
  }
  const modPressed = e.metaKey || e.ctrlKey;
  if (parsed.mod !== modPressed) return false;
  // For shifted character keys (e.g. Shift+1 producing "!") the event key is
  // the shifted glyph; we compare against the base key and require shift.
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;
  const key = keyFromEvent(e);
  if (key === parsed.key) return true;
  // Shifted-symbol fallback: "}" should match a "]" binding (and vice versa).
  if (e.shiftKey && UNSHIFTED[key] === parsed.key) return true;
  return false;
}

/** Serialize a KeyboardEvent (from a settings "press keys" recorder) into an accelerator string. */
export function acceleratorFromEvent(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): string | null {
  const key = keyFromEvent(e);
  // Ignore presses of pure modifiers.
  if (["meta", "control", "shift", "alt"].includes(key)) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}
