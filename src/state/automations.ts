// Automations store (scheduled headless agent runs — automations.rs).
// The sidebar lists them; runs are launched by the backend scheduler (or the
// run-now button) and logged into each automation's own chat session.
import { create } from "zustand";
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  runAutomationNow,
  setAutomationEnabled,
  updateAutomation,
  type Automation,
  type AutomationInput,
} from "../lib/ipc";

interface AutomationsState {
  loaded: boolean;
  automations: Automation[];
  /** id -> a run was just kicked off via run-now (button spinner). */
  runningNow: Record<string, boolean>;

  load: () => Promise<void>;
  create: (input: AutomationInput) => Promise<Automation | null>;
  update: (id: string, input: AutomationInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  runNow: (id: string) => Promise<void>;
}

export const useAutomationsStore = create<AutomationsState>((set, get) => ({
  loaded: false,
  automations: [],
  runningNow: {},

  load: async () => {
    const automations = await listAutomations();
    set({ loaded: true, automations: automations ?? [] });
  },

  create: async (input) => {
    const automation = await createAutomation(input);
    if (automation) set((s) => ({ automations: [...s.automations, automation] }));
    return automation;
  },

  update: async (id, input) => {
    await updateAutomation(id, input);
    await get().load();
  },

  remove: async (id) => {
    await deleteAutomation(id);
    set((s) => ({ automations: s.automations.filter((a) => a.id !== id) }));
  },

  setEnabled: async (id, enabled) => {
    await setAutomationEnabled(id, enabled);
    set((s) => ({
      automations: s.automations.map((a) => (a.id === id ? { ...a, enabled } : a)),
    }));
  },

  runNow: async (id) => {
    set((s) => ({ runningNow: { ...s.runningNow, [id]: true } }));
    try {
      await runAutomationNow(id);
      // Refresh after a beat so lastStatus/lastRunAt reflect the launch.
      setTimeout(() => void get().load().catch(() => {}), 1500);
    } finally {
      set((s) => {
        const runningNow = { ...s.runningNow };
        delete runningNow[id];
        return { runningNow };
      });
    }
  },
}));
