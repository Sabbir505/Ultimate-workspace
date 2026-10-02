// Project wiki (§6.15) — IPC wrappers.
//
// Backend contract lives in src-tauri/src/wiki/ (mod.rs engine, commands.rs,
// tools_impl.rs) and src-tauri/src/db/wiki.rs. Commands are registered in
// src-tauri/src/lib.rs::invoke_handler. The `search_wiki` / `read_wiki_page`
// model tools (auto-exposed when the bound project has a built wiki) consume
// the same store from the chat tool loop — see ToolCaps.wiki.

import { safeInvoke, safeListenChecked } from "../ipcCore";

export interface WikiProject {
  id: string;
  path: string;
  headSha: string | null;
  schemaVersion: number;
  builtAt: number | null;
  lastUpdateAt: number | null;
  buildModel: string | null;
}

export type WikiPageStatus = "fresh" | "stale" | "rebuilding" | "failed";

export interface WikiPage {
  id: string;
  slug: string;
  title: string;
  kind: string;
  summary: string;
  status: WikiPageStatus;
  staleReason: string | null;
  generatedAt: number;
  generatedBy: string | null;
}

export interface WikiClaim {
  claim: string;
  evidencePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  blobSha: string | null;
}

export interface WikiPageFull extends WikiPage {
  body: string;
  brief: string;
  files: string[];
  claims: WikiClaim[];
}

export interface WikiStatus {
  project: WikiProject | null;
  pages: WikiPage[];
  autoUpdate: boolean;
  layerIndex: boolean;
  /** Whether ANY wiki build model resolves right now — drives the empty
   *  state's hint instead of a doomed Build button. */
  hasModel: boolean;
  /** A build/update job is in the backend registry RIGHT NOW — covers the
   *  cases the live progress store can't see (app reload mid-build, a job
   *  that started before this surface mounted). */
  jobRunning: boolean;
}

export interface WikiProgress {
  path: string;
  mode: "build" | "update";
  state: "running" | "done" | "cancelled" | "error";
  phase: "analysis" | "outline" | "pages" | "finalizing";
  pageSlug: string | null;
  pagesDone: number;
  pagesTotal: number;
  error: string | null;
  /** Human step text ("Exploring the project structure", "Wrote page: Mesh
   *  (2/4)") — the surfaces render these as a live step feed. */
  step: string | null;
}

export interface WikiUpdateReport {
  status: "updated" | "up_to_date" | "rebuilt" | "not_git" | "no_wiki";
  pagesRefreshed: number;
  changedPaths: number;
}

export interface WikiProjectSummary {
  path: string;
  pageCount: number;
  staleCount: number;
  builtAt: number | null;
  buildModel: string | null;
}

/** Per-wiki rollups for the tool panel's project list. */
export const wikiListAll = () =>
  safeInvoke<WikiProjectSummary[] | null>("wiki_list_all");

export const wikiGet = (path: string) =>
  safeInvoke<WikiStatus | null>("wiki_get", { path });

/** Kick off a full build in the background. Progress arrives via
 *  `onWikiBuildProgress`; errors land there too (the command itself only
 *  fails fast on the synchronous mistakes: no model / double build). */
export const wikiBuildStart = (path: string) =>
  safeInvoke<void>("wiki_build_start", { path });

export const wikiCancel = (path: string) =>
  safeInvoke<boolean>("wiki_cancel", { path });

/** Run the freshness pass now (the "Update now" button). Usually fast: the
 *  diff runs before any model call, so up-to-date wikis return at once. */
export const wikiUpdate = (path: string) =>
  safeInvoke<WikiUpdateReport | null>("wiki_update", { path });

export const wikiReadPage = (path: string, slug: string) =>
  safeInvoke<WikiPageFull | null>("wiki_read_page", { path, slug });

export const wikiRemove = (path: string) =>
  safeInvoke<boolean>("wiki_remove", { path });

/** Stream `wiki:build:progress` events for an in-flight build/update. */
export const onWikiBuildProgress = (handler: (p: WikiProgress) => void) =>
  safeListenChecked<WikiProgress>("wiki:build:progress", handler);
