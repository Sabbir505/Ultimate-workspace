// Artifacts library store: the persistent list of generated files/diagrams
// shown in the chat sidebar. Backed by SQLite with a 30-day retention window
// (expired rows are swept on app startup by the backend).
import { create } from "zustand";
import {
  deleteAllArtifacts,
  deleteArtifact,
  listArtifacts,
  type ArtifactRecord,
} from "../lib/ipc";

interface ArtifactsState {
  loaded: boolean;
  items: ArtifactRecord[];
  load: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Delete every artifact (Settings → Data) and clear the in-memory list so
   *  the sidebar reflects the deletion immediately. */
  clearAll: () => Promise<number>;
}

export type { ArtifactsState };

export const useArtifactsStore = create<ArtifactsState>((set, get) => ({
  loaded: false,
  items: [],

  load: async () => {
    const items = (await listArtifacts()) ?? [];
    set({ items, loaded: true });
  },

  remove: async (id: string) => {
    await deleteArtifact(id);
    set({ items: get().items.filter((a: ArtifactRecord) => a.id !== id) });
  },

  clearAll: async () => {
    const count = await deleteAllArtifacts();
    set({ items: [], loaded: true });
    return count;
  },
}));
