// IPC contract types — mirrors CONTRACT.md exactly (camelCase fields).
export type HarnessId = "claude_code" | "kimi_code" | "opencode";
export type PaneState = "idle" | "working" | "waiting" | "diff_ready";

export interface Project {
  id: string;
  path: string;
  name: string;
  isGitRepo: boolean;
  createdAt: number;
  lastOpenedAt: number | null;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  harness: HarnessId;
  harnessSessionId: string | null;
  title: string | null;
  worktreePath: string | null;
  createdAt: number;
  lastActiveAt: number;
  status: string;
}

export interface HarnessStatus {
  id: HarnessId;
  displayName: string;
  installed: boolean;
}

/** Compact badge label for a harness id — used in pane headers, session rows,
 *  and the spotlight bar where a full display name won't fit. Single source of
 *  truth so adding a harness doesn't require hunting down ternaries. */
export function harnessShortName(id: HarnessId): string {
  switch (id) {
    case "claude_code":
      return "claude";
    case "kimi_code":
      return "kimi";
    case "opencode":
      return "opencode";
  }
}

export interface GitStatusInfo {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

/** A changed file from the per-pane diff panel, as parsed from `git status --porcelain -z`. */
export interface ChangedFile {
  status: string; // XY porcelain code (" M", "M ", "??", "A ", "D ", "R ", …)
  kind: string; // Single-letter UI group: "M" modified, "A" added, "D" deleted, "R" renamed, "C" copied, "U" untracked
  path: string; // Repo-relative path (new path on renames)
  oldPath: string | null; // Original path on renames/copies; null otherwise
  added: number; // Added line count from git diff --numstat
  deleted: number; // Deleted line count from git diff --numstat
}

export interface Skill {
  id: string;
  name: string;
  slashCommand: string;
  content: string;
  scope: string; // 'global' or a project id
  createdAt: number;
}

export interface QuickAction {
  id: string;
  projectId: string;
  label: string;
  command: string;
  keybinding: string | null;
  runOnWorktree: boolean;
}

export interface CostEvent {
  id: number;
  sessionId: string;
  timestamp: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
}

export interface CostRollups {
  perProject: Array<{
    projectId: string;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }>;
  daily: Array<{ day: string; costUsd: number }>; // day = 'YYYY-MM-DD'
}

// Event payloads (backend -> frontend)
export interface PtyOutputPayload {
  paneId: string;
  data: string;
}
export interface PtyExitPayload {
  paneId: string;
  code: number | null;
}
export interface PtyStatePayload {
  paneId: string;
  state: PaneState;
}
export interface HarnessIdPayload {
  sessionId: string;
  harnessSessionId: string;
}
export interface CostUpdatedPayload {
  sessionId: string;
}

// Emitted when a URL is detected in a terminal pane's output (e.g. a CLI
// agent printed a preview URL). The frontend opens it in the built-in browser.
export interface BrowserUrlDetectedPayload {
  paneId: string;
  url: string;
}

// Installed skill/loop discovered in a harness's on-disk skill directory
// (~/.claude/skills, ~/.agents/skills, or their loops/ counterparts).
export interface InstalledSkill {
  slug: string;
  name: string;
  description: string;
  source: "claude" | "kimi" | "both";
  claudePath: string | null;
  kimiPath: string | null;
  kind: "skill" | "loop";
}

/** A skill surfaced in the chat `/` menu — on-disk harness skill or built-in. */
export interface AvailableSkill {
  slug: string;
  name: string;
  description: string;
  origin: "installed" | "builtin";
}
