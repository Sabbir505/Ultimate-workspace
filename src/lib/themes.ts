// Custom theme import/export (roadmap #19). A custom theme is an *override
// map*: `colors` names CSS tokens from tokens.css (without the `--` prefix)
// and layers them on top of the resolved built-in light/dark palette via
// inline custom properties on <html>. Tokens absent from the map fall back
// to the built-in theme; an optional `base` forces the underlying scope.

export interface CustomTheme {
  id: string;
  name: string;
  /** Force the underlying light/dark scope (default: follow the current mode). */
  base?: "light" | "dark";
  /** Token name (no `--` prefix) -> color value. */
  colors: Record<string, string>;
}

// The full token surface a theme may override — the `:root[data-theme]`
// scopes in tokens.css (89 color tokens each) plus the neutral pane-state
// colors. Structural tokens (fonts, radii, shadows, easing) are deliberately
// excluded: a theme restyles colors, not geometry. Values are whitelisted
// here so an imported file can't inject arbitrary custom properties.
export const KNOWN_THEME_TOKENS: ReadonlySet<string> = new Set([
  // Core identity
  "bg-tint", "surface", "surface-2", "surface-solid", "surface-glass",
  "surface-glass-2", "surface-1", "surface-3", "bg-elevated", "glass-hover",
  "border", "border-strong", "glass-rim", "glass-rim-soft", "doc-fold-light",
  "doc-fold-dark", "text", "text-dim", "accent", "accent-soft", "accent-glow",
  "accent-contrast", "danger", "shadow", "diff-add-bg", "diff-del-bg",
  "diff-hunk-bg",
  // Pane state (neutral, from :root)
  "state-idle", "state-working", "state-waiting", "state-diff",
  // Editor
  "editor-bg", "editor-fg", "editor-line-highlight", "editor-selection",
  "editor-cursor", "editor-whitespace", "editor-indent-guide",
  "editor-bracket-match",
  // Sidebar
  "sidebar-bg", "sidebar-fg", "sidebar-border", "sidebar-hover-bg",
  "sidebar-active-bg",
  // Activity bar
  "activity-bar-bg", "activity-bar-fg", "activity-bar-active-fg",
  "activity-bar-badge-bg", "activity-bar-badge-fg",
  // Status bar
  "status-bar-bg", "status-bar-fg", "status-bar-debug-bg",
  // Tabs
  "tab-bg", "tab-active-bg", "tab-fg", "tab-active-fg", "tab-border",
  // Titlebar
  "titlebar-bg", "titlebar-fg", "titlebar-inactive-fg",
  // Inputs
  "input-bg", "input-fg", "input-border", "input-placeholder",
  "input-focus-border",
  // Buttons
  "button-bg", "button-hover-bg", "button-fg", "button-primary-bg",
  "button-primary-fg",
  // Scrollbar
  "scrollbar-thumb", "scrollbar-thumb-hover", "scrollbar-track",
  // Tooltip
  "tooltip-bg", "tooltip-fg", "tooltip-border",
  // Syntax
  "syntax-comment", "syntax-string", "syntax-keyword", "syntax-function",
  "syntax-type", "syntax-variable", "syntax-number", "syntax-operator",
  "syntax-tag", "syntax-attr-name", "syntax-attr-value", "syntax-punctuation",
  "syntax-regex", "syntax-builtin", "syntax-deleted", "syntax-inserted",
  "syntax-changed",
  // Diagram palette (Mermaid + generated diagram art)
  "diagram-accent", "diagram-accent-contrast", "diagram-node-fill",
  "diagram-node-border", "diagram-line", "diagram-cluster-fill",
  "diagram-cluster-border",
]);

/** Core identity tokens shown in the import hint (label = what it colors). */
export const CORE_THEME_TOKENS: { token: string; label: string }[] = [
  { token: "bg-tint", label: "window bg" },
  { token: "surface", label: "surface" },
  { token: "text", label: "text" },
  { token: "text-dim", label: "muted text" },
  { token: "border", label: "borders" },
  { token: "accent", label: "accent" },
  { token: "accent-soft", label: "accent tint" },
  { token: "button-primary-bg", label: "primary button" },
  { token: "input-focus-border", label: "focus ring" },
  { token: "danger", label: "danger" },
  { token: "diff-add-bg", label: "diff add" },
  { token: "diff-del-bg", label: "diff del" },
];

export type ParseThemeResult =
  | { ok: true; theme: CustomTheme }
  | { ok: false; errors: string[] };

/** Parse + validate a theme JSON file. Unknown token keys are dropped
 *  against KNOWN_THEME_TOKENS (CSS-injection guard); every retained key must
 *  have a non-empty string value. Returns a fresh id so re-importing a file
 *  never collides with an existing theme. */
export function parseThemeJson(raw: string): ParseThemeResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["File is not valid JSON."] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      errors: ['Theme must be a JSON object with a "name" string and a "colors" map.'],
    };
  }
  const obj = data as Record<string, unknown>;
  const errors: string[] = [];

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) errors.push('Missing required "name" (string).');

  const colorsRaw = obj.colors;
  if (!colorsRaw || typeof colorsRaw !== "object" || Array.isArray(colorsRaw)) {
    errors.push('Missing required "colors" object mapping token names to color values.');
    return { ok: false, errors };
  }

  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(colorsRaw)) {
    if (!KNOWN_THEME_TOKENS.has(key)) continue; // unknown keys dropped
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`Token "${key}" has no value.`);
      continue;
    }
    colors[key] = value.trim();
  }
  if (Object.keys(colors).length === 0) {
    errors.push('"colors" must set at least one known token.');
  }

  let base: "light" | "dark" | undefined;
  if (obj.base !== undefined && obj.base !== null) {
    if (obj.base === "light" || obj.base === "dark") base = obj.base;
    else errors.push('"base" must be "light" or "dark" (or omitted).');
  }

  if (errors.length > 0) return { ok: false, errors };

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    ok: true,
    theme: {
      id: `theme-${slug || "custom"}-${Date.now().toString(36)}`,
      name,
      base,
      colors,
    },
  };
}

/** Serialize a theme back to importable JSON (name, optional base, colors). */
export function themeJson(theme: CustomTheme): string {
  return JSON.stringify(
    {
      name: theme.name,
      ...(theme.base ? { base: theme.base } : {}),
      colors: theme.colors,
    },
    null,
    2,
  );
}

/** Parse a stored `themes.custom` blob, dropping malformed entries. */
export function parseThemeList(raw: string | null): CustomTheme[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is CustomTheme =>
        !!t &&
        typeof t === "object" &&
        typeof (t as CustomTheme).id === "string" &&
        typeof (t as CustomTheme).name === "string" &&
        typeof (t as CustomTheme).colors === "object" &&
        (t as CustomTheme).colors !== null &&
        ((t as CustomTheme).base === undefined ||
          (t as CustomTheme).base === "light" ||
          (t as CustomTheme).base === "dark"),
    );
  } catch {
    return [];
  }
}

/** The four swatch colors shown on a gallery card, with built-in-palette
 *  fallbacks so cards still read when a theme overrides only some tokens. */
export function themeSwatchColors(theme: CustomTheme): {
  bg: string;
  surface: string;
  text: string;
  accent: string;
} {
  return {
    bg: theme.colors["bg-tint"] ?? "#181818",
    surface: theme.colors["surface"] ?? "#1a1a1a",
    text: theme.colors["text"] ?? "#e4e4e4",
    accent:
      theme.colors["accent"] ?? theme.colors["button-primary-bg"] ?? "#88C0D0",
  };
}
