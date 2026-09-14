// Design-QA verdicts for generated documents, keyed by artifact path. The
// `chat:doc-qa` event (emitted after plan_document finishes its render
// probes) lands here; the artifact preview pane reads the entry for the
// currently previewed artifact and shows the QA strip.
import { create } from "zustand";
import type { DocQaReportPayload } from "../lib/ipc";

export type DocQaReport = DocQaReportPayload;

/** Cap on cached verdicts: every generated document adds an entry, and the
 *  map used to grow for the whole app run. Oldest-inserted paths evict first
 *  (re-QA of the same path refreshes its slot); the pane only ever reads the
 *  currently previewed artifact's entry. */
const DOC_QA_CAP = 50;

interface DocQaState {
  byPath: Record<string, DocQaReport>;
  put: (report: DocQaReport) => void;
  clear: (path: string) => void;
}

export const useDocQaStore = create<DocQaState>((set) => ({
  byPath: {},
  put: (report) =>
    set((state) => {
      // Delete-then-set so a re-QA'd document keeps the newest position.
      const prior = { ...state.byPath };
      delete prior[report.path];
      const byPath = { ...prior, [report.path]: report };
      const paths = Object.keys(byPath);
      if (paths.length > DOC_QA_CAP) {
        for (const stale of paths.slice(0, paths.length - DOC_QA_CAP)) {
          delete byPath[stale];
        }
      }
      return { byPath };
    }),
  clear: (path) =>
    set((state) => {
      if (!(path in state.byPath)) return state;
      const next = { ...state.byPath };
      delete next[path];
      return { byPath: next };
    }),
}));
