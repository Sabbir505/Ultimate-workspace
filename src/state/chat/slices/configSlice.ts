// Config slice: chat config + last-selection memory + API key management.
import {
  deleteChatApiKey,
  getChatConfig,
  setChatApiKey,
} from "../../../lib/ipc";
import { loadLastSelection, saveLastSelection } from "../../../lib/lastSelection";
import type { LastSelection } from "../../../lib/lastSelection";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createConfigSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    loadConfig: async (provider?: string) => {
      const [config, lastSelection] = await Promise.all([
        getChatConfig(provider),
        loadLastSelection(),
      ]);
      set({ config, lastSelection });
    },

    rememberSelection: (sel: LastSelection) => {
      set({ lastSelection: sel });
      void saveLastSelection(sel).catch(() => {
        /* best-effort — the in-memory value still seeds this run's new chats */
      });
    },

    saveApiKey: async (provider: string, key: string, baseUrl?: string, model?: string) => {
      await setChatApiKey(provider, key, baseUrl, model);
      // Refresh config for the SPECIFIC provider that was just saved, so the
      // API Keys panel sees hasKey: true for the currently selected provider.
      const config = await getChatConfig(provider);
      set({ config });
    },

    clearApiKey: async (provider: string) => {
      await deleteChatApiKey(provider);
      const config = await getChatConfig(provider);
      set({ config });
    },
  };
}
