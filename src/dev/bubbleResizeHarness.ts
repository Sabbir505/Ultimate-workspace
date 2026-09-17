// Dev-only visual harness: reproduces the "user bubble text overflows the
// bubble while resizing the chat|tool-panel splitter" report. Static DOM with
// the REAL class chain (App shell → grid-wrap → chat-view-wrap → chat-view →
// chat-messages → virtual row → chat-bubble.user → chat-bubble-inner →
// msg-user-line → chat-markdown) and the real .tool-panel sibling with its
// inline width + .resizing transition kill, driven by a simulated pointer
// drag. Serve `npx vite`, open
// http://localhost:1500/bubble-resize-harness.html and use the control box
// (top-left) or call window.__harness.* from devtools / automation.
import "../styles/global.css";

const USER_MESSAGE_HTML = `
<p>You are a daily AI/ML/LLM news digest writer for a technical audience. Follow the runbook below to produce a self-contained Markdown file per run.</p>
<h2>STEP 0 — Load skills</h2>
<p>Load the <code>x-posts</code> skill at the start of every run. Use its format menu (A11y) and lint rules when drafting posts.</p>
<h2>STEP 1 — Locate prior digests</h2>
<p>Call <code>list_artifacts</code> with query <code>AI_ML_Daily_News</code> to find the last few digest files. If found, read them and extract the list of covered stories/entities for deduplication. If none exist, note that in the Follow-ups section. 🎉</p>
`;

const PANEL_BODY_HTML = `
<div class="view-header"><h2>AI_ML_Daily_News_2026-09-18.md</h2></div>
<div class="artifact-preview-content" style="padding: 20px; overflow: auto;">
  <h2 style="font-size:20px;margin:0 0 14px;">Blackwell roadmap</h2>
  <hr />
  <h2 style="font-size:18px;margin:18px 0 10px;">Verified Frontier Releases</h2>
  <h3 style="font-size:15px;margin:14px 0 6px;">1. Must-watch models</h3>
  <ul style="margin:0 0 12px 18px;">
    <li>Open-source weight drops and what they change for local agents.</li>
    <li>Pricing moves across the big API providers this week.</li>
    <li>Agent benchmarks: which claims survive replication.</li>
    <li>Small-model distillation results worth copying.</li>
  </ul>
  <h3 style="font-size:15px;margin:14px 0 6px;">2. Also noted</h3>
  <ul style="margin:0 0 12px 18px;">
    <li>Hardware supply notes affecting GPU availability.</li>
  </ul>
</div>
`;

function el(tag: string, cls: string | null, parent: HTMLElement | null, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

const app = el("div", "app", document.getElementById("root")!);
const main = el("div", "main", app);
// A stub toolbar so .main's flex column has its first child (visual parity).
el("div", "toolbar", main, "<strong>Relay</strong><span class='spacer'></span>");

const gridWrap = el("div", "grid-wrap chat-grid-wrap", main);
const chatViewWrap = el("div", "chat-view-wrap", gridWrap);
const chatView = el("div", "chat-view", chatViewWrap);
const messages = el("div", "chat-messages", chatView);
messages.id = "messages";

// Virtualizer internals: height wrapper + one absolutely-positioned row.
const heightWrapper = el(
  "div",
  null,
  messages,
);
heightWrapper.style.cssText = "height: 900px; flex-shrink: 0; position: relative; width: 100%;";
const row = el("div", null, heightWrapper);
row.style.cssText =
  "position: absolute; top: 0; left: 0; width: 100%; transform: translateY(0px); padding-bottom: 18px;";

const bubble = el("div", "chat-bubble user enter", row);
bubble.setAttribute("data-msg-id", "12");
const inner = el("div", "chat-bubble-inner", bubble, USER_MESSAGE_HTML);
inner.setAttribute("dir", "auto");
// Match the real Markdown component: blocks live inside .msg-user-line > .chat-markdown.
const line = inner.querySelector(".msg-user-line") as HTMLElement | null;
if (line) {
  const md = document.createElement("div");
  md.className = "chat-markdown";
  while (line.firstChild) md.appendChild(line.firstChild);
  line.appendChild(md);
}

// The right tool panel: inline width like the real ToolPanel, width transition
// in CSS, .resizing kills it during drags.
const toolPanel = el("div", "tool-panel", gridWrap, PANEL_BODY_HTML);
toolPanel.id = "tool-panel";
toolPanel.style.width = "532px";

// ---- Control box (fixed, top-left, above everything) ----
const controls = el(
  "div",
  null,
  document.body,
);
controls.style.cssText =
  "position: fixed; top: 8px; left: 8px; z-index: 9999; background: #16181d; border: 1px solid #333; border-radius: 8px; padding: 10px; display: grid; gap: 6px; font: 12px sans-serif; color: #ddd; width: 230px;";
controls.innerHTML = `
  <strong>bubble resize harness</strong>
  <button id="c-drag">Simulate drag 532 → 260</button>
  <button id="c-drag-out">Simulate drag 260 → 532</button>
  <button id="c-set-narrow">Set panel 260 (instant)</button>
  <button id="c-set-wide">Set panel 532 (instant)</button>
  <label>tool-panel width transition
    <select id="c-transition"><option value="on">on (as shipped)</option><option value="off">off</option></select>
  </label>
  <label>app zoom (html zoom)
    <select id="c-zoom"><option value="1">1</option><option value="1.1">1.1</option><option value="1.25">1.25</option><option value="0.9">0.9</option></select>
  </label>
  <label>chat text zoom (--chat-zoom)
    <select id="c-chat-zoom"><option value="1">1</option><option value="1.15">1.15</option><option value="1.3">1.3</option></select>
  </label>
  <label>peek overlay
    <select id="c-peek"><option value="off">hidden</option><option value="on">shown</option></select>
  </label>
  <div id="c-readout" style="font-family: monospace; white-space: pre-wrap;"></div>
`;

const readout = document.getElementById("c-readout")!;

function panelWidth(): number {
  return toolPanel.getBoundingClientRect().width;
}
function bubbleBox(): { left: number; right: number; width: number } {
  const r = inner.getBoundingClientRect();
  return { left: r.left, right: r.right, width: r.width };
}
function textOverflow(): number {
  // Widest line actually painted inside the bubble vs the bubble box width.
  let maxRight = 0;
  const range = document.createRange();
  for (const node of inner.querySelectorAll("p, h2, code")) {
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) maxRight = Math.max(maxRight, r.right);
  }
  return maxRight - bubbleBox().right;
}
function updateReadout() {
  const b = bubbleBox();
  readout.textContent =
    `panel=${panelWidth().toFixed(1)}px\n` +
    `bubble=${b.width.toFixed(1)}px [${b.left.toFixed(0)},${b.right.toFixed(0)}]\n` +
    `text overflow past bubble edge: ${textOverflow().toFixed(1)}px`;
}

// Drag simulation: mirrors ToolPanel.startResize — per-frame setWidth with the
// .resizing class killing the width transition.
function simulateDrag(from: number, to: number, ms = 400, duringShot: null | ((w: number) => void) = null) {
  const t0 = performance.now();
  toolPanel.classList.add("resizing");
  const tick = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    const w = from + (to - from) * k;
    toolPanel.style.width = `${w}px`;
    updateReadout();
    if (duringShot && k > 0.45 && k < 0.55) duringShot(w);
    if (k < 1) requestAnimationFrame(tick);
    else toolPanel.classList.remove("resizing");
  };
  requestAnimationFrame(tick);
}

document.getElementById("c-drag")!.addEventListener("click", () => simulateDrag(532, 260));
document.getElementById("c-drag-out")!.addEventListener("click", () => simulateDrag(260, 532));
document.getElementById("c-set-narrow")!.addEventListener("click", () => {
  toolPanel.style.width = "260px";
  updateReadout();
});
document.getElementById("c-set-wide")!.addEventListener("click", () => {
  toolPanel.style.width = "532px";
  updateReadout();
});
document.getElementById("c-transition")!.addEventListener("change", (e) => {
  const off = (e.target as HTMLSelectElement).value === "off";
  toolPanel.style.transition = off ? "none" : "";
});
document.getElementById("c-zoom")!.addEventListener("change", (e) => {
  document.documentElement.style.zoom = (e.target as HTMLSelectElement).value;
  updateReadout();
});
document.getElementById("c-chat-zoom")!.addEventListener("change", (e) => {
  document.documentElement.style.setProperty("--chat-zoom", (e.target as HTMLSelectElement).value);
  updateReadout();
});
document.getElementById("c-peek")!.addEventListener("change", (e) => {
  const on = (e.target as HTMLSelectElement).value === "on";
  const existing = document.querySelector(".peek-overlay");
  if (on && !existing) {
    const overlay = el("div", "view-overlay peek-overlay", document.body, `<div class="peek-panel">${PANEL_BODY_HTML}</div>`);
    overlay.id = "peek-overlay";
  } else if (!on) {
    existing?.remove();
    document.getElementById("peek-overlay")?.remove();
  }
});

// Expose for automation.
(window as unknown as Record<string, unknown>).__harness = {
  simulateDrag,
  toolPanel,
  bubble: inner,
  updateReadout,
  overflow: textOverflow,
  bubbleBox,
};

new ResizeObserver(updateReadout).observe(inner);
new ResizeObserver(updateReadout).observe(toolPanel);
updateReadout();
