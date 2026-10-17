// Bots — the roster, its runs and its approval inbox (docs/architecture/BOTS.md).
//
// The state and the mutations live in ONE shared Zustand store
// (`state/bots`) so the several live consumers (the sidebar dock, each
// composer dock, the Bots view) share a single snapshot instead of each
// owning its own copy, event listener and poll. The `bots:changed` listener
// and the `botsRunning` poll are wired once, in `useBotEvents` (App).
//
// This hook is the read surface: it triggers the first load exactly once and
// returns the store. Every mutation re-reads from the backend rather than
// patching locally, because the backend is authoritative for name uniqueness,
// patch semantics and the disabled-on-create rule.
import { useEffect } from "react";
import { ensureBotsLoaded, useBotsStore } from "../state/bots";
import type { Bot, BotApproval, BotInput, BotMemoryRow, BotRun } from "../lib/ipc/bots";

export interface UseBots {
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
  /** Kicks off a run and resolves to the run session id (so the caller can
   *  open it live), or null when the backend returned none. */
  runNow: (botId: string, prompt?: string) => Promise<string | null>;
  /** Stop one running run (the rail's Stop). */
  stopRun: (runId: string) => Promise<void>;
  resolveApproval: (id: string, approve: boolean) => Promise<void>;
  listMemory: (botId: string) => Promise<BotMemoryRow[]>;
  deleteMemory: (botId: string, memoryId: string) => Promise<void>;
  /** Opens (creating on first use) the bot's thread in the chat store. */
  openThread: (botId: string) => Promise<string>;
  /** Start a NEW conversation (thread) for a bot; resolves to its session id. */
  newConversation: (botId: string) => Promise<string>;
}

export function useBots(): UseBots {
  useEffect(() => {
    ensureBotsLoaded();
  }, []);
  return useBotsStore();
}
