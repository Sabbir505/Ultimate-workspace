// Bots — wire types and IPC for named persistent agents
// (docs/architecture/BOTS.md). A bot owns a persona, a memory profile, a
// docked pet, standing jobs (automations bound by botId), and one conversation
// of its own (ensureBotSession). Runs are separate, hidden sessions whose
// transcripts the activity strip opens.

import { safeInvoke, safeListen } from "../ipcCore";

/** The six docked companions a bot can wear (src/lib/pets). */
export const BOT_PETS = ["cat", "fox", "panda", "dragon", "axolotl", "robot"] as const;
export type BotPet = (typeof BOT_PETS)[number];

export interface Bot {
  id: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  /** "" = no pet; otherwise one of BOT_PETS. */
  pet: string;
  systemPrompt: string;
  provider: string; // "" = inherit session provider
  model: string; // "" = inherit session model
  toolsEnabled: boolean;
  memoryEnabled: boolean;
  enabled: boolean;
  inheritGlobalPrompt: boolean; // persona layers on the user's global prompt
  memoryReadDefault: boolean; // may READ the user's default memory (never write)
  createdAt: number;
  updatedAt: number;
}

export interface BotInput {
  name: string;
  description?: string;
  emoji?: string;
  color?: string;
  pet?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  toolsEnabled?: boolean;
  memoryEnabled?: boolean;
  enabled?: boolean;
  inheritGlobalPrompt?: boolean;
  memoryReadDefault?: boolean;
}

/** A headless execution of a bot (a standing job, a manual run, a delegation). */
export interface BotRun {
  id: string;
  botId: string;
  sessionId: string;
  jobId: string | null;
  jobName: string;
  source: "manual" | "job" | "ask" | string;
  startedAt: number;
  finishedAt: number | null;
  /** running | ok | error | stopped */
  status: string;
  summary: string;
  pendingApprovals: number;
}

export interface BotApproval {
  id: string;
  botId: string;
  runSessionId: string;
  toolName: string;
  argsJson: string;
  /** Deterministic, built from the tool name + args — never model-written. */
  summary: string;
  /** pending | approved | denied | expired | failed */
  status: string;
  result: string;
  createdAt: number;
  resolvedAt: number | null;
  botName: string;
}

export interface BotMemoryRow {
  id: string;
  kind: string;
  content: string;
  importance: number;
  status: string;
  createdAt: number;
}

export interface DeleteBotOutcome {
  jobsDeleted: number;
  runsDeleted: number;
  memories: number;
}

export const listBots = () => safeInvoke<Bot[]>("list_bots");
export const createBot = (input: BotInput) => safeInvoke<Bot>("create_bot", { input });
/** Patch semantics: send only what changed. A rename is updateBot(id, { name }). */
export const updateBot = (botId: string, patch: Partial<BotInput>) =>
  safeInvoke<Bot>("update_bot", { botId, patch });
export const deleteBot = (botId: string, purgeMemory = false) =>
  safeInvoke<DeleteBotOutcome>("delete_bot", { botId, purgeMemory });
export const setBotEnabled = (botId: string, enabled: boolean) =>
  safeInvoke<void>("set_bot_enabled", { botId, enabled });
export const ensureBotSession = (botId: string) =>
  safeInvoke<string>("ensure_bot_session", { botId });
/** Start a NEW conversation for a bot. `ensureBotSession` then returns it. */
export const newBotSession = (botId: string) =>
  safeInvoke<string>("new_bot_session", { botId });
export const runBotNow = (botId: string, prompt?: string) =>
  safeInvoke<{ runId: string; sessionId: string; prompt: string }>("run_bot_now", { botId, prompt });
export const listBotRuns = (botId?: string | null, limit = 20) =>
  safeInvoke<BotRun[]>("list_bot_runs", { botId: botId ?? null, limit });
export const listBotApprovals = (botId?: string | null) =>
  safeInvoke<BotApproval[]>("list_bot_approvals", { botId: botId ?? null });
export const resolveBotApproval = (id: string, approve: boolean) =>
  safeInvoke<BotApproval>("resolve_bot_approval", { id, approve });
export const botMemoryList = (botId: string) =>
  safeInvoke<BotMemoryRow[]>("bot_memory_list", { botId });
export const botMemoryDelete = (botId: string, memoryId: string) =>
  safeInvoke<void>("bot_memory_delete", { botId, memoryId });
/** Bots with a run in flight right now (the rail pulses their dot). */
export const botsRunning = () => safeInvoke<string[]>("bots_running");
/** Request a stop for one running run; true when a live run was found. */
export const stopBotRun = (runId: string) =>
  safeInvoke<boolean>("stop_bot_run", { runId });

/** Per-bot spend over a window — the Usage page's Bots section. Every session
 *  bound to the bot (conversations + runs) is summed from `chat_messages`. */
export interface BotCostRollup {
  botId: string;
  name: string;
  emoji: string;
  enabled: boolean;
  /** Runs started in the window. */
  runs: number;
  /** Standing jobs currently bound to the bot. */
  jobs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export const getBotCosts = (rangeDays: 7 | 30 | 90) =>
  safeInvoke<BotCostRollup[] | null>("get_bot_costs", { rangeDays });
/** True where a run-while-closed mechanism is registered (Windows today). */
export const schedulerAvailable = () => safeInvoke<boolean>("scheduler_available");

export interface BotsChangedPayload {
  action: "created" | "updated" | "deleted" | "run" | "approval" | string;
  botId: string;
  runId?: string;
  status?: string;
}

export const onBotsChanged = (cb: (p: BotsChangedPayload) => void) =>
  safeListen<BotsChangedPayload>("bots:changed", cb);

/** A headless bot run finished (manual "Run now" / `ask_bot`). Drives the
 *  bell panel + failure OS toast on the desktop. */
export interface BotRunFinishedPayload {
  botId: string;
  botName: string;
  /** ok | error | stopped */
  status: string;
  summary: string;
  sessionId: string;
}

export const onBotRunFinished = (cb: (p: BotRunFinishedPayload) => void) =>
  safeListen<BotRunFinishedPayload>("bot:run-finished", cb);
