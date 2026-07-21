// Keybinding map parsing & matching (PRD §7.6).
// Accelerator format: "Mod+Shift+K" where Mod = Cmd (metaKey) on macOS and
// Ctrl elsewhere; we accept EITHER metaKey or ctrlKey for Mod so the same map
// works on both platforms (PRD: "implement with Meta OR Ctrl").

export type KeybindingAction =
  | "openPalette"
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
  | "spotlightPrev";

export type KeybindingMap = Record<KeybindingAction, string>;

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  openPalette: "Mod+K",
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
