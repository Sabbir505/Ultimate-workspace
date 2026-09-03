// Design-QA verdicts for generated documents, keyed by artifact path. The
// `chat:doc-qa` event (emitted after plan_document finishes its render
// probes) lands here; the artifact preview pane reads the entry for the
// currently previewed artifact and shows the QA strip.
import { create } from "zustand";
import type { DocQaReportPayload } from "../lib/ipc";

export type DocQaReport = DocQaReportPayload;

interface DocQaState {
  byPath: Record<string, DocQaReport>;
  put: (report: DocQaReport) => void;
  clear: (path: string) => void;
}

export const useDocQaStore = create<DocQaState>((set) => ({
  byPath: {},
  put: (report) =>
    set((state) => ({ byPath: { ...state.byPath, [report.path]: report } })),
  clear: (path) =>
    set((state) => {
      if (!(path in state.byPath)) return state;
      const next = { ...state.byPath };
      delete next[path];
      return { byPath: next };
    }),
}));
