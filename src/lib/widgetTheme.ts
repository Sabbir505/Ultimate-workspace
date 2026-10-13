// Theme bridge for in-app visualization widgets (WidgetFrame): maps Relay's
// resolved theme (tokens.css scopes + custom-theme inline overrides, all read
// live from getComputedStyle) onto the CSS custom properties a widget styles
// against, per the `render_widget` tool contract. The same map rides the MCP
// Apps hostContext (`styles.variables`) so the bridge stays spec-shaped.

export interface WidgetTheme {
  appearance: "light" | "dark";
  /** CSS custom property name (with `--`) -> resolved color. */
  variables: Record<string, string>;
}

/** Categorical chart series after the theme accent — fixed hues so a series
 *  keeps its identity across themes (matches the diagram palette approach). */
const CHART_SERIES = [
  "#0d9488",
  "#d97706",
  "#9333ea",
  "#e11d48",
  "#65a30d",
  "#3b82f6",
];

const WIDGET_FONTS = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** Relative luminance of a CSS color; used to pick the widget color-scheme
 *  from the resolved background (custom themes make data-theme unreliable —
 *  it carries the theme ID, not the mode). */
function luminance(color: string): number {
  const m = color.trim().match(/^#([0-9a-f]{3,8})$/i);
  let r = 0;
  let g = 0;
  let b = 0;
  if (m) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0]! + hex[0]!, 16);
      g = parseInt(hex[1]! + hex[1]!, 16);
      b = parseInt(hex[2]! + hex[2]!, 16);
    } else {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else {
    const rgb = color.match(/(\d+(?:\.\d+)?)/g);
    if (rgb && rgb.length >= 3) {
      r = Number(rgb[0]);
      g = Number(rgb[1]);
      b = Number(rgb[2]);
    }
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Resolve the current theme into the widget variable map. Reads computed
 *  custom properties so custom-theme inline overrides (useTheme.ts) land too;
 *  a token that resolves to nothing falls back to a sane neutral. */
export function resolveWidgetTheme(): WidgetTheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (token: string, fallback: string): string => {
    const v = styles.getPropertyValue(`--${token}`).trim();
    return v || fallback;
  };
  const background = read("bg-tint", "#181818");
  const appearance: "light" | "dark" = luminance(background) > 0.55 ? "light" : "dark";
  const accent = read("accent", "#88c0d0");
  const variables: Record<string, string> = {
    "--background": background,
    "--foreground": read("text", appearance === "light" ? "#1a1a1a" : "#e4e4e4"),
    "--muted": read("surface-2", appearance === "light" ? "#f2f2f2" : "#222"),
    "--muted-foreground": read("text-dim", appearance === "light" ? "#6b6b6b" : "#9a9a9a"),
    "--card": read("surface", background),
    "--card-foreground": read("text", variables_fallback_fg(appearance)),
    "--surface": read("surface", background),
    "--border": read("border", appearance === "light" ? "#ddd" : "#333"),
    "--input": read("input-bg", read("surface-2", background)),
    "--input-foreground": read("input-fg", read("text", variables_fallback_fg(appearance))),
    "--primary": read("button-primary-bg", accent),
    "--primary-foreground": read("button-primary-fg", "#ffffff"),
    "--accent": accent,
    "--accent-soft": read("accent-soft", accent),
    "--accent-foreground": read("accent-contrast", "#ffffff"),
    "--destructive": read("danger", "#e5484d"),
    "--success": "#10b981",
    "--warning": "#f59e0b",
    "--info": "#3b82f6",
    "--code-background": read("editor-bg", read("surface-2", background)),
    "--code-foreground": read("editor-fg", read("text", variables_fallback_fg(appearance))),
    "--radius": "0.625rem",
    "--font-sans": WIDGET_FONTS.sans,
    "--font-mono": WIDGET_FONTS.mono,
  };
  CHART_SERIES.forEach((color, i) => {
    variables[`--chart-${i + 1}`] = i === 0 ? accent : color;
  });
  return { appearance, variables };
}

function variables_fallback_fg(appearance: "light" | "dark"): string {
  return appearance === "light" ? "#1a1a1a" : "#e4e4e4";
}

/**
 * Watch for theme changes and re-resolve. Relay themes switch via the
 * `data-theme` attribute (useTheme.ts) plus inline custom-property overrides
 * for custom themes — both are attributes on `documentElement`, so an
 * attribute MutationObserver covers every path (same pattern as
 * `useSyntaxTheme`). Returns the unsubscribe function.
 */
export function observeWidgetTheme(onChange: (theme: WidgetTheme) => void): () => void {
  let last = JSON.stringify(resolveWidgetTheme());
  const observer = new MutationObserver(() => {
    const next = resolveWidgetTheme();
    const serialized = JSON.stringify(next);
    if (serialized === last) return;
    last = serialized;
    onChange(next);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "style", "class"],
  });
  return () => observer.disconnect();
}
