// Bots store — the single source of truth for the roster, its runs and its
// approval inbox (docs/architecture/BOTS.md).
//
// Previously `useBots` owned the state with `useState`, and it is mounted by
// THREE consumers at once (the sidebar dock, every composer dock, and the Bots
// view). Each instance registered its own `bots:changed` listener, ran its own
// `botsRunning` poll, and fired five IPC reads per event. One Zustand store
// fixes that: the sync (listener + poll) lives once, in `useBotEvents`
// (mounted in App), and every hook instance reads the same state. Mutations
// still re-read from the backend rather than patching locally, because the
// backend is authoritative for name uniqueness, patch semantics and the
// disabled-on-create rule.
import { create } from "zustand";
import {
  botMemoryDelete,
  botMemoryList,
  createBot as ipcCreateBot,
  deleteBot as ipcDeleteBot,
  ensureBotSession,
  newBotSession,
  listBotApprovals,
  listBotRuns,
  listBots,
  resolveBotApproval,
  runBotNow,
  botsRunning,
  stopBotRun,
  schedulerAvailable,
  setBotEnabled as ipcSetBotEnabled,
  updateBot as ipcUpdateBot,
  type Bot,
  type BotApproval,
  type BotInput,
  type BotMemoryRow,
  type BotRun,
} from "../lib/ipc/bots";

interface BotsState {
  bots: Bot[];
  runs: BotRun[];
  approvals: BotApproval[];
  runningBots: string[];
  schedulerAvailable: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createBot: (input: BotInput) => Promise<Bot>;
  updateBot: (botId: string, patch: Partial<BotInput>) => Promise<Bot>;
  deleteBot: (botId: string, purgeMemory?: boolean) => Promise<void>;
  setBotEnabled: (botId: string, enabled: boolean) => Promise<void>;
  runNow: (botId: string, prompt?: string) => Promise<string | null>;
  stopRun: (runId: string) => Promise<void>;
  resolveApproval: (id: string, approve: boolean) => Promise<void>;
  listMemory: (botId: string) => Promise<BotMemoryRow[]>;
  deleteMemory: (botId: string, memoryId: string) => Promise<void>;
  openThread: (botId: string) => Promise<string>;
  /** Start a NEW conversation (thread) for a bot; resolves to its session id. */
  newConversation: (botId: string) => Promise<string>;
}

export const useBotsStore = create<BotsState>((set, get) => ({
  bots: [],
  runs: [],
  approvals: [],
  runningBots: [],
  schedulerAvailable: false,
  loading: true,
  error: null,

  refresh: async () => {
    try {
      const [nextBots, nextRuns, nextApprovals, nextRunning, nextScheduler] = await Promise.all([
        listBots(),
        listBotRuns(null, 30),
        listBotApprovals(null),
        botsRunning(),
        schedulerAvailable(),
      ]);
      set({
        bots: nextBots ?? [],
        runs: nextRuns ?? [],
        approvals: nextApprovals ?? [],
        runningBots: nextRunning ?? [],
        schedulerAvailable: Boolean(nextScheduler),
        error: null,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  createBot: async (input) => {
    const bot = await ipcCreateBot(input);
    await get().refresh();
    return bot;
  },

  updateBot: async (botId, patch) => {
    const bot = await ipcUpdateBot(botId, patch);
    await get().refresh();
    return bot;
  },

  deleteBot: async (botId, purgeMemory = false) => {
    await ipcDeleteBot(botId, purgeMemory);
    await get().refresh();
  },

  setBotEnabled: async (botId, enabled) => {
    await ipcSetBotEnabled(botId, enabled);
    await get().refresh();
  },

  runNow: async (botId, prompt) => {
    const result = await runBotNow(botId, prompt);
    await get().refresh();
    return result?.sessionId ?? null;
  },

  stopRun: async (runId) => {
    await stopBotRun(runId);
    await get().refresh();
  },

  resolveApproval: async (id, approve) => {
    await resolveBotApproval(id, approve);
    await get().refresh();
  },

  listMemory: (botId) => botMemoryList(botId),
  deleteMemory: async (botId, memoryId) => {
    await botMemoryDelete(botId, memoryId);
  },

  openThread: (botId) => ensureBotSession(botId),

  newConversation: async (botId) => {
    const sid = await newBotSession(botId);
    await get().refresh();
    return sid;
  },
}));

let loadedOnce = false;

/** Kick the first load exactly once per app run. Called from every `useBots`
 *  consumer and from the once-mounted sync hook; the flag makes it a no-op
 *  after the first. */
export function ensureBotsLoaded(): void {
  if (loadedOnce) return;
  loadedOnce = true;
  void useBotsStore.getState().refresh();
}

/** How often to re-read `bots_running` while at least one run is in flight. */
export const BOTS_POLL_MS = 5000;
