// Dev-only visual harness: reproduces the "dragging the vault's resize
// dividers breaks the layout" report and verifies the px floors. Static DOM
// with the REAL class chain (.vault-view → .vault-body → .vault-center-split
// → .vault-note-split → .vault-note-panes → editor/preview panes + rails)
// and the real drag semantics (dx → rail px / split pct, clamped like the
// vault store). Serve `npx vite`, open
// http://localhost:1500/vault-resize-harness.html and use the control box
// (top-left) or call window.__harness.* from devtools / automation.
import "../styles/global.css";

const W = {
  left: 250,
  right: 272,
  notePct: 50,
  assetPct: 40,
};
const CLAMP = {
  left: { min: 250, max: 400 },
  right: { min: 250, max: 400 },
  pct: { min: 20, max: 80 },
};
// Same px-floor clamp as state/vault.ts (clampNoteSplitPct /
// clampAssetSplitPct) — duplicated here so the harness stays dependency-free.
const EDITOR_MIN = 220;
const PREVIEW_MIN = 260;
const ASSET_MIN = 200;
const HEAD_PX = 40;
const HANDLE_PX = 6;
const clampPct = (v: number, fb: number) => Math.min(80, Math.max(20, Number.isFinite(v) ? Math.round(v) : fb));
function clampNoteSplit(pct: number, panesW: number): number {
  const v = clampPct(pct, 50);
  const w = Math.max(1, panesW);
  return Math.min(100 - ((PREVIEW_MIN + HANDLE_PX) / w) * 100, Math.max((EDITOR_MIN / w) * 100, v));
}
function clampAssetSplit(pct: number, centerW: number, assetMin: number): number {
  const v = clampPct(pct, 58);
  const noteMin = HEAD_PX + EDITOR_MIN + HANDLE_PX + PREVIEW_MIN + HANDLE_PX;
  if (centerW > assetMin + noteMin + 12) {
    return Math.min(100 - (noteMin / centerW) * 100, Math.max((assetMin / centerW) * 100, v));
  }
  return v;
}

function el(tag: string, cls: string | null, parent: HTMLElement | null, html?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  parent?.appendChild(n);
  return n;
}

function buildVault(): HTMLElement {
  const app = el("div", "app", document.getElementById("root"));
  const main = el("div", "main", app);
  const grid = el("div", "grid-wrap chat-grid-wrap", main);
  grid.style.height = "100vh";
  grid.id = "h-grid";

  const view = el("div", "vault-view", grid);
  view.id = "h-vault-view";

  const header = el("header", "vault-header", view);
  el("div", "vault-header-left", header, `<span class="vault-title">Demo Vault</span><span class="vault-stats-chip">3 notes · 2 links</span>`);
  el("div", "vault-header-actions", header);

  const body = el("div", "vault-body", view);

  // Left rail (files)
  const left = el("aside", "vault-left-rail", body);
  left.id = "h-left-rail";
  const leftInner = el("div", "vault-rail-inner", left);
  el("div", "vault-rail-tabs", leftInner, `<button class="active">Files</button><button>Search</button><button>Tags</button><button class="vault-rail-collapse">⇤</button>`);
  el(
    "div",
    "vault-file-tree",
    leftInner,
    ["Linear Regression in ML.md", "assets", "Gradient Descent Notes.md", "Datasets.md"]
      .map((n) => `<div class="vault-tree-main">${n}</div>`)
      .join(""),
  );

  el("div", "vault-resize-handle", body).dataset.handle = "left";

  // Center: asset + note side by side, note split into editor|preview
  const center = el("main", "vault-center", body);
  const split = el("div", "vault-center-split", center);
  split.id = "h-center-split";

  const asset = el("div", "vault-asset-pane", split);
  asset.id = "h-asset-pane";
  el("div", "vault-pdf-toolbar-placeholder", asset, `<div style="padding:8px 10px;border-bottom:1px solid var(--border);font-size:11.5px;color:var(--text-dim)">ml-linear-regression.pdf</div>`);
  const assetBody = el("div", "vault-asset-body", asset);
  assetBody.style.cssText = "flex:1;overflow:auto;padding:16px;color:var(--text-dim);font-size:12px";
  assetBody.innerHTML = `<p>PDF page (asset pane — floor 380px with a pdf, 200px otherwise; this harness runs the 200px floor by using a generic asset).</p>`;

  const assetHandle = el("div", "vault-resize-handle", split);
  assetHandle.dataset.handle = "asset";

  const noteSplit = el("div", "vault-note-split mode-split", split);
  noteSplit.id = "h-note-split";
  el(
    "div",
    "vault-note-head",
    noteSplit,
    `<span class="vault-note-path">Linear Regression in ML.md</span>
     <div class="vault-mode-switch"><button><svg width="13" height="13"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg></button><button class="active"><svg width="13" height="13"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><line x1="15" y1="3" x2="15" y2="21" stroke="currentColor" stroke-width="2"/></svg></button></div>
     <button class="vault-rail-toggle"><svg width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><line x1="15" y1="3" x2="15" y2="21" stroke="currentColor" stroke-width="2"/></svg></button>`,
  );
  const panes = el("div", "vault-note-panes split", noteSplit);
  panes.id = "h-note-panes";
  const editor = el("div", "vault-editor-pane", panes);
  editor.id = "h-editor-pane";
  el("div", "vault-editor-toolbar", editor, `<button>#</button><button>B</button><button>I</button><button>code</button>`);
  const editorBody = el("div", "vault-editor", editor);
  editorBody.style.cssText = "padding:10px;color:var(--text);font-family:var(--font-mono,monospace);font-size:12px";
  editorBody.innerHTML = `<p># Linear Regression</p><p>y = wx + b — the editor pane.</p>`;
  const noteHandle = el("div", "vault-resize-handle", panes);
  noteHandle.dataset.handle = "note";
  const preview = el("div", "vault-preview-pane", panes);
  preview.id = "h-preview-pane";
  el(
    "div",
    "vault-preview",
    preview,
    `<h1>Linear Regression</h1><p>The reading pane. Drag the divider hard left/right — this pane must never drop below its 260px floor, the editor below 220px.</p>`,
  );

  const rightHandle = el("div", "vault-resize-handle", body);
  rightHandle.dataset.handle = "right";

  // Right rail (outline / backlinks)
  const right = el("aside", "vault-right-rail", body);
  right.id = "h-right-rail";
  el(
    "div",
    "vault-outline",
    right,
    `<div style="padding:10px;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em">Outline</div>` +
      ["Linear Regression", "Least squares", "Gradient descent", "Normal equation", "Backlinks"]
        .map((h) => `<div class="vault-outline-row">${h}</div>`)
        .join(""),
  );

  applyLayout();
  return body;
}

/** Simulated tool panel state — null = closed (var 0, no sibling). */
let panelW: number | null = null;

function applyLayout() {
  const left = document.getElementById("h-left-rail")!;
  left.style.width = `${W.left}px`;
  left.style.minWidth = `${CLAMP.left.min}px`;
  left.style.maxWidth = `${CLAMP.left.max}px`;
  const right = document.getElementById("h-right-rail")!;
  right.style.width = `${W.right}px`;
  right.style.minWidth = `${CLAMP.right.min}px`;
  right.style.maxWidth = `${CLAMP.right.max}px`;
  applyToolPanel();
  // Re-clamp the note split against the post-squeeze panes width (same as
  // VaultView's ResizeObserver re-clamp).
  const panesW = (document.getElementById("h-note-panes") as HTMLElement).getBoundingClientRect().width;
  W.notePct = clampNoteSplit(W.notePct, panesW);
  (document.getElementById("h-asset-pane") as HTMLElement).style.flex = `0 1 ${W.assetPct}%`;
  (document.getElementById("h-editor-pane") as HTMLElement).style.flex = `0 0 ${W.notePct}%`;
}

/** Mirror the shell: the panel takes its stored width and flexbox shrinks
 *  the RENDERED box when the vault's CSS floor demands the room (the real
 *  .tool-panel is flex-shrink:1, min-width:240px). */
function applyToolPanel() {
  const grid = document.getElementById("h-grid")!;
  let panel = document.getElementById("h-tool-panel") as HTMLElement | null;
  if (panelW == null) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = el("aside", "tool-panel", grid);
    panel.id = "h-tool-panel";
    panel.innerHTML = `<div style="padding:40px 16px;color:var(--text-dim);font-size:12px">Tool panel (simulated — terminals/browser live here)</div>`;
  }
  panel.style.width = `${panelW}px`;
}

/** Simulate a pointer drag on a divider, applying the same deltas the real
 *  ResizeHandle → store setters would (rails ±dx, splits ±dx as pct of the
 *  live container width, clamped like the store incl. the px floors). */
function drag(handleKind: string, dx: number) {
  const body = document.querySelector(".vault-body") as HTMLElement;
  const centerW = (document.querySelector(".vault-center") as HTMLElement).getBoundingClientRect().width;
  const panesW = (document.getElementById("h-note-panes") as HTMLElement).getBoundingClientRect().width;
  if (handleKind === "left") W.left = Math.min(CLAMP.left.max, Math.max(CLAMP.left.min, W.left + dx));
  else if (handleKind === "right") W.right = Math.min(CLAMP.right.max, Math.max(CLAMP.right.min, W.right - dx));
  else if (handleKind === "note") W.notePct = clampNoteSplit(W.notePct + (dx / Math.max(1, panesW)) * 100, panesW);
  else if (handleKind === "asset") W.assetPct = clampAssetSplit(W.assetPct + (dx / Math.max(1, centerW)) * 100, centerW, ASSET_MIN);
  void body;
  applyLayout();
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function measure(): Check[] {
  const checks: Check[] = [];
  const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
  const editor = rect("h-editor-pane");
  const preview = rect("h-preview-pane");
  const split = document.getElementById("h-center-split") as HTMLElement;
  const body = document.querySelector(".vault-body") as HTMLElement;

  checks.push({
    name: "editor ≥ 220px",
    pass: editor.width >= 219.5,
    detail: `${editor.width.toFixed(1)}px`,
  });
  checks.push({
    name: "preview ≥ 260px",
    pass: preview.width >= 259.5,
    detail: `${preview.width.toFixed(1)}px`,
  });
  checks.push({
    name: "asset pane renders (yields under squeeze)",
    pass: rect("h-asset-pane").width >= 0,
    detail: `${rect("h-asset-pane").width.toFixed(1)}px`,
  });
  checks.push({
    name: "no overflow out of the split (layout intact)",
    pass: split.scrollWidth <= split.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1,
    detail: `split scroll ${split.scrollWidth.toFixed(0)} vs client ${split.clientWidth.toFixed(0)}; body scroll ${body.scrollWidth.toFixed(0)} vs client ${body.clientWidth.toFixed(0)}`,
  });
  const right = rect("h-right-rail");
  checks.push({
    name: "outline rail 250–400px",
    pass: right.width >= 249.5 && right.width <= 400.5,
    detail: `${right.width.toFixed(1)}px`,
  });

  // Squeeze checks: with the tool pane open the vault yields, but its CSS
  // floor must hold and nothing may clip out of the view.
  const vaultEl = document.getElementById("h-vault-view") as HTMLElement;
  const vaultRect = vaultEl.getBoundingClientRect();
  const vaultMin = parseFloat(getComputedStyle(vaultEl).minWidth) || 0;
  checks.push({
    name: `vault ≥ its CSS floor (${vaultMin.toFixed(0)}px)`,
    pass: vaultRect.width >= vaultMin - 1,
    detail: `${vaultRect.width.toFixed(1)}px`,
  });
  const leftRect = rect("h-left-rail");
  checks.push({
    name: "files rail ≥ 250px (min holds)",
    pass: leftRect.width >= 249.5,
    detail: `${leftRect.width.toFixed(1)}px`,
  });
  checks.push({
    name: "outline rail ≥ 250px (min holds)",
    pass: right.width >= 249.5,
    detail: `${right.width.toFixed(1)}px`,
  });
  checks.push({
    name: "outline fully inside the view (not clipped)",
    pass: right.width <= 0.5 || vaultRect.right >= right.right - 1,
    detail: `rail right ${(right.right - vaultRect.left).toFixed(1)} vs vault ${vaultRect.width.toFixed(1)}`,
  });
  const centerRect = rect("h-center-split");
  checks.push({
    name: "center ≥ 490px in split mode (panes' floors reserved)",
    pass: centerRect.width >= 489.5,
    detail: `${centerRect.width.toFixed(1)}px`,
  });
  return checks;
}

function renderResults(checks: Check[], scenario: string) {
  const box = document.getElementById("h-results")!;
  box.innerHTML = `<strong>${scenario}</strong><ul>${checks
    .map(
      (c) =>
        `<li style="color:${c.pass ? "#3ecf6f" : "#ff5f56"}">${c.pass ? "PASS" : "FAIL"} — ${c.name} <span style="color:var(--text-dim)">(${c.detail})</span></li>`,
    )
    .join("")}</ul>`;
}

function resetLayout() {
  W.left = 250;
  W.right = 272;
  W.notePct = 50;
  W.assetPct = 40;
  applyLayout();
}

function runScenario(name: string, steps: Array<[string, number]>, resetFirst = true) {
  if (resetFirst) resetLayout();
  for (const [handle, dx] of steps) drag(handle, dx);
  renderResults(measure(), name);
}

function buildControls() {
  const box = el("div", null, document.body);
  box.id = "h-controls";
  box.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:99;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text);width:340px";
  const mk = (label: string, fn: () => void) => {
    const b = el("button", "ghost", box, label);
    b.style.cssText = "cursor:pointer;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface-3);color:var(--text)";
    b.onclick = fn;
  };
  mk("Scenario: drag note divider hard LEFT (−2000px)", () =>
    runScenario("note divider −2000px", [["note", -2000]]),
  );
  mk("Scenario: drag note divider hard RIGHT (+2000px)", () =>
    runScenario("note divider +2000px", [["note", 2000]]),
  );
  mk("Scenario: drag asset divider hard RIGHT (+2000px)", () =>
    runScenario("asset divider +2000px", [["asset", 2000]]),
  );
  mk("Scenario: squeeze left rail to zero (−2000px)", () =>
    runScenario("left rail −2000px", [["left", -2000]]),
  );
  mk("Scenario: bloat right rail (+2000px)", () =>
    runScenario("right rail +2000px", [["right", -2000]]),
  );
  const panelBtn = (label: string, w: number | null) =>
    mk(label, () => {
      panelW = w;
      resetLayout();
      renderResults(measure(), `tool pane ${w == null ? "closed" : `${w}px`} (defaults)`);
    });
  panelBtn("Tool pane: open at 280px", 280);
  panelBtn("Tool pane: open at 532px", 532);
  panelBtn("Tool pane: open at 900px", 900);
  panelBtn("Tool pane: close", null);
  mk("Reset layout", () => {
    resetLayout();
    renderResults(measure(), "reset (defaults)");
  });
  const results = el("div", null, box);
  results.id = "h-results";
  results.style.cssText = "border-top:1px solid var(--border);padding-top:6px;line-height:1.5";
}

buildVault();
buildControls();
renderResults(measure(), "initial (defaults)");

(window as unknown as { __harness: object }).__harness = {
  drag,
  measure,
  runScenario,
  setPanel: (w: number | null) => {
    panelW = w;
    applyLayout();
  },
  widths: W,
  panelWidth: () => panelW,
};
