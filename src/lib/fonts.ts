// Font options for Settings → Appearance. Each entry pairs a stable setting
// id with a full CSS stack: the web font first (loaded via the Google Fonts
// link in index.html), then local/system fallbacks so the UI stays readable
// offline. "Editorial" prefers a locally installed Editorial New (commercial)
// and falls back to Fraunces, its free Google Fonts counterpart.

export interface FontOption {
  id: string;
  label: string;
  stack: string;
}

export const UI_FONT_OPTIONS: FontOption[] = [
  {
    id: "space-grotesk",
    label: "Space Grotesk",
    stack: `"Space Grotesk", -apple-system, "Segoe UI", system-ui, sans-serif`,
  },
  {
    id: "inter",
    label: "Inter",
    stack: `"Inter", -apple-system, "Segoe UI", system-ui, sans-serif`,
  },
  {
    id: "ibm-plex-sans",
    label: "IBM Plex Sans",
    stack: `"IBM Plex Sans", -apple-system, "Segoe UI", system-ui, sans-serif`,
  },
  {
    id: "roboto",
    label: "Roboto",
    stack: `"Roboto", -apple-system, "Segoe UI", system-ui, sans-serif`,
  },
  {
    id: "editorial",
    label: "Editorial",
    stack: `"Editorial New", "Fraunces", Georgia, "Times New Roman", serif`,
  },
  {
    id: "system",
    label: "System default",
    stack: `-apple-system, "Segoe UI", system-ui, sans-serif`,
  },
];

export const MONO_FONT_OPTIONS: FontOption[] = [
  {
    id: "space-mono",
    label: "Space Mono",
    stack: `"Space Mono", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`,
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    stack: `"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace`,
  },
  {
    id: "fira-code",
    label: "Fira Code",
    stack: `"Fira Code", ui-monospace, Consolas, monospace`,
  },
  {
    id: "cascadia-code",
    label: "Cascadia Code",
    stack: `"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace`,
  },
  {
    id: "system-mono",
    label: "System default",
    stack: `ui-monospace, "Cascadia Mono", Consolas, monospace`,
  },
];

export const DEFAULT_UI_FONT = "space-grotesk";
export const DEFAULT_MONO_FONT = "space-mono";

export function fontStackFor(options: FontOption[], id: string): string {
  return options.find((o) => o.id === id)?.stack ?? options[0].stack;
}

/** Resolved CSS stack for a saved UI font id. */
export const uiFontStack = (id: string): string => fontStackFor(UI_FONT_OPTIONS, id);
/** Resolved CSS stack for a saved mono font id. */
export const monoFontStack = (id: string): string => fontStackFor(MONO_FONT_OPTIONS, id);
