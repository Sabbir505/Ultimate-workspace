// docdesign — named design systems: a theme plus a curated layout subset and
// a voice, so a generated deck/document reads as one coherent brand rather
// than a grab-bag of layouts. Selecting a system (plan_document `system`
// arg) defaults the theme and warns when the plan strays outside the
// system's layout subset.
import raw from "./systems.json";
import { DECK_LAYOUT_IDS } from "./catalog";
import { canonicalThemeId, tokens } from "./tokens";
import type { Issue } from "./ir";

export interface DesignSystem {
  id: string;
  name: string;
  defaultTheme: string;
  kinds: ("deck" | "doc" | "pdf")[];
  layouts: string[];
  voice: string;
}

export const systems = raw as unknown as {
  version: number;
  systems: Record<string, Omit<DesignSystem, "id">>;
};

export function systemIds(): string[] {
  return Object.keys(systems.systems);
}

export function getSystem(id: string | null | undefined): DesignSystem | undefined {
  const key = (id ?? "").trim().toLowerCase();
  if (!key || !systems.systems[key]) return undefined;
  return { id: key, ...systems.systems[key] };
}

/** Resolve the effective theme for a (system, theme) pair — the explicit
 *  theme wins; otherwise the system's default; otherwise the global default. */
export function resolveTheme(theme: string | null | undefined, systemId: string | null | undefined): string {
  if (theme && theme.trim()) return canonicalThemeId(theme);
  const sys = getSystem(systemId);
  if (sys) return canonicalThemeId(sys.defaultTheme);
  return tokens.defaultTheme;
}

/** Warn when a deck plan uses layouts outside its system's subset. */
export function checkSystemFit(slides: { layout: string }[], systemId: string | null | undefined): Issue[] {
  const sys = getSystem(systemId);
  if (!sys) return [];
  const offSet = new Set(slides.map((s) => s.layout).filter((l) => !sys.layouts.includes(l) && DECK_LAYOUT_IDS.includes(l)));
  if (offSet.size === 0) return [];
  return [
    {
      severity: "warning",
      rule: "system/fit",
      message: `layouts outside the ${sys.name} system: ${[...offSet].join(", ")} — that is allowed, but ${sys.name} reads best with: ${sys.layouts.join(", ")} (${sys.voice})`,
    },
  ];
}
