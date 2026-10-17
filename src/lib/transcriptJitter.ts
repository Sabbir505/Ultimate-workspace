// Transcript jitter probe — dev instrumentation for the "the chat view shakes
// while streaming / while I try to scroll" class of bugs.
//
// Two halves, both no-ops until enabled:
//
//   1. noteJitter(kind, value?) — call sites in the scroll engine and the
//      virtual list tag every layout WRITE they perform (pin writes, wrapper
//      height syncs, size-cache pokes, entrance animations). The probe joins
//      them with the frame they landed in, so a visible jump can be attributed
//      to a writer instead of guessed at.
//
//   2. startJitterProbe(el) — a rAF sampler over the scroll container. Each
//      frame it records scrollTop / scrollHeight, classifies a scrollTop move
//      as "user" (wheel/touch/pointer/keys within the last 250ms) or
//      "programmatic" (the pin, the virtualizer's corrections), and counts:
//        - reversals: a move opposing an earlier move within 400ms. Two
//          writers fighting over the same scrollTop is exactly a reversal —
//          one writer says "down", the other "up", and the user sees shake.
//        - height flaps: the wrapper's scrollHeight reversing direction with a
//          small delta (sub-pixel churn between two sources of truth).
//
// Enable with ?jitter=1 in the URL, localStorage.ccJitter = "1", or from
// devtools: __ccJitter.start(document.querySelector(".chat-messages")).
// __ccJitter.report() prints the aggregate (also console.table'd) and
// __ccJitter.watch(true/false) shows the live overlay.
//
// Cost when OFF: every entry point checks one boolean before doing anything.

interface JitterNote {
  kind: string;
  value?: number;
  t: number;
}

export interface JitterReport {
  enabled: boolean;
  seconds: number;
  frames: number;
  programmaticMoves: number;
  userMoves: number;
  programmaticPerSecond: number;
  reversals: number;
  heightFlaps: number;
  maxProgrammaticStepPx: number;
  notes: Record<string, number>;
  worstFrames: { ms: number; delta: number; notes: string[] }[];
}

const MAX_WORST = 12;
const REVERSAL_WINDOW_MS = 400;
const INPUT_WINDOW_MS = 250;
const HEIGHT_FLAP_WINDOW_MS = 500;
const HEIGHT_FLAP_MAX_PX = 12;

const worstFrames: JitterReport["worstFrames"] = [];
const noteCounts = new Map<string, number>();
const recentMoves: { t: number; dir: number }[] = [];

const state = {
  enabled: false,
  container: null as HTMLElement | null,
  raf: 0,
  startedAt: 0,
  frames: 0,
  programmaticMoves: 0,
  userMoves: 0,
  reversals: 0,
  heightFlaps: 0,
  maxProgrammaticStep: 0,
  lastInputAt: 0,
  lastSample: null as { top: number; height: number; t: number } | null,
  pending: [] as JitterNote[],
  lastHeightDir: 0,
  lastHeightFlipAt: 0,
  overlay: null as HTMLElement | null,
  overlayText: null as HTMLElement | null,
  overlayAt: 0,
  listeners: null as null | (() => void),
};

function autoEnabled(): boolean {
  try {
    if (localStorage.getItem("ccJitter") === "1") return true;
  } catch {
    /* webview with storage locked down */
  }
  try {
    return typeof location !== "undefined" && /[?&]jitter=1(&|$)/.test(location.search);
  } catch {
    return false;
  }
}

state.enabled = autoEnabled();

/** Tag a layout write. Cheap no-op unless the probe is enabled. `value` is
 *  the written size/position when the call site has one (px). */
export function noteJitter(kind: string, value?: number): void {
  if (!state.enabled || state.container == null) return;
  const note: JitterNote = { kind, value, t: performance.now() };
  state.pending.push(note);
  if (state.pending.length > 64) state.pending.shift();
}

function takeNotes(): JitterNote[] {
  if (state.pending.length === 0) return [];
  const notes = state.pending;
  state.pending = [];
  for (const n of notes) noteCounts.set(n.kind, (noteCounts.get(n.kind) ?? 0) + 1);
  return notes;
}

function attachInputTracking(el: HTMLElement): () => void {
  const mark = () => {
    state.lastInputAt = performance.now();
  };
  const onKey = (e: KeyboardEvent) => {
    if (
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "PageUp" ||
      e.key === "PageDown" ||
      e.key === "Home" ||
      e.key === "End" ||
      e.key === " "
    ) {
      mark();
    }
  };
  el.addEventListener("wheel", mark, { passive: true });
  el.addEventListener("touchmove", mark, { passive: true });
  el.addEventListener("pointerdown", mark, { passive: true });
  window.addEventListener("keydown", onKey, { passive: true });
  return () => {
    el.removeEventListener("wheel", mark);
    el.removeEventListener("touchmove", mark);
    el.removeEventListener("pointerdown", mark);
    window.removeEventListener("keydown", onKey);
  };
}

function sampleFrame() {
  state.raf = requestAnimationFrame(sampleFrame);
  const el = state.container;
  if (!el) return;
  renderOverlay();
  const t = performance.now();
  const top = el.scrollTop;
  const height = el.scrollHeight;
  state.frames += 1;

  const prev = state.lastSample;
  state.lastSample = { top, height, t };

  const notes = takeNotes();

  if (prev) {
    // Height flap: a small reversal within the flap window. Monotonic growth
    // (a stream) never counts; only a shrink that follows a grow (or the
    // reverse) with a small magnitude — the signature of two writers trading
    // the wrapper's height back and forth.
    const dH = height - prev.height;
    if (dH !== 0) {
      const dir = dH > 0 ? 1 : -1;
      if (
        state.lastHeightDir !== 0 &&
        dir !== state.lastHeightDir &&
        t - state.lastHeightFlipAt < HEIGHT_FLAP_WINDOW_MS &&
        Math.abs(dH) <= HEIGHT_FLAP_MAX_PX
      ) {
        state.heightFlaps += 1;
      }
      if (dir !== state.lastHeightDir) {
        state.lastHeightDir = dir;
        state.lastHeightFlipAt = t;
      }
    }

    const dTop = top - prev.top;
    if (Math.abs(dTop) >= 0.5) {
      if (t - state.lastInputAt < INPUT_WINDOW_MS) {
        state.userMoves += 1;
      } else {
        state.programmaticMoves += 1;
        state.maxProgrammaticStep = Math.max(state.maxProgrammaticStep, Math.abs(dTop));
        // Reversal: this move opposes a recent one. Before dropping the old
        // entries, require the two moves to be close in time AND the pair to
        // net out small (a real scroll has a consistent direction).
        const dir = dTop > 0 ? 1 : -1;
        for (let i = recentMoves.length - 1; i >= 0; i--) {
          const m = recentMoves[i];
          if (t - m.t > REVERSAL_WINDOW_MS) break;
          if (m.dir !== dir) {
            state.reversals += 1;
            break;
          }
        }
        recentMoves.push({ t, dir });
        if (recentMoves.length > 24) recentMoves.shift();
        worstFrames.push({
          ms: Math.round(t - state.startedAt),
          delta: Math.round(dTop * 10) / 10,
          notes: notes.map((n) => n.kind),
        });
        if (worstFrames.length > MAX_WORST) {
          worstFrames.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
          worstFrames.length = MAX_WORST / 2;
        }
      }
    }
  }
}

function renderOverlay(force = false) {
  if (!state.overlayText) return;
  const t = performance.now();
  if (!force && t - state.overlayAt < 250) return;
  state.overlayAt = t;
  const secs = Math.max(0.001, (t - state.startedAt) / 1000);
  const rate = (state.programmaticMoves / secs).toFixed(1);
  const topNotes = [...noteCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  state.overlayText.textContent =
    `JIT ${secs.toFixed(1)}s ` +
    `moves pm:${state.programmaticMoves} (${rate}/s) usr:${state.userMoves} ` +
    `rev:${state.reversals} flap:${state.heightFlaps} max:${state.maxProgrammaticStep.toFixed(1)}px\n` +
    topNotes;
}

function ensureOverlay() {
  if (state.overlay || typeof document === "undefined") return;
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:6px 8px;" +
    "background:rgba(12,12,14,0.86);color:#9ef0b0;border:1px solid #2b4;border-radius:6px;" +
    "font:11px/1.4 ui-monospace,monospace;white-space:pre;pointer-events:none;max-width:60vw;";
  const text = document.createElement("div");
  box.appendChild(text);
  document.body.appendChild(box);
  state.overlay = box;
  state.overlayText = text;
}

export function startJitterProbe(container: HTMLElement, opts?: { overlay?: boolean }): void {
  stopJitterProbe();
  state.enabled = true;
  state.container = container;
  state.startedAt = performance.now();
  state.lastSample = null;
  state.listeners = attachInputTracking(container);
  if (opts?.overlay) ensureOverlay();
  state.raf = requestAnimationFrame(sampleFrame);
  noteJitter("probe.start");
}

export function stopJitterProbe(): void {
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
  state.listeners?.();
  state.listeners = null;
  state.container = null;
  if (state.overlay) {
    state.overlay.remove();
    state.overlay = null;
    state.overlayText = null;
  }
}

/** Probe automatically when the app was launched with the flag (see the
 *  header). Called by the transcript when its scroll container mounts. */
export function maybeAutoStartProbe(container: HTMLElement): void {
  if (!state.enabled || state.container) return;
  ensureOverlay();
  startJitterProbe(container, { overlay: true });
}

export function jitterReport(): JitterReport {
  const secs = Math.max(0.001, (performance.now() - state.startedAt) / 1000);
  const notes: Record<string, number> = {};
  for (const [k, v] of noteCounts) notes[k] = v;
  const report: JitterReport = {
    enabled: state.enabled,
    seconds: Math.round(secs * 10) / 10,
    frames: state.frames,
    programmaticMoves: state.programmaticMoves,
    userMoves: state.userMoves,
    programmaticPerSecond: Math.round((state.programmaticMoves / secs) * 10) / 10,
    reversals: state.reversals,
    heightFlaps: state.heightFlaps,
    maxProgrammaticStepPx: Math.round(state.maxProgrammaticStep * 10) / 10,
    notes,
    worstFrames: [...worstFrames].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, MAX_WORST),
  };
  console.table(report);
  return report;
}

function installGlobal() {
  if (typeof window === "undefined") return;
  const api = {
    start(selector?: string | HTMLElement, overlay = true) {
      const el =
        typeof selector === "string"
          ? document.querySelector<HTMLElement>(selector)
          : (selector ?? document.querySelector<HTMLElement>(".chat-messages"));
      if (!el) {
        console.warn("[jitter] no container found");
        return;
      }
      startJitterProbe(el, { overlay });
    },
    stop: stopJitterProbe,
    report: jitterReport,
    note: noteJitter,
    watch(on: boolean) {
      if (on) ensureOverlay();
      else if (state.overlay) {
        state.overlay.remove();
        state.overlay = null;
        state.overlayText = null;
      }
      renderOverlay(true);
    },
    enable(persist = true) {
      state.enabled = true;
      if (persist) {
        try {
          localStorage.setItem("ccJitter", "1");
        } catch {
          /* ignore */
        }
      }
      // Probe an already-mounted transcript immediately — otherwise the user
      // has to start() by hand after enabling from devtools.
      const el = document.querySelector<HTMLElement>(".chat-messages");
      if (el && !state.container) startJitterProbe(el, { overlay: true });
    },
    disable(persist = true) {
      state.enabled = false;
      stopJitterProbe();
      if (persist) {
        try {
          localStorage.removeItem("ccJitter");
        } catch {
          /* ignore */
        }
      }
    },
  };
  (window as unknown as Record<string, unknown>).__ccJitter = api;
}

installGlobal();
