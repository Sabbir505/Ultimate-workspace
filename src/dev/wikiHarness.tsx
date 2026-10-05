// Dev-only harness: the REAL WikiView on top of the Tauri IPC stub, so the
// project rail (select + arm-to-delete button) can be driven and screenshotted
// without the Rust backend. Serve `npx vite`, open
// http://localhost:1500/wiki-harness.html. Exposes window.__wiki (the wiki
// store) for assertions.
import "./tauriStub";
import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import App from "../App";
import "../styles/global.css";
import { useUiStore } from "../state/ui";
import { useProjectsStore } from "../state/projects";
import { useWikiStore } from "../state/wiki";
import type { Project } from "../types";
import type { WikiPageFull, WikiProjectSummary, WikiStatus } from "../lib/ipc/wiki";

const WIKI_PATH = "D:\\local models";

const STUB_PROJECT: Project = {
  id: "p1",
  path: WIKI_PATH,
  name: "local models",
  isGitRepo: true,
  createdAt: Date.now() - 86_400_000,
  lastOpenedAt: Date.now(),
};

const STUB_PROJECTS: Project[] = [
  STUB_PROJECT,
  {
    id: "p2",
    path: "D:\\projects\\Content-management",
    name: "Content-management",
    isGitRepo: true,
    createdAt: Date.now() - 2 * 86_400_000,
    lastOpenedAt: Date.now() - 3_600_000,
  },
  {
    id: "p3",
    path: "D:\\projects\\trading",
    name: "trading",
    isGitRepo: false,
    createdAt: Date.now() - 5 * 86_400_000,
    lastOpenedAt: Date.now() - 86_400_000,
  },
];

const STUB_SUMMARIES: WikiProjectSummary[] = [
  {
    path: WIKI_PATH,
    pageCount: 6,
    staleCount: 0,
    builtAt: Math.floor(Date.now() / 1000) - 3600,
    buildModel: "harness:commandcode",
  },
];

const STUB_PAGE: WikiPageFull = {
  id: "page1",
  slug: "overview",
  title: "Overview",
  kind: "overview",
  summary: "What this project is.",
  status: "fresh",
  staleReason: null,
  generatedAt: Math.floor(Date.now() / 1000) - 3600,
  generatedBy: "harness:commandcode",
  body: "# Local models\n\nA workspace for running local GGUF models.",
  brief: "Cover the project.",
  files: ["README.md"],
  claims: [
    {
      claim: "The repo runs GGUF models.",
      evidencePath: "README.md",
      lineStart: 1,
      lineEnd: 2,
      blobSha: "abc12345",
    },
  ],
};

const STUB_STATUS: WikiStatus = {
  project: {
    id: "wp1",
    path: WIKI_PATH,
    headSha: "deadbeef",
    schemaVersion: 0,
    builtAt: Math.floor(Date.now() / 1000) - 3600,
    lastUpdateAt: null,
    buildModel: "harness:commandcode",
  },
  pages: [
    {
      id: "page1",
      slug: "overview",
      title: "Overview",
      kind: "overview",
      summary: "What this project is.",
      status: "fresh",
      staleReason: null,
      generatedAt: Math.floor(Date.now() / 1000) - 3600,
      generatedBy: "harness:commandcode",
    },
  ],
  autoUpdate: true,
  layerIndex: true,
  hasModel: true,
  jobRunning: false,
};

// wiki_remove mutates the seeds so the rail actually loses the row, and
// records every call so the harness can assert how many invokes a delete took.
const removeLog: string[] = [];

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const internals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as unknown as {
  invoke: InvokeFn;
};
const baseInvoke = internals.invoke.bind(internals);
internals.invoke = (cmd: string, args?: Record<string, unknown>) => {
  switch (cmd) {
    case "list_projects":
      return Promise.resolve(removeLog.length === 0 ? STUB_PROJECTS : []);
    case "list_sessions":
      return Promise.resolve([]);
    case "list_harnesses":
      return Promise.resolve([]);
    case "git_status_batch":
      return Promise.resolve({});
    case "wiki_list_all":
      return Promise.resolve(removeLog.length === 0 ? STUB_SUMMARIES : []);
    case "wiki_get":
      return Promise.resolve(removeLog.length === 0 ? STUB_STATUS : null);
    case "wiki_read_page":
      return Promise.resolve(removeLog.length === 0 ? STUB_PAGE : null);
    case "wiki_remove": {
      const path = String(args?.path ?? "");
      removeLog.push(path);
      return Promise.resolve(true);
    }
    default:
      return baseInvoke(cmd, args);
  }
};

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

(window as unknown as Record<string, unknown>).__ui = useUiStore;
(window as unknown as Record<string, unknown>).__projects = useProjectsStore;
(window as unknown as Record<string, unknown>).__wiki = useWikiStore;
(window as unknown as Record<string, unknown>).__wikiRemoveLog = removeLog;

useProjectsStore.setState({
  loaded: true,
  projects: STUB_PROJECTS,
  selectedProjectId: STUB_PROJECT.id,
});
useUiStore.getState().setActiveView("wiki");
useWikiStore.setState({ allSummaries: STUB_SUMMARIES });
