// Dev-only harness: the REAL KnowledgePanel (Settings → Knowledge) on top of
// a stubbed docs_* IPC, so the embedding-model picker (family × quantization
// optgroups), the corpus list, and the suggestion rows can be driven and
// screenshotted without the Rust backend. Serve `npx vite`, open
// http://localhost:1500/knowledge-harness.html.
import React from "react";
import { createRoot } from "react-dom/client";
import { KnowledgePanel } from "../components/settings/KnowledgePanel";
import "../styles/global.css";

// ---- Stubbed IPC ------------------------------------------------------------

const MB = 1024 * 1024;

const STUB_CORPORA = [
  {
    id: "corp-1",
    name: "Ultimate-workspace",
    path: "D:\\projects\\Ultimate-workspace",
    enabled: true,
    createdAt: Date.now() - 6 * 86_400_000,
    lastIndexedAt: Date.now() - 5 * 86_400_000,
    fileCount: 505,
    chunkCount: 5355,
  },
  {
    id: "corp-2",
    name: "trading",
    path: "D:\\projects\\trading",
    enabled: true,
    createdAt: Date.now() - 2 * 86_400_000,
    lastIndexedAt: null,
    fileCount: 0,
    chunkCount: 0,
  },
];

const STUB_EMBED_MODELS = [
  {
    path: "D:\\local models\\models\\rag\\bge-small-en-v1.5.Q8_0.gguf",
    filename: "bge-small-en-v1.5.Q8_0.gguf",
    family: "bge-small-en-v1.5",
    quantization: "Q8_0",
    sizeBytes: 34 * MB,
    architecture: "bert",
    modifiedMs: Date.now() - 20 * 86_400_000,
  },
  {
    path: "D:\\local models\\models\\rag\\embeddinggemma-2-F16.gguf",
    filename: "embeddinggemma-2-F16.gguf",
    family: "embeddinggemma-2",
    quantization: "F16",
    sizeBytes: 558 * MB,
    architecture: "gemma-embedding2",
    modifiedMs: Date.now() - 86_400_000,
  },
  {
    path: "D:\\local models\\models\\rag\\embeddinggemma-2-UD-Q4_K_XL.gguf",
    filename: "embeddinggemma-2-UD-Q4_K_XL.gguf",
    family: "embeddinggemma-2",
    quantization: "UD-Q4_K_XL",
    sizeBytes: 176 * MB,
    architecture: "gemma-embedding2",
    modifiedMs: Date.now() - 86_400_000,
  },
  {
    path: "D:\\local models\\models\\nomic-embed-text-v1.5.F16.gguf",
    filename: "nomic-embed-text-v1.5.F16.gguf",
    family: "nomic-embed-text-v1.5",
    quantization: "F16",
    sizeBytes: 167 * MB,
    architecture: "nomic-bert",
    modifiedMs: Date.now() - 60 * 86_400_000,
  },
  {
    path: "D:\\local models\\models\\nomic-embed-text-v1.5.Q8_0.gguf",
    filename: "nomic-embed-text-v1.5.Q8_0.gguf",
    family: "nomic-embed-text-v1.5",
    quantization: "Q8_0",
    sizeBytes: 84 * MB,
    architecture: "nomic-bert",
    modifiedMs: Date.now() - 60 * 86_400_000,
  },
];

// Per-repo catalog entries for the suggestion sheet (real-shaped CatalogEntry
// records so the detail modal shows variant rows with sizes).
const STUB_CATALOG: Record<string, [string, string, number][]> = {
  "nomic-ai/nomic-embed-text-v1.5-GGUF": [
    ["nomic-embed-text-v1.5.Q8_0.gguf", "Q8_0", 84],
    ["nomic-embed-text-v1.5.F16.gguf", "F16", 167],
  ],
  "unsloth/embeddinggemma-2-GGUF": [
    ["embeddinggemma-2-UD-Q4_K_XL.gguf", "UD-Q4_K_XL", 176],
    ["embeddinggemma-2-Q8_0.gguf", "Q8_0", 310],
    ["embeddinggemma-2-F16.gguf", "F16", 558],
  ],
  "nomic-ai/nomic-embed-text-v1-GGUF": [
    ["nomic-embed-text-v1.Q8_0.gguf", "Q8_0", 70],
  ],
  "CompendiumLabs/bge-small-en-v1.5-gguf": [
    ["bge-small-en-v1.5.Q8_0.gguf", "Q8_0", 34],
  ],
};

let embedChoice = ""; // mirrors docs.embedding_model ("" = auto)

function catalogEntries(repo: string) {
  const files = STUB_CATALOG[repo] ?? [];
  return files.map(([filename, quant, mb]): unknown => ({
    id: `${repo}::${filename}`,
    displayName: String(filename).replace(/\.gguf$/i, ""),
    author: repo.split("/")[0],
    repoId: repo,
    filename,
    downloads: 12_345,
    likes: 678,
    lastModified: "2026-09-01T00:00:00Z",
    sizeBytes: Number(mb) * MB,
    description: null,
    tags: ["embeddings"],
    sha256: null,
    downloadUrl: `https://huggingface.co/${repo}/resolve/main/${filename}`,
    vision: false,
    paramsLabel: null,
    quantization: quant,
    license: "apache-2.0",
    gated: false,
  }));
}

const w = window as unknown as Record<string, unknown>;
// @tauri-apps/api's event module unlistens through this internal — provide a
// no-op so panel unmounts don't throw in the stub.
(w as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  registerListener: () => Promise.resolve(),
  unregisterListener: () => undefined,
};
w.__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => {
    const id = `cb${Math.random().toString(36).slice(2)}`;
    w[id] = cb;
    return id;
  },
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "docs_list_corpora":
        return Promise.resolve(STUB_CORPORA);
      case "docs_list_embedding_models":
        return Promise.resolve(STUB_EMBED_MODELS);
      case "docs_embedding_status":
        return Promise.resolve({
          modelPath: embedChoice
            ? STUB_EMBED_MODELS.find((m) => m.path === embedChoice)?.path ?? embedChoice
            : "D:\\local models\\models\\nomic-embed-text-v1.5.Q8_0.gguf",
          running: false,
          baseUrl: null,
          reranker: { modelPath: null, running: false, baseUrl: null },
        });
      case "docs_set_embedding_model":
        embedChoice = String(args?.path ?? "");
        return Promise.resolve(embedChoice || null);
      case "get_setting": {
        const key = String(args?.key ?? "");
        if (key === "docs.embedding_model") return Promise.resolve(embedChoice || null);
        if (key === "docs.rerank") return Promise.resolve("false");
        return Promise.resolve(null);
      }
      case "set_setting":
        if (String(args?.key) === "docs.embedding_model") embedChoice = String(args?.value ?? "");
        return Promise.resolve(undefined);
      case "fetch_model_catalog": {
        const repo = String(args?.query ?? "");
        return Promise.resolve({
          entries: catalogEntries(repo),
          hasHuggingFaceToken: true,
        });
      }
      case "fetch_model_file_sizes":
        return Promise.resolve({});
      case "get_gpu_vram":
        return Promise.resolve({ totalVramBytes: 16 * 1024 * MB, deviceName: "RTX (stub)" });
      case "start_model_download":
        return Promise.resolve(undefined);
      case "plugin:event|listen":
      case "plugin:event|unlisten":
        return Promise.resolve(0);
      default:
        console.debug(`[knowledgeHarness] invoke("${cmd}") → null`);
        return Promise.resolve(null);
    }
  },
  metadata: { currentWindow: { label: "stub" }, currentWebview: { label: "stub" } },
};

// ---- Mount inside the settings modal shell (SettingsView markup) ------------

// The app applies its palette via data-theme on <html> (useTheme) — default
// the harness to the production dark look.
document.documentElement.setAttribute("data-theme", "dark");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="view-panel settings-modal" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="view-header">
        <div>
          <h2>Settings</h2>
          <span className="settings-header-sub">Local folders (RAG)</span>
        </div>
        <button className="ghost">✕</button>
      </div>
      <div className="view-body" style={{ flex: 1, minHeight: 0 }}>
        <div className="settings-split">
          <nav className="settings-nav">
            <div className="settings-search">
              <input type="text" placeholder="Search settings…" aria-label="Search settings" readOnly />
            </div>
            <div className="settings-nav-section">
              <div className="settings-nav-section-title">General</div>
              <button className="nav-item"><span className="nav-item-label">Appearance</span></button>
              <button className="nav-item"><span className="nav-item-label">Notifications</span></button>
              <button className="nav-item"><span className="nav-item-label">Assistant</span></button>
              <button className="nav-item"><span className="nav-item-label">Improvements</span></button>
            </div>
            <div className="settings-nav-section">
              <div className="settings-nav-section-title">Models &amp; providers</div>
              <button className="nav-item"><span className="nav-item-label">API Keys</span></button>
              <button className="nav-item"><span className="nav-item-label">Web Search</span></button>
              <button className="nav-item"><span className="nav-item-label">Local Models</span></button>
            </div>
          </nav>
          <div className="settings-panel">
            <KnowledgePanel />
          </div>
        </div>
      </div>
    </div>
  </React.StrictMode>,
);
