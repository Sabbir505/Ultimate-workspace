// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";
import { getSetting, setSetting } from "../ipc";
import type { CostRollups, CostEvent, QuickAction, Skill } from "../../types";

// ---- Approval rules (roadmap #8) ----
// A user-defined rule auto-approves a filesystem tool call matching
// `(tool, path-glob)` past the approval card. Stored as a JSON array under the
// `permissions.rules` app_settings key; matched per-turn in chat tool dispatch.

export interface ApprovalRule {
  id: string;
  tool: string;
  pattern: string;
  createdAt: number;
}

const RULES_KEY = "permissions.rules";

/** Load the current approval rules (empty array when unset/invalid). */
export async function getPermissionsRules(): Promise<ApprovalRule[]> {
  try {
    const raw = await getSetting(RULES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ApprovalRule[]) : [];
  } catch {
    return [];
  }
}

/** Persist the full approval-rules list. */
export async function setPermissionsRules(rules: ApprovalRule[]): Promise<void> {
  await setSetting(RULES_KEY, JSON.stringify(rules));
}

export interface DataPaths {
  chatDbPath: string;
  chatDbSize: number;
  artifactsDir: string;
  artifactsSize: number;
}
export const getDataPaths = () => safeInvoke<DataPaths | null>("get_data_paths", {});
export const setChatDbDir = (dir: string | null) =>
  safeInvoke<void>("set_chat_db_dir", { dir });
export const listSkills = (projectId?: string) =>
  safeInvoke<Skill[] | null>("list_skills", projectId ? { projectId } : {});
export const createSkill = (name: string, slashCommand: string, content: string, scope: string) =>
  safeInvoke<Skill | null>("create_skill", { name, slashCommand, content, scope });
export const updateSkill = (id: string, name: string, slashCommand: string, content: string) =>
  safeInvoke<void>("update_skill", { id, name, slashCommand, content });
export const deleteSkill = (id: string) => safeInvoke<void>("delete_skill", { id });
export const listQuickActions = (projectId: string) =>
  safeInvoke<QuickAction[] | null>("list_quick_actions", { projectId });
export const createQuickAction = (
  projectId: string,
  label: string,
  command: string,
  keybinding?: string,
  runOnWorktree?: boolean,
) => safeInvoke<QuickAction | null>("create_quick_action", { projectId, label, command, keybinding, runOnWorktree });
export const updateQuickAction = (id: string, label: string, command: string, keybinding?: string, runOnWorktree?: boolean) =>
  safeInvoke<void>("update_quick_action", { id, label, command, keybinding, runOnWorktree });
export const deleteQuickAction = (id: string) => safeInvoke<void>("delete_quick_action", { id });
export const setSecret = (projectId: string, key: string, value: string) =>
  safeInvoke<void>("set_secret", { projectId, key, value });
export const deleteSecret = (projectId: string, key: string) =>
  safeInvoke<void>("delete_secret", { projectId, key });
export const listSecretKeys = (projectId: string) =>
  safeInvoke<string[] | null>("list_secret_keys", { projectId });
export const getCostEvents = (sessionId?: string) =>
  safeInvoke<CostEvent[] | null>("get_cost_events", {
    sessionId: sessionId ?? null,
    // M6: bounded by default (backend also caps at 500 when null).
    limit: 500,
    beforeTs: null,
  });
export const getCostRollups = (rangeDays?: 7 | 30 | 90) =>
  safeInvoke<CostRollups | null>("get_cost_rollups", rangeDays ? { rangeDays } : {});
export const exportSessionMarkdown = (paneId: string) =>
  safeInvoke<string | null>("export_session_markdown", { paneId });
export const readFileText = (path: string) => safeInvoke<string | null>("read_file_text", { path });
