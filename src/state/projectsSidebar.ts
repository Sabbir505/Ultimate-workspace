// Projects sidebar panel state: whether the second (Projects) sidebar is
// open next to the main sidebar, and which projects the user has "stashed".
// A stashed project drops to the bottom of the list (and stays there) until
// unstashed — a pure UI preference, so it persists to localStorage rather
// than earning a backend column: the projects store has no schema for it and
// the arrangement must survive an app restart to be useful.
import { create } from "zustand";

const STORAGE_KEY = "relay.projectsSidebar.v1";

interface PersistedShape {
  open: boolean;
  /** Stashed project ids, in stash order (order is stable across restarts). */
  stashed: string[];
}

function loadPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { open: false, stashed: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedShape> | null;
    return {
      open: parsed?.open === true,
      stashed: Array.isArray(parsed?.stashed)
        ? (parsed.stashed as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    // Corrupt blob — treat as first run rather than blocking the panel.
    return { open: false, stashed: [] };
  }
}

function persist(s: { open: boolean; stashed: string[] }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage full/unavailable — the panel still works this session */
  }
}

interface ProjectsSidebarState {
  /** Is the Projects panel open beside the main sidebar? */
  open: boolean;
  /** Project ids currently stashed (render at the bottom of the list). */
  stashed: string[];
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  /** Stash (or unstash) a project — moves it to (or back from) the bottom. */
  toggleStashed: (projectId: string) => void;
}

export const useProjectsSidebarStore = create<ProjectsSidebarState>((set, get) => {
  const boot = loadPersisted();
  persist(boot);
  return {
    open: boot.open,
    stashed: boot.stashed,

    setOpen: (open) => {
      persist({ open, stashed: get().stashed });
      set({ open });
    },

    toggleOpen: () => {
      const open = !get().open;
      persist({ open, stashed: get().stashed });
      set({ open });
    },

    toggleStashed: (projectId) => {
      const stashed = get().stashed.includes(projectId)
        ? get().stashed.filter((id) => id !== projectId)
        : [...get().stashed, projectId];
      persist({ open: get().open, stashed });
      set({ stashed });
    },
  };
});
