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
  stopAutomationRun,
  toastError,
  updateAutomation,
  type Automation,
  type AutomationInput,
} from "../lib/ipc";

interface AutomationsState {
  loaded: boolean;
  automations: Automation[];
  /** id -> a run was just kicked off via run-now (button spinner). */
  runningNow: Record<string, boolean>;
  /** id -> a stop was just requested (Stop button spinner). */
  stoppingNow: Record<string, boolean>;

  load: () => Promise<void>;
  create: (input: AutomationInput) => Promise<Automation | null>;
  update: (id: string, input: AutomationInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  stopRun: (id: string) => Promise<void>;
}

export const useAutomationsStore = create<AutomationsState>((set, get) => ({
  loaded: false,
  automations: [],
  runningNow: {},
  stoppingNow: {},

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

  stopRun: async (id) => {
    set((s) => ({ stoppingNow: { ...s.stoppingNow, [id]: true } }));
    try {
      const stopped = await stopAutomationRun(id);
      if (!stopped) {
        // No run in flight in this process: it already ended, or it belongs
        // to the run-while-closed Task Scheduler binary, which an in-app
        // stop can't reach.
        toastError(
          "Couldn't stop the run",
          "It isn't active in Relay — it may have just finished, or it's running outside the app (run while closed).",
        );
      }
      // The kill path finalizes the row within moments; refresh so the
      // stopped status lands without waiting for the 5 s poll.
      setTimeout(() => void get().load().catch(() => {}), 800);
    } finally {
      set((s) => {
        const stoppingNow = { ...s.stoppingNow };
        delete stoppingNow[id];
        return { stoppingNow };
      });
    }
  },
}));
