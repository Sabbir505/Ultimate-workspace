// Bot-pet home store.
//
// Each docked BOT pet lives in exactly ONE home at a time — the search bar
// ("sidebar") or a composer home ("main", or a split pane's "pane-N") — and the
// user moves ONE pet at a time by dragging it to the other home (BotPetDock).
// The map is per bot id, so dragging the panda never moves the cat.
//
// Deliberately tiny and separate from the retired companion-pet store
// (state/pet.ts): bot pets are the pet system now.
import { create } from "zustand";

const STORAGE_KEY = "relay.botPets.v2";

/** The home a bot's pet lives in when it has never been moved. */
export const DEFAULT_PET_HOME = "sidebar";

function loadHomes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [id, home] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof home === "string" && home) out[id] = home;
    }
    return out;
  } catch {
    return {};
  }
}

function saveHomes(homes: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(homes));
  } catch {
    // Storage unavailable — the choices live for this session only.
  }
}

interface BotPetHomeState {
  /** botId → home ("sidebar" / "main" / "pane-N"). Absent = DEFAULT_PET_HOME. */
  homes: Record<string, string>;
  /** The bot id whose pet is being dragged between homes, or null. Both docks
   *  stay mounted as drop targets for the duration. */
  dragging: string | null;
  setHome: (botId: string, home: string) => void;
  beginDrag: (botId: string) => void;
  endDrag: () => void;
}

export const useBotPetHome = create<BotPetHomeState>((set, get) => ({
  homes: loadHomes(),
  dragging: null,
  setHome: (botId, home) => {
    if (!botId || !home) return;
    const homes = { ...get().homes, [botId]: home };
    saveHomes(homes);
    set({ homes });
  },
  beginDrag: (botId) => {
    if (get().dragging !== botId) set({ dragging: botId });
  },
  endDrag: () => {
    if (get().dragging !== null) set({ dragging: null });
  },
}));

/** The home a given bot's pet currently lives in. */
export function petHomeOf(homes: Record<string, string>, botId: string): string {
  return homes[botId] ?? DEFAULT_PET_HOME;
}
