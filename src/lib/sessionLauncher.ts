// Orchestration for opening sessions / spawning panes. This sits above the
// stores: it decides focus-vs-spawn-vs-replace (§4.3) and issues the contract
// spawn commands. Kept out of the stores so the stores stay pure & testable.
import { runHarnessLogin, spawnAgentSession, spawnShell, touchSession } from "./ipc";
import {
  MAX_PANES,
  isVisiblePane,
  selectLruPane,
  usePanesStore,
  type Pane,
  type PaneDescriptor,
  type TerminalSpawnSpec,
} from "../state/panes";
import { useProjectsStore } from "../state/projects";
import { useUiStore } from "../state/ui";
import { sessionDisplayTitle } from "./sessionTitle";
import type { HarnessId, SessionRecord } from "../types";

/** Number of panes occupying grid slots. Minimized browsers don't count
 *  (they're parked out of the layout), so a minimized browser frees its slot
 *  for another CLI. */
function visibleCount(panes: Pane[]): number {
  return panes.filter(isVisiblePane).length;
}

/** Issue the backend spawn command matching a pane's spawn spec. */
export async function spawnForPane(paneId: string, spec: TerminalSpawnSpec): Promise<void> {
  switch (spec.type) {
    case "agent":
      await spawnAgentSession(paneId, spec.sessionId);
      break;
    case "shell":
      await spawnShell(paneId, spec.cwd, spec.command, spec.injectSecretsProjectId);
      break;
    case "login":
      await runHarnessLogin(paneId, spec.harnessId, spec.cwd);
      break;
  }
}

export function terminalDescriptor(
  spec: TerminalSpawnSpec,
  label: string,
  sessionId: string | null,
  harness: HarnessId | null,
): PaneDescriptor {
  return { kind: "terminal", sessionId, harness, label, spawn: spec };
}

/** Respawn a pane whose process exited (the "press R to resume" overlay). */
export async function respawnPane(paneId: string): Promise<void> {
  const pane = usePanesStore.getState().panes.find((p) => p.paneId === paneId);
  if (!pane || pane.data.kind !== "terminal") return;
  usePanesStore.getState().markPaneRespawned(paneId);
  await spawnForPane(paneId, pane.data.spawn);
  if (pane.data.sessionId) void touchSession(pane.data.sessionId);
}

/**
 * Open a session per §4.3: focus an existing pane for it, spawn into a free
 * slot, or — when all 6 slots are taken — ask the user to confirm replacing
 * the least-recently-used pane (handled by the pendingReplace UI flow).
 */
export async function openSession(session: SessionRecord): Promise<void> {
  const panesStore = usePanesStore.getState();
  const existing = panesStore.panes.find(
    (p) => p.data.kind === "terminal" && p.data.sessionId === session.id,
  );
  if (existing) {
    panesStore.focusPane(existing.paneId);
    // Bump last_active_at + refresh the sidebar so reusing a session reorders
    // it to the top — without this the session list is frozen at creation
    // order and "recent" sessions look stale (the persistence bug).
    void touchSession(session.id);
    void useProjectsStore.getState().refreshSessions();
    return;
  }

  const projectsStore = useProjectsStore.getState();
  const project = projectsStore.projectById(session.projectId);
  const label = `${sessionDisplayTitle(session.title)} · ${project?.name ?? "?"}`;

  if (visibleCount(panesStore.panes) < MAX_PANES) {
    const paneId = panesStore.addPane(
      terminalDescriptor(
        { type: "agent", sessionId: session.id },
        label,
        session.id,
        session.harness,
      ),
    );
    await spawnForPane(paneId, { type: "agent", sessionId: session.id });
    void touchSession(session.id);
    void useProjectsStore.getState().refreshSessions();
    return;
  }

  const lru = selectLruPane(panesStore.panes);
  if (lru) {
    useUiStore.getState().setPendingReplace({ sessionId: session.id, lruPaneId: lru.paneId });
  }
}

/** User confirmed: replace the LRU pane with the pending session. */
export async function confirmReplaceLru(): Promise<void> {
  const ui = useUiStore.getState();
  const pending = ui.pendingReplace;
  if (!pending) return;
  ui.setPendingReplace(null);

  const session = useProjectsStore.getState().sessions.find((s) => s.id === pending.sessionId);
  if (!session) return;
  const project = useProjectsStore.getState().projectById(session.projectId);
  const label = `${sessionDisplayTitle(session.title)} · ${project?.name ?? "?"}`;

  usePanesStore
    .getState()
    .replacePane(
      pending.lruPaneId,
      terminalDescriptor({ type: "agent", sessionId: session.id }, label, session.id, session.harness),
    );
  // replacePane keeps the same paneId for the slot's identity? No — it creates a
  // fresh paneId. Find the new pane (the focused one) and spawn into it.
  const newPane = usePanesStore.getState().panes.find(
    (p) => p.data.kind === "terminal" && p.data.sessionId === session.id,
  ) as Pane | undefined;
  if (newPane) {
    await spawnForPane(newPane.paneId, { type: "agent", sessionId: session.id });
    void touchSession(session.id);
  }
}

/** Create a brand-new session in a project and open it in the grid (§4.2). */
export async function newSessionFlow(projectId: string, harness: HarnessId): Promise<void> {
  const session = await useProjectsStore.getState().createSessionFor(projectId, harness);
  if (session) await openSession(session);
}

/** Pick a harness for Cmd+N: prefer the only installed one, else Claude Code. */
export function defaultHarness(): HarnessId {
  const installed = useProjectsStore.getState().harnesses.filter((h) => h.installed);
  if (installed.length === 1) return installed[0].id;
  return installed.find((h) => h.id === "claude_code")?.id ?? installed[0]?.id ?? "claude_code";
}

/** Run a per-project quick action in its own shell pane (§7.7). */
export async function runQuickAction(projectId: string, label: string, command: string): Promise<void> {
  const project = useProjectsStore.getState().projectById(projectId);
  if (!project) return;
  const panesStore = usePanesStore.getState();
  if (visibleCount(panesStore.panes) >= MAX_PANES) return; // grid full — do nothing silently
  const paneId = panesStore.addPane(
    terminalDescriptor(
      { type: "shell", cwd: project.path, command, injectSecretsProjectId: projectId },
      `${label} · ${project.name}`,
      null,
      null,
    ),
  );
  await spawnForPane(paneId, { type: "shell", cwd: project.path, command, injectSecretsProjectId: projectId });
}

/** Open a login-flow pane for a harness (§9 "Run login"). */
export async function runLoginFlow(harnessId: HarnessId, cwd: string, label: string): Promise<void> {
  const panesStore = usePanesStore.getState();
  if (visibleCount(panesStore.panes) >= MAX_PANES) return;
  const paneId = panesStore.addPane(
    terminalDescriptor({ type: "login", harnessId, cwd }, label, null, harnessId),
  );
  await spawnForPane(paneId, { type: "login", harnessId, cwd });
}
