// Dev-only visual harness: mounts the REAL ChatView (real MessageBubble,
// react-markdown stack, @tanstack/react-virtual) with a seeded chat store,
// next to a real-classed .tool-panel whose inline width is driven by a
// simulated splitter drag — reproducing the "user bubble text overflows the
// bubble while resizing" report against the actual rendering path.
// Serve `npx vite`, open http://localhost:1511/bubble-real-harness.html.
import "./tauriStub";
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { useChatStore } from "../state/chat";
import { ChatView } from "../components/chat/ChatView";

const USER_PROMPT = `You are a daily AI/ML/LLM news digest writer for a technical audience. Follow the runbook below to produce a self-contained Markdown file per run.

## STEP 0 — Load skills

Load the \`x-posts\` skill at the start of every run. Use its format menu (A11y) and lint rules when drafting posts.

## STEP 1 — Locate prior digests

Call \`list_artifacts\` with query \`AI_ML_Daily_News\` to find the last few digest files. If found, read them and extract the list of covered stories/entities for deduplication. If none exist, note that in the Follow-ups section. 🎉`;

const ASSISTANT_REPLY = `Digest queued. I'll compile today's **AI/ML/LLM news digest** once the run starts.

## STEP 2 — Draft

Write the digest to \`AI_ML_Daily_News_2026-09-18.md\` with the sections Verified Frontier Releases, Open-weight drops, and Follow-ups.`;

// Seed the store BEFORE ChatView mounts so the transcript renders immediately.
const now = Math.floor(Date.now() / 1000);
useChatStore.setState({
  sessions: [
    {
      id: "s1",
      title: "AI/ML daily news digest",
      provider: "codeagent",
      model: "auto",
      createdAt: now - 3600,
      lastActiveAt: now,
    } as never,
  ],
  activeChatSessionId: "s1",
  messages: [
    { id: 12, chatSessionId: "s1", role: "user", content: USER_PROMPT, inputTokens: null, outputTokens: null, costUsd: null, createdAt: now - 600 },
    { id: 13, chatSessionId: "s1", role: "assistant", content: ASSISTANT_REPLY, inputTokens: null, outputTokens: null, costUsd: null, createdAt: now - 590, durationSec: 4 },
  ] as never,
  messagesSessionId: "s1",
  loaded: true,
});

// ---- Giant automation turn (turn-height cap verification) ----
// Builds the kind of run-log turn that overflowed the viewport: dozens of
// interleaved tool rows / thinking blocks / narration, then a long answer.
function giantTurn(): string {
  const parts: string[] = [];
  for (let i = 0; i < 40; i++) {
    parts.push(`\nGathering batch ${i} of today's coverage…\n`);
    parts.push(`<tool>${JSON.stringify({ kind: "search", title: "Searching the web", detail: `AI model releases October 2026 — batch ${i}` })}</tool>`);
    parts.push(`<think>Batch ${i}: cross-checking each claim against the primary source; the benchmark numbers match prior coverage, pricing moves need a second source.</think>`);
    parts.push(`<tool>${JSON.stringify({ kind: "code", title: "Running shell command", lang: "bash", code: `curl -s https://example.com/feed/${i} | jq '.items[] | {title, published}'` })}</tool>`);
  }
  parts.push("\n## Today's AI/ML/LLM digest\n\n");
  for (let i = 0; i < 30; i++) {
    parts.push(`- **Story ${i}** — a reasonably long digest line so the answer body itself grows past a screen: model releases, benchmark results, open-weight drops, and pricing moves across the industry.\n`);
  }
  return parts.join("\n");
}

const USER_ROW = { id: 12, chatSessionId: "s1", role: "user", content: USER_PROMPT, inputTokens: null, outputTokens: null, costUsd: null, createdAt: now - 600 };

let liveSimTimer: number | null = null;
function stopLiveSim() {
  if (liveSimTimer != null) {
    window.clearTimeout(liveSimTimer);
    liveSimTimer = null;
  }
}
function seedGiantStoppedTurn() {
  stopLiveSim();
  const content = giantTurn();
  useChatStore.setState((s) => ({
    messages: [
      USER_ROW,
      // No durationSec + matching stoppedPartial → endedByStop → the process
      // region stays EXPANDED after the turn, the overflow repro.
      { id: 13, chatSessionId: "s1", role: "assistant", content, inputTokens: null, outputTokens: null, costUsd: null, createdAt: now - 30 },
    ] as never,
    stoppedPartial: { ...s.stoppedPartial, s1: content },
    streaming: {},
  }));
}
function startLiveSim() {
  stopLiveSim();
  const content = giantTurn();
  useChatStore.setState((s) => ({
    messages: [USER_ROW] as never,
    stoppedPartial: {},
    streaming: { ...s.streaming, s1: "" },
  }));
  let i = 0;
  const step = () => {
    for (let k = 0; k < 4 && i < content.length; k++) {
      const end = Math.min(content.length, i + 60);
      useChatStore.getState().onToken("s1", content.slice(i, end));
      i = end;
    }
    if (i < content.length) liveSimTimer = window.setTimeout(step, 60);
  };
  step();
}

// Turns overflow seed: a 300-turn automation run-log — the turn rail must
// cap just under the screen and scroll internally (newest ticks pinned).
function seedManyTurns(count = 300) {
  stopLiveSim();
  const msgs: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      id: 1000 + i * 2,
      chatSessionId: "s1",
      role: "user",
      content: `Run #${i + 1} — compile today's digest`,
      inputTokens: null, outputTokens: null, costUsd: null,
      createdAt: now - (count - i) * 3600,
    });
    msgs.push({
      id: 1001 + i * 2,
      chatSessionId: "s1",
      role: "assistant",
      content: `Digest #${i + 1} compiled — ${i + 1} stories covered.`,
      inputTokens: null, outputTokens: null, costUsd: null,
      createdAt: now - (count - i) * 3600 + 30,
      durationSec: 12,
    });
  }
  useChatStore.setState({ messages: msgs as never, stoppedPartial: {}, streaming: {} });
}

function Controls() {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const panel = document.getElementById("tool-panel")!;
    const readout = ref.current!.querySelector<HTMLDivElement>("#c-readout")!;
    const inner = () => document.querySelector<HTMLElement>(".chat-bubble.user .chat-bubble-inner");
    const overflow = () => {
      const b = inner();
      if (!b) return NaN;
      const br = b.getBoundingClientRect();
      let maxRight = 0;
      const range = document.createRange();
      for (const node of b.querySelectorAll("p, h1, h2, h3, h4, code")) {
        range.selectNodeContents(node);
        for (const r of Array.from(range.getClientRects())) maxRight = Math.max(maxRight, r.right);
      }
      return maxRight - br.right;
    };
    const update = () => {
      const b = inner();
      readout.textContent = b
        ? `panel=${panel.getBoundingClientRect().width.toFixed(0)}px bubble=${b.getBoundingClientRect().width.toFixed(1)}px overflow=${overflow().toFixed(1)}px`
        : "no bubble";
    };
    const ro = new ResizeObserver(update);
    ro.observe(panel);
    const iv = window.setInterval(update, 300);
    (window as unknown as Record<string, unknown>).__harness = {
      simulateDrag: (from: number, to: number, ms = 400) => {
        const t0 = performance.now();
        panel.classList.add("resizing");
        const tick = (t: number) => {
          const k = Math.min(1, (t - t0) / ms);
          panel.style.width = `${from + (to - from) * k}px`;
          if (k < 1) requestAnimationFrame(tick);
          else panel.classList.remove("resizing");
        };
        requestAnimationFrame(tick);
      },
      setPanel: (w: number) => {
        panel.style.width = `${w}px`;
      },
      panel,
    };
    update();
    return () => {
      ro.disconnect();
      window.clearInterval(iv);
    };
  }, []);
  return (
    <div
      ref={ref}
      style={{
        position: "fixed", top: 8, left: 8, zIndex: 9999, background: "#16181d",
        border: "1px solid #333", borderRadius: 8, padding: 10, display: "grid",
        gap: 6, font: "12px sans-serif", color: "#ddd", width: 230,
      }}
    >
      <strong>real ChatView harness</strong>
      <button id="c-many-turns" onClick={() => seedManyTurns(300)}>Seed 300 turns (rail)</button>
      <button id="c-giant-stopped" onClick={seedGiantStoppedTurn}>Seed giant stopped turn</button>
      <button id="c-giant-live" onClick={startLiveSim}>Simulate giant live turn</button>
      <button id="c-giant-reset" onClick={() => { stopLiveSim(); useChatStore.setState({ messages: [USER_ROW, { id: 13, chatSessionId: "s1", role: "assistant", content: ASSISTANT_REPLY, inputTokens: null, outputTokens: null, costUsd: null, createdAt: now - 590, durationSec: 4 }] as never, stoppedPartial: {}, streaming: {} }); }}>Reset to short turn</button>
      <button id="c-drag" onClick={() => (window as any).__harness.simulateDrag(532, 260)}>Simulate drag 532 → 260</button>
      <button id="c-drag-out" onClick={() => (window as any).__harness.simulateDrag(260, 532)}>Simulate drag 260 → 532</button>
      <button id="c-set-narrow" onClick={() => (window as any).__harness.setPanel(260)}>Set panel 260 (instant)</button>
      <button id="c-set-wide" onClick={() => (window as any).__harness.setPanel(532)}>Set panel 532 (instant)</button>
      <div id="c-readout" style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }} />
    </div>
  );
}

function App() {
  return (
    <div className="app">
      <div className="main">
        <div className="toolbar">
          <strong>Relay</strong>
          <span className="spacer" />
        </div>
        <div className="grid-wrap chat-grid-wrap">
          <div className="chat-view-wrap">
            <ChatView />
          </div>
          <div className="tool-panel" id="tool-panel" style={{ width: 532 }}>
            <div className="view-header"><h2>AI_ML_Daily_News_2026-09-18.md</h2></div>
            <div className="artifact-preview-content" style={{ padding: 20, overflow: "auto" }}>
              <h2 style={{ fontSize: 20, margin: "0 0 14px" }}>Blackwell roadmap</h2>
              <hr />
              <h2 style={{ fontSize: 18, margin: "18px 0 10px" }}>Verified Frontier Releases</h2>
              <h3 style={{ fontSize: 15, margin: "14px 0 6px" }}>1. Must-watch models</h3>
              <ul style={{ margin: "0 0 12px 18px" }}>
                <li>Open-source weight drops and what they change for local agents.</li>
                <li>Pricing moves across the big API providers this week.</li>
                <li>Agent benchmarks: which claims survive replication.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <Controls />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
