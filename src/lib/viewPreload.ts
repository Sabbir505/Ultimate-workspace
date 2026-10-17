// Lazy-view preloading.
//
// Every non-chat screen is a `React.lazy` chunk (see App.tsx) so the entry
// bundle stays small. The trade-off is that the FIRST time a user opens a
// screen, its chunk is fetched on click — a cold open measured at 80–370 ms
// on the production build (settings is the worst: a ~315 KB chunk).
//
// This module centralizes those dynamic imports so they can be triggered
// BEFORE the click:
//   - on pointer hover / keyboard focus of a nav entry (the user is about to
//     open it — the fetch starts while they move the mouse), and
//   - once on idle after boot (so even the first cold click finds the chunk
//     already parsed).
//
// The import functions are the exact same ones App.tsx hands to `React.lazy`,
// so Vite emits one chunk per view and the module cache is shared — a preload
// is never wasted work.
import type { ActiveView } from "../state/ui";

export const loadSettingsView = () => import("../components/settings/SettingsView");
export const loadSkillsLibrary = () => import("../components/skills-library/SkillsLibrary");
export const loadCostDashboard = () => import("../components/cost-dashboard/CostDashboard");
export const loadWikiView = () => import("../components/wiki/WikiView");
export const loadAutomationsView = () => import("../components/automations/AutomationsView");
export const loadBotsView = () => import("../components/bots/BotsView");
export const loadVaultView = () => import("../components/vault/VaultView");
export const loadLogsView = () => import("../components/logs/LogsView");
export const loadCommandPalette = () => import("../components/command-palette/CommandPalette");

const LOADERS: Partial<Record<ActiveView, () => Promise<unknown>>> = {
  settings: loadSettingsView,
  skills: loadSkillsLibrary,
  cost: loadCostDashboard,
  wiki: loadWikiView,
  automations: loadAutomationsView,
  bots: loadBotsView,
  vault: loadVaultView,
  logs: loadLogsView,
};

/** Fetch a view's chunk now (fire-and-forget). Safe to call repeatedly — the
 *  module cache makes repeat calls free. Errors are swallowed: a failed
 *  preload must never surface; the real lazy import will retry on open. */
export function preloadView(view: ActiveView): void {
  LOADERS[view]?.().catch(() => {});
}

/** Warm every lazy screen once, staggered so the boot IPC/render burst isn't
 *  competing with one big import storm. Runs after the app is interactive. */
export function preloadAllViews(): () => void {
  const views = Object.keys(LOADERS) as ActiveView[];
  const timers: number[] = [];
  views.forEach((view, i) => {
    timers.push(window.setTimeout(() => preloadView(view), 300 + i * 180));
  });
  return () => timers.forEach((t) => window.clearTimeout(t));
}
