// Subagent store — persisted subagent definitions (Settings → Agents → Subagent).
// Mirrors state/automations.ts: one `load` that the panel calls on mount, the
// entity array, and create/update/remove that go through the ipc wrappers.
//
// Phase 1 is the registry, Phase 2.5 the run surface: `runNow` spawns the
// agent as a normal chat session and selects it, `loadRuns` fills the runs
// list, and `runs`/`ingestRun` are where a parent-less `chat:session-spawn`
// lands (meshSlice routes those here) so the sidebar lists a run live.
import { create } from "zustand";
import {
  createSubagent,
  deleteSubagent,
  listSubagents,
  listSubagentRuns,
  runSubagent,
  updateSubagent,
  type Subagent,
  type SubagentInput,
  type SubagentRun,
} from "../lib/ipc";

/** `busy` key for a definition that doesn't exist yet (the editor's create
 *  form) — the create call has no id to hang the transient on. */
export const SUBAGENT_NEW_KEY = "__new__";

interface SubagentState {
  loaded: boolean;
  agents: Subagent[];
  /** Last failure, surfaced inline by the panel (a rejected builtin delete
   *  lands here). Cleared on the next successful mutation. */
  error: string | null;
  /** agent id (or SUBAGENT_NEW_KEY) -> a save/delete/run is in flight. */
  busy: Record<string, boolean>;
  /** run id -> a known run. Populated by `ingestRun` from the spawn event
   *  and by `loadRuns` from `list_subagent_runs`. */
  runs: Record<string, SubagentRun>;
  /** True once `loadRuns` has run at least once — the runs list's own
   *  "loading" gate, so an empty result is distinguishable from "not asked". */
  runsLoaded: boolean;

  load: () => Promise<void>;
  create: (input: SubagentInput) => Promise<Subagent | null>;
  update: (id: string, input: SubagentInput) => Promise<Subagent | null>;
  remove: (id: string) => Promise<void>;
  /** Run an agent on a task, by hand (Phase 2.5). Spins `busy[agentId]` for
   *  the duration, then selects the new session so the user lands in the
   *  streaming run. `wait` (optional, the Run modal's toggle) maps straight
   *  through to the command: true holds the call until the first turn goes
   *  idle, false returns as soon as the session exists. Returns the new
   *  session id, or null on failure (the reason is in `error`). */
  runNow: (
    agentId: string,
    task: string,
    projectId?: string | null,
    wait?: boolean | null,
  ) => Promise<string | null>;
  /** Load run history (newest first) into `runs`, optionally scoped to one
   *  agent. History rows keep their `status`, so this is also the refresh
   *  after a run finishes. */
  loadRuns: (agentId?: string | null) => Promise<void>;
  /** Adopt one run (spawned event, or a later history list). Keyed by run id
   *  so a duplicate event is idempotent. */
  ingestRun: (run: SubagentRun) => void;
  clearError: () => void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useSubagentStore = create<SubagentState>((set, get) => {
  /** Mark a key busy for the duration of a mutation, then clear it. */
  const withBusy = async <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    set((s) => ({ busy: { ...s.busy, [key]: true }, error: null }));
    try {
      return await run();
    } finally {
      set((s) => {
        const busy = { ...s.busy };
        delete busy[key];
        return { busy };
      });
    }
  };

  return {
    loaded: false,
    agents: [],
    error: null,
    busy: {},
    runs: {},
    runsLoaded: false,

    load: async () => {
      try {
        set({ agents: await listSubagents(), error: null });
      } catch (err) {
        // A failed boot load must not leave the panel silently empty.
        set({ error: `Failed to load agents: ${errText(err)}` });
      } finally {
        set({ loaded: true });
      }
    },

    create: async (input) => {
      return withBusy(SUBAGENT_NEW_KEY, async () => {
        try {
          const agent = await createSubagent(input);
          if (agent) {
            set((s) => ({
              agents: [...s.agents.filter((a) => a.id !== agent.id), agent],
              error: null,
            }));
          }
          return agent;
        } catch (err) {
          set({ error: `Couldn't create the agent: ${errText(err)}` });
          return null;
        }
      });
    },

    // Refetch rather than patch locally: the backend normalizes the name
    // (slug, reserved builtin names) and clamps max_rounds, so the row that
    // comes back is the truth the next render should show.
    update: async (id, input) => {
      return withBusy(id, async () => {
        try {
          const agent = await updateSubagent(id, input);
          set({ error: null });
          await get().load();
          return agent;
        } catch (err) {
          set({ error: `Couldn't save the agent: ${errText(err)}` });
          return null;
        }
      });
    },

    // Optimistic: the row leaves the list the moment the delete is issued and
    // comes back on a failure, so a refused builtin delete or a live-run
    // refusal restores the row next to the error that explains it.
    remove: async (id) => {
      const before = get().agents;
      set((s) => ({ agents: s.agents.filter((a) => a.id !== id), error: null }));
      try {
        await deleteSubagent(id);
      } catch (err) {
        set({ agents: before, error: `Couldn't delete the agent: ${errText(err)}` });
      }
    },

    ingestRun: (run) => set((s) => ({ runs: { ...s.runs, [run.id]: run } })),

    clearError: () => set({ error: null }),

    // Manual run (Phase 2.5). `run_subagent` is a thin fresh spawn path, not
    // the mesh param: it works with Session Mesh off and does NOT consume the
    // mesh's per-parent child budget.
    runNow: async (agentId, task, projectId, wait) => {
      // Keyed by the agent id so the panel's Run button and the modal's submit
      // both read `busy[agentId]` — the same key a save uses, which is
      // correct: one agent is one budget (maxConcurrent), so the two must not
      // overlap.
      return withBusy(agentId, async () => {
        try {
          const sessionId = await runSubagent(
            agentId,
            task,
            projectId ?? null,
            wait ?? null,
          );
          if (!sessionId) {
            set({ error: "The run didn't return a session — nothing was started." });
            return null;
          }
          // The chat store is imported lazily: state/chat → meshSlice → this
          // slice is a cycle, and the registry tests must not have to boot the
          // whole chat store just to import the subagent slice.
          try {
            const { useChatStore } = await import("./chat");
            // The session row was created backend-side, so the sidebar list
            // doesn't have it yet — load first or selectSession opens an
            // empty chat.
            await useChatStore.getState().loadSessions();
            await useChatStore.getState().selectSession(sessionId);
          } catch (err) {
            // The run itself started; failing to navigate into it is not a
            // run failure. Say so, but still hand back the id — the caller
            // can open the session from the runs list.
            set({ error: `The run started, but couldn't open it: ${errText(err)}` });
          }
          return sessionId;
        } catch (err) {
          set({ error: `Couldn't run the agent: ${errText(err)}` });
          return null;
        }
      });
    },

    loadRuns: async (agentId) => {
      try {
        const rows = await listSubagentRuns(agentId ?? null, null);
        set((s) => {
          // Merge, don't replace: a run ingested live from the spawn event
          // may not be in the history page yet (or may carry a fresher
          // status than the row we just read).
          const runs = { ...s.runs };
          for (const r of rows) runs[r.id] = r;
          return { runs, runsLoaded: true };
        });
      } catch (err) {
        set({ error: `Couldn't load run history: ${errText(err)}`, runsLoaded: true });
      }
    },
  };
});
