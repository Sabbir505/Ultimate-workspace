// Pane-layout persistence: autosave the current pane grid into the per-project
// `workspaces` row named "__autosave__" (debounced), and restore it when a
// project is selected with an empty grid — which includes app launch, since
// the last selected project is remembered via the projects.lastSelectedId
// app setting. The Workspaces save/restore IPC has existed since the layout
// work; this module is the wiring that was missing.
//
// What survives a restart:
//   - agent terminal panes: re-opened via spawn_agent_session, which resumes
//     the harness session id persisted on the session row (same resume flow
//     as clicking the session in the sidebar)
//   - shell terminal panes: re-run their command in their cwd
//   - browser panes: every tab's URL + the active tab + collapsed state
// Login panes (transient auth flows) are intentionally NOT persisted.
import {
  getSetting,
  listWorkspaces,
  saveWorkspace,
  setSetting,
} from "./ipc";
import { terminalDescriptor, spawnForPane } from "./sessionLauncher";
import { usePanesStore, type Pane } from "../state/panes";
import { useProjectsStore } from "../state/projects";
import { useUiStore } from "../state/ui";
import { sessionDisplayTitle } from "./sessionTitle";
import type { HarnessId } from "../types";

export const AUTOSAVE_WORKSPACE_NAME = "__autosave__";
const SETTINGS_LAST_PROJECT = "projects.lastSelectedId";
const SAVE_DEBOUNCE_MS = 800;

/** One pane in the persisted layout JSON. */
export type LayoutPane =
  | { kind: "terminal-agent"; sessionId: string; harness: HarnessId | null; label: string }
  | { kind: "terminal-shell"; cwd: string; command: string; label: string }
  | {
      kind: "browser";
      projectId: string | null;
      tabs: string[];
      activeTabIndex: number;
      collapsed: boolean;
    };

export interface LayoutSnapshotV1 {
  v: 1;
  panes: LayoutPane[];
}

/** Serialize the live pane grid. Login panes are dropped; everything else
 *  keeps exactly the fields a restart needs to respawn it. Browser panes are
 *  ALSO dropped (user request): reopening the app must not auto-spawn the
 *  browser pane with the previous session's pages — the user opens it when
 *  they want it. */
export function serializePanes(panes: Pane[]): LayoutSnapshotV1 {
  const out: LayoutPane[] = [];
  for (const p of panes) {
    if (p.data.kind === "terminal") {
      if (p.data.spawn.type === "agent") {
        if (!p.data.sessionId) continue;
        out.push({
          kind: "terminal-agent",
          sessionId: p.data.sessionId,
          harness: p.data.harness,
          label: p.data.label,
        });
      } else if (p.data.spawn.type === "shell") {
        out.push({
          kind: "terminal-shell",
          cwd: p.data.spawn.cwd,
          command: p.data.spawn.command,
          label: p.data.label,
        });
      }
      // login panes: skipped by design
    }
    // browser panes: skipped by design — no auto-open on app start
  }
  return { v: 1, panes: out };
}

/** Parse a workspaces.data blob back into a snapshot. Unknown versions /
 *  malformed JSON → null (restore silently no-ops). */
export function parseSnapshot(data: string): LayoutSnapshotV1 | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.panes)) return null;
    return parsed as LayoutSnapshotV1;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
// Snapshot of the last layout we restored, per project. When the autosave
// persists a DIFFERENT layout for a restored project (e.g. the user closed
// every pane deliberately), the once-per-run guard is replaced by "don't
// re-restore while the user's layout differs from what we put there" — so
// re-selecting the same project after closing its panes stays empty.
const lastRestoredLayout = new Map<string, string>();
// Restores currently in flight. A restore is async (list workspaces, then
// respawn panes), and during that window the grid is still empty — without
// this guard a quick A→B project switch would start a second restore and
// merge both layouts into one grid.
const restorePending = new Set<string>();
// Store subscription teardowns, so tests can fully rewire via
// _resetWorkspacePersistenceForTests without stacking duplicate listeners.
let unsubs: Array<() => void> = [];

/** Debounced autosave — called from the panes-store subscription. Multiple
 *  rapid pane mutations (open+focus+navigate) collapse into one write. */
export function scheduleLayoutSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveLayoutNow().catch(() => {
      /* best-effort autosave — retried on the next pane mutation */
    });
  }, SAVE_DEBOUNCE_MS);
}

async function saveLayoutNow(projectIdOverride?: string): Promise<void> {
  // On a project switch the store already points at the NEW project, so the
  // flush passes the outgoing id explicitly — otherwise the outgoing
  // project's panes would be persisted under the incoming project's key.
  const projectId = projectIdOverride ?? useProjectsStore.getState().selectedProjectId;
  if (!projectId) return; // layouts are keyed by project; nothing to bind to
  const snapshot = serializePanes(usePanesStore.getState().panes);
  const json = JSON.stringify(snapshot);
  // The persisted layout differs from the one we restored → the user changed
  // the grid on purpose. Drop the restored marker so this layout wins.
  if (lastRestoredLayout.get(projectId) !== json) {
    lastRestoredLayout.delete(projectId);
  }
  await saveWorkspace(projectId, AUTOSAVE_WORKSPACE_NAME, json);
}

/** If a debounced save is pending (unsaved pane mutations), run it NOW for
 *  the given project. Called on project switch so the outgoing project's
 *  final layout (e.g. "user closed everything") isn't lost to the debounce
 *  window — and so the restored-marker divergence check sees it immediately. */
function flushLayoutSave(projectId?: string): void {
  if (!saveTimer) return; // nothing unsaved
  clearTimeout(saveTimer);
  saveTimer = null;
  void saveLayoutNow(projectId).catch(() => {
    /* best-effort flush — the next autosave retries */
  });
}

/**
 * Rebuild a project's saved pane grid. Best-effort per pane: a session that
 * was deleted since the save (or a cwd that no longer exists) is skipped
 * without failing the rest. Returns true when a snapshot existed at all.
 */
export async function restoreLayout(projectId: string): Promise<boolean> {
  const workspaces = await listWorkspaces(projectId);
  const row = workspaces?.find((w) => w.name === AUTOSAVE_WORKSPACE_NAME);
  if (!row) return false;
  const snap = parseSnapshot(row.data);
  if (!snap || snap.panes.length === 0) return row != null;

  const panesStore = usePanesStore.getState();
  const projectsStore = useProjectsStore.getState();

  for (const lp of snap.panes) {
    try {
      if (lp.kind === "terminal-agent") {
        // Deleted sessions can't be resumed — skip the pane entirely.
        const session = projectsStore.sessions.find((s) => s.id === lp.sessionId);
        if (!session) continue;
        const project = projectsStore.projectById(session.projectId);
        const label = `${sessionDisplayTitle(session.title)} · ${project?.name ?? "?"}`;
        const paneId = panesStore.addPane(
          terminalDescriptor(
            { type: "agent", sessionId: session.id },
            label,
            session.id,
            session.harness,
          ),
        );
        await spawnForPane(paneId, { type: "agent", sessionId: session.id });
      } else if (lp.kind === "terminal-shell") {
        const paneId = panesStore.addPane(
          terminalDescriptor(
            { type: "shell", cwd: lp.cwd, command: lp.command },
            lp.label,
            null,
            null,
          ),
        );
        await spawnForPane(paneId, { type: "shell", cwd: lp.cwd, command: lp.command });
      }
      // Browser panes: skipped on restore BY DESIGN — the app must not
      // auto-open the browser with the previous session's pages (user
      // request). Old stored snapshots may still contain `browser` entries;
      // they are ignored, and the next autosave rewrites the snapshot
      // without them (serializePanes no longer emits them).
    } catch (err) {
      // One bad pane (deleted session, missing cwd, …) never blocks the rest.
      console.warn("[relay] workspace restore skipped a pane:", err);
    }
  }

  // Remember what we restored (canonical serialization — same shape
  // saveLayoutNow produces) so it can detect deliberate user changes.
  lastRestoredLayout.set(projectId, JSON.stringify(snap));
  return true;
}

let initialized = false;
// A project's layout is restored at most once per app run — otherwise
// deliberately closing every pane and re-selecting the project would
// resurrect the old grid against the user's intent.
const restoredThisRun = new Set<string>();

/** Test-only: reset the init guard + restored set so a suite can rewire.
 *  (resetModules doesn't work here — it would fork the zustand stores.) */
export function _resetWorkspacePersistenceForTests(): void {
  initialized = false;
  restoredThisRun.clear();
  lastRestoredLayout.clear();
  restorePending.clear();
  for (const unsub of unsubs) unsub();
  unsubs = [];
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/**
 * Wire layout persistence. Call once after the projects store has loaded
 * (App bootstrap chains it behind loadAll):
 *  1. autosave on every panes-store mutation (debounced)
 *  2. on project select: remember it (lastSelectedId) and, when the grid is
 *     empty, restore that project's saved layout
 *  3. at boot: re-select the last project → step 2 restores its layout
 */
export async function initWorkspacePersistence(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // (1) Autosave. The panes store is tiny; subscribing to the whole store and
  //     debouncing is simpler than diffing individual fields.
  unsubs.push(usePanesStore.subscribe(() => scheduleLayoutSave()));

  // (2) Project selection → flush outgoing layout, persist selection, restore.
  let prevProjectId = useProjectsStore.getState().selectedProjectId;
  unsubs.push(
    useProjectsStore.subscribe((s) => {
      const next = s.selectedProjectId;
      if (next === prevProjectId) return;
      const outgoing = prevProjectId;
      prevProjectId = next;
      // Persist the outgoing project's final layout first: the marker delete
      // inside saveLayoutNow is what stops a deliberate "closed everything"
      // from being resurrected when the user switches back.
      flushLayoutSave(outgoing ?? undefined);
      if (!next) return;
      void setSetting(SETTINGS_LAST_PROJECT, next);
      maybeRestoreForProject(next);
    }),
  );

  // Restore rules for a just-selected project:
  //  - never touch a live grid (project switching must not wipe panes), and
  //    treat an in-flight restore as a live grid (it's about to fill it)
  //  - at most once per run UNLESS the user already changed the grid after
  //    the restore (deliberate close = the empty layout wins, no re-restore;
  //    a stale restore is only possible when the user never touched it)
  const maybeRestoreForProject = (projectId: string) => {
    if (usePanesStore.getState().panes.length > 0 || restorePending.size > 0) return;
    if (restoredThisRun.has(projectId) && !lastRestoredLayout.has(projectId)) return;
    restoredThisRun.add(projectId);
    restorePending.add(projectId);
    void restoreLayout(projectId)
      .catch((err) => console.warn("[relay] workspace restore failed:", err))
      .finally(() => restorePending.delete(projectId));
  };

  // (3) Boot: re-select the last-used project. The subscription above does
  //     the actual restore once selection flips.
  const last = await getSetting(SETTINGS_LAST_PROJECT);
  if (last) {
    const projects = useProjectsStore.getState();
    if (projects.projects.some((p) => p.id === last)) {
      projects.selectProject(last);
    }
  }
}
