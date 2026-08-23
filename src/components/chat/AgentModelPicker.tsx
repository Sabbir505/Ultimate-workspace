// Combined agent + model selector for the composer's control bar (replaces
// the old AgentMenu chip and the footer's separate ModelEffortMenu). One
// chip — "claude · Sonnet 4.5 ▾" — opens a two-pane picker:
//
//   left rail                        right pane
//   ┌──────────────┬──────────────────────────────┐
//   │ Agents · CLI │ [ Search N models… ]         │
//   │  Claude Code │  Opus 4.8              ✓     │
//   │  Kimi Code   │  Sonnet 5                    │
//   │ Agents · ACP │  …                           │
//   │ Direct API   │  ↦ via https://relay.example  │
//   │  Local model ├──────────────────────────────┤
//   │  OpenAI cmp  │ Effort: Def Low Med High     │
//   └──────────────┴──────────────────────────────┘
//
// The rail lists every way a turn can run: installed CLI harnesses
// (claude/kimi/opencode), ACP agents, the local GGUF sidecar, and one entry
// per configured cloud endpoint from Settings → API Keys (each saved
// provider = its own endpoint + model list). Clicking a rail entry only
// drives the right pane; clicking a model row COMMITS the selection
// (agent + provider + model together), so a pick can never land the session
// on an agent with another agent's model attached.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listHarnesses, listAcpAgents, listHarnessModels, listChatModels, scanLocalModels, getChatConfig, type ChatConfigPayload, type GgufModel, type HarnessModelConfig, type LlamaOverrides } from "../../lib/ipc";
import type { HarnessStatus, AcpAgentStatus } from "../../types";
import { fuzzyFilter, type FuzzyResult } from "../../lib/fuzzy";
import { shortModelName } from "../../lib/modelLabel";
import { harnessModelCatalog } from "../../lib/harnessModels";
import { LlamaAdvancedFields } from "./LlamaAdvancedFields";
import {
  ClaudeIcon,
  AnthropicIcon,
  OpenAiIcon,
  OpenRouterIcon,
  OpenCodeIcon,
  ZedIcon,
  LocalModelIcon,
  MonogramIcon,
} from "./agentIcons";

/** Effort options in display order — High first, Default last (the footer
 *  renders Object.entries of this map top-to-bottom). */
export const EFFORT_LABELS: Record<string, string> = {
  high: "High",
  low: "Low",
  medium: "Medium",
  "": "Default",
};

/** The five cloud providers from Settings → API Keys — each is its own
 *  endpoint, so each gets its own rail entry. */
const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "anthropic_compatible",
  "openai_compatible",
] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  anthropic_compatible: "Anthropic-compatible",
  openai_compatible: "OpenAI-compatible",
};

/** What a committed pick looks like — ChatView turns this into the session's
 *  agent/provider/model (spawning the local sidecar when provider is
 *  local_gguf). `model: ""` means "the agent decides" (ACP). */
export interface AgentModelSelection {
  agent: string;
  provider: string | null;
  model: string;
}

interface Props {
  /** Current session agent: null = none picked yet, "builtin" | "local" |
   *  "harness:<id>" | "acp:<id>". */
  agent: string | null | undefined;
  /** Session model (ChatView's `resolvedModel` — local ids in name/filename
   *  form). Used for the ✓ row and the chip label. */
  model: string;
  /** Session provider ("anthropic" | … | "local_gguf") — decides which rail
   *  entry is highlighted for "builtin" sessions and gates the local-model
   *  footer controls. */
  provider?: string;
  /** id → display label for the ACTIVE harness's model catalog (from
   *  ChatView's listHarnessModels merge) — keeps the chip label identical to
   *  the row the user picked. */
  modelLabels?: Record<string, string>;
  /** Spinner on the chip while the active harness's config/models load. */
  loading?: boolean;
  /** Commit a selection (agent + provider + model together). */
  onPick: (sel: AgentModelSelection) => void;
  // --- Effort (harness + cloud panes) ---
  effort?: string;
  onEffortChange?: (effort: string) => void;
  // --- Local-model runtime controls (Local pane; wired only when a local
  //     runtime is possible) ---
  onEjectLocalModel?: () => void;
  /** True when a local-model sidecar is currently running — shows the ⏏ row. */
  localModelActive?: boolean;
  /** Per-model persisted llama-server overrides, keyed by row id
   *  (name/filename) — seeds each gear panel's draft. */
  localOverridesMap?: Record<string, LlamaOverrides>;
  /** "Load model" from a gear panel: persist the draft, spawn the sidecar
   *  with it, and point the session at that model. */
  onLoadLocalModel?: (model: string, overrides: LlamaOverrides) => void;
}

// ---- shared caches (stale-while-revalidate) -------------------------------

/** Harness/ACP install statuses — the backend probes each CLI with
 *  --version (spawning real processes), so a cold fetch takes seconds.
 *  Cached at module level: reopening the picker paints instantly while a
 *  background refresh updates, and one prefetch per app run warms the cache
 *  before the user's first click. */
let agentStatusCache: {
  harnesses: HarnessStatus[];
  acpAgents: AcpAgentStatus[];
} | null = null;

function fetchAgentStatuses(
  onDone: (harnesses: HarnessStatus[], acpAgents: AcpAgentStatus[]) => void,
): () => void {
  let stale = false;
  void listHarnesses()
    .then((list) => {
      if (!stale && list) setCached(list, undefined);
    })
    .catch(() => {
      /* probe failures keep whatever is cached */
    });
  void listAcpAgents()
    .then((list) => {
      if (!stale && list) setCached(undefined, list);
    })
    .catch(() => {
      /* probe failures keep whatever is cached */
    });
  function setCached(h?: HarnessStatus[], a?: AcpAgentStatus[]) {
    agentStatusCache = {
      harnesses: h ?? agentStatusCache?.harnesses ?? [],
      acpAgents: a ?? agentStatusCache?.acpAgents ?? [],
    };
    if (agentStatusCache.harnesses.length > 0 || agentStatusCache.acpAgents.length > 0 || h || a) {
      onDone(agentStatusCache.harnesses, agentStatusCache.acpAgents);
    }
  }
  return () => {
    stale = true;
  };
}

/** Per-rail model lists fetched during this app run — switching rail entries
 *  back and forth is instant, and a provider's list survives popup closes. */
interface PaneData {
  status: "loading" | "ready" | "error";
  /** Rows in list order; label is what's rendered/searched. */
  rows: { id: string; label: string }[];
  /** Custom endpoint footnote (harness config relay / provider base URL). */
  endpoint?: string | null;
  error?: string;
}
const paneCache = new Map<string, PaneData>();

// ---- helpers ---------------------------------------------------------------

function harnessIdOf(agent: string | null | undefined): string | null {
  return agent?.startsWith("harness:") ? agent.slice("harness:".length) : null;
}
function acpIdOf(agent: string | null | undefined): string | null {
  return agent?.startsWith("acp:") ? agent.slice("acp:".length) : null;
}

/** Case-insensitive id dedupe (aggregators sometimes list a model twice). */
function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Host part of a base URL for the endpoint footnote — "relay.example.com"
 *  reads better than the full URL in the narrow pane (title has the full). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Render `text` with the matched indices from `res` wrapped in <mark>. */
function highlight(text: string, res: FuzzyResult | null): JSX.Element {
  if (!res || res.matches.length === 0) return <>{text}</>;
  const set = new Set(res.matches);
  const out: Array<string | JSX.Element> = [];
  let key = 0;
  let chunk = "";
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (chunk) {
        out.push(chunk);
        chunk = "";
      }
      out.push(
        <mark key={key++} className="model-effort-match">
          {text[i]}
        </mark>,
      );
    } else {
      chunk += text[i];
    }
  }
  if (chunk) out.push(chunk);
  return <>{out}</>;
}

interface RailEntry {
  key: string;
  label: string;
  enabled: boolean;
}

/** The 50px icon rail carries no text — the icon is identified by its
 *  tooltip/aria-label (the agent name) and, for the rare agents without a
 *  freely-licensed mark, by a monogram of the display name. */
function railIcon(key: string, label: string): JSX.Element {
  if (key === "harness:claude_code") {
    return (
      <span className="agent-icon-tint-claude">
        <ClaudeIcon />
      </span>
    );
  }
  if (key === "harness:opencode") return <OpenCodeIcon />;
  if (key === "acp:zed") return <ZedIcon />;
  if (key === "local") return <LocalModelIcon />;
  if (key === "provider:anthropic" || key === "provider:anthropic_compatible") {
    return (
      <span className="agent-icon-tint-claude">
        <AnthropicIcon />
      </span>
    );
  }
  if (key === "provider:openai" || key === "provider:openai_compatible") {
    return <OpenAiIcon />;
  }
  if (key === "provider:openrouter") return <OpenRouterIcon />;
  // kimi_code, Devin, and user-defined ACP agents — monogram fallback.
  return <MonogramIcon letter={label} />;
}

// ---- component -------------------------------------------------------------

export function AgentModelPicker({
  agent,
  model,
  provider,
  modelLabels,
  loading,
  onPick,
  effort,
  onEffortChange,
  onEjectLocalModel,
  localModelActive,
  localOverridesMap,
  onLoadLocalModel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [railKey, setRailKey] = useState<string>("local");
  const [query, setQuery] = useState("");
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>(() => agentStatusCache?.harnesses ?? []);
  const [acpAgents, setAcpAgents] = useState<AcpAgentStatus[]>(() => agentStatusCache?.acpAgents ?? []);
  const [providerCfgs, setProviderCfgs] = useState<Partial<Record<ProviderId, ChatConfigPayload>>>({});
  const [pane, setPane] = useState<PaneData | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Gear panel: which local model row has its advanced-settings panel open,
  // and the editable draft of its llama-server overrides.
  const [gearFor, setGearFor] = useState<string | null>(null);
  const [gearDraft, setGearDraft] = useState<LlamaOverrides>({});
  const [fetchNonce, bumpFetch] = useReducer((n: number) => n + 1, 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isLocalSession = provider === "local_gguf" && agent === "local";

  // Prefetch statuses once per app run (warms the cache before first click).
  useEffect(() => {
    if (agentStatusCache) return;
    return fetchAgentStatuses((h, a) => {
      setHarnesses(h);
      setAcpAgents(a);
    });
  }, []);

  // Refresh statuses + provider configs + local scan every time the popup
  // opens, so installs/keys/settings changed mid-session show up without an
  // app restart. Rendered from cached state immediately.
  useEffect(() => {
    if (!open) return;
    const off = fetchAgentStatuses((h, a) => {
      setHarnesses(h);
      setAcpAgents(a);
    });
    void Promise.all(PROVIDER_IDS.map((id) => getChatConfig(id)))
      .then((cfgs) => {
        const out: Partial<Record<ProviderId, ChatConfigPayload>> = {};
        PROVIDER_IDS.forEach((id, i) => {
          if (cfgs[i]) out[id] = cfgs[i]!;
        });
        setProviderCfgs(out);
      })
      .catch(() => {
        /* keep whatever configs were already rendered */
      });
    return () => {
      off();
    };
  }, [open]);

  // Close the gear sub-modal on Escape (the picker itself stays open).
  useEffect(() => {
    if (!gearFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGearFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gearFor]);

  // Close on outside pointer — EXCEPT inside the gear sub-modal: it's
  // portaled to <body>, so its inputs are outside rootRef, and closing the
  // picker here would reset gearFor and kill the modal mid-edit.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.(".agent-model-gear-modal, .agent-model-gear-scrim")) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  // ---- rail entries --------------------------------------------------------
  // The rail is icon-only (~50px); each icon's tooltip carries the agent
  // name. Sections are separated by a divider in the render below.
  const railSections = useMemo(() => {
    const sections: RailEntry[][] = [];
    const cli = harnesses.map((h) => ({
      key: `harness:${h.id}`,
      label: h.displayName,
      enabled: h.installed,
    }));
    if (cli.length > 0) sections.push(cli);
    if (acpAgents.length > 0) {
      sections.push(
        acpAgents.map((a) => ({
          key: `acp:${a.id}`,
          label: a.displayName,
          enabled: a.installed,
        })),
      );
    }
    const direct: RailEntry[] = [
      { key: "local", label: "Local model", enabled: true },
    ];
    for (const p of PROVIDER_IDS) {
      const cfg = providerCfgs[p];
      direct.push({
        key: `provider:${p}`,
        label: PROVIDER_LABELS[p],
        enabled: !!cfg?.hasKey,
      });
    }
    sections.push(direct);
    return sections;
  }, [harnesses, acpAgents, providerCfgs]);

  /** Which rail entry the session is currently running on — highlighted when
   *  the popup opens, and the ✓-carrier in the right pane. */
  const sessionRailKey = useMemo(() => {
    const h = harnessIdOf(agent);
    if (h) return `harness:${h}`;
    const a = acpIdOf(agent);
    if (a) return `acp:${a}`;
    if (agent === "local") return "local";
    if (agent === "builtin" && provider && PROVIDER_IDS.includes(provider as ProviderId)) {
      return `provider:${provider}`;
    }
    return null;
  }, [agent, provider]);

  // Reset transient state and point the rail at the session's entry on open.
  useEffect(() => {
    if (!open) {
      setGearFor(null);
      return;
    }
    setQuery("");
    setActiveIndex(0);
    // Default to the session's entry; fall back to the first enabled one so
    // the right pane is never empty on first open.
    const fallback = railSections.flat().find((e) => e.enabled)?.key ?? "local";
    setRailKey(sessionRailKey ?? fallback);
    requestAnimationFrame(() => searchRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ---- right-pane model list per rail selection ----------------------------

  useEffect(() => {
    if (!open || !railKey) return;
    const cached = paneCache.get(railKey);
    setPane(cached ?? { status: "loading", rows: [] });
    if (cached && cached.status !== "error") return;
    let stale = false;
    const store = (data: PaneData) => {
      paneCache.set(railKey, data);
      if (!stale) setPane(data);
    };
    if (railKey.startsWith("harness:")) {
      const id = railKey.slice("harness:".length);
      void listHarnessModels(id)
        .then((cfg: HarnessModelConfig | null) => {
          // Config-discovered models first, then static-catalog entries the
          // config didn't mention (same merge ChatView uses).
          const fromCfg = cfg?.models ?? [];
          const cfgIds = new Set(fromCfg.map((m) => m.id));
          const extra = harnessModelCatalog(id).filter((m) => !cfgIds.has(m.id));
          store({
            status: "ready",
            rows: [...fromCfg, ...extra].map((m) => ({ id: m.id, label: m.label || m.id })),
            endpoint: cfg?.endpoint ?? null,
          });
        })
        .catch((err: unknown) =>
          store({
            status: "error",
            rows: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    } else if (railKey.startsWith("provider:")) {
      const p = railKey.slice("provider:".length);
      void listChatModels(p)
        .then((list) => {
          const ids = dedupeIds((list ?? []).map((m) => m.id));
          store({
            status: "ready",
            rows: ids.map((id) => ({ id, label: id })),
          });
        })
        .catch((err: unknown) =>
          store({
            status: "error",
            rows: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    } else if (railKey === "local") {
      void scanLocalModels()
        .then((list: GgufModel[] | null) => {
          const rows = dedupeIds((list ?? []).map((m) => m.name || m.filename)).map((id) => ({
            id,
            label: shortModelName(id),
          }));
          store({ status: "ready", rows });
        })
        .catch((err: unknown) =>
          store({
            status: "error",
            rows: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
    // ACP panes are static (the agent decides) — nothing to fetch.
    return () => {
      stale = true;
    };
  }, [open, railKey, fetchNonce]);

  // ---- ranked rows (fuzzy search) -------------------------------------------

  const isAcpPane = railKey.startsWith("acp:");
  const paneRows = useMemo(() => {
    const rows = pane?.rows ?? [];
    // Parity with the old selector: the session's current cloud model is
    // always listed, even if the endpoint's /v1/models doesn't include it
    // (stale session, aggregator filtering, …).
    if (
      sessionRailKey === railKey &&
      railKey.startsWith("provider:") &&
      model &&
      !rows.some((r) => r.id.trim().toLowerCase() === model.trim().toLowerCase())
    ) {
      return [{ id: model, label: model }, ...rows];
    }
    return rows;
  }, [pane?.rows, sessionRailKey, railKey, model]);

  /** Endpoint footnote under the model rows: the harness's own configured
   *  relay for CLI panes, the provider's saved base URL for cloud panes
   *  (read live from providerCfgs so it's correct even when the model fetch
   *  was served from cache). */
  const paneEndpoint = railKey.startsWith("provider:")
    ? (providerCfgs[railKey.slice("provider:".length) as ProviderId]?.baseUrl ?? null)
    : (pane?.endpoint ?? null);

  const ranked = useMemo(() => {
    if (isAcpPane) return [];
    if (query.trim().length === 0) {
      return paneRows.map((r) => ({ ...r, matches: [] as number[], score: 0 }));
    }
    return fuzzyFilter(query, paneRows, (r) => r.label).map((h) => ({
      id: h.item.id,
      label: h.item.label,
      matches: h.matches,
      score: h.score,
    }));
  }, [paneRows, query, isAcpPane]);

  useEffect(() => {
    setActiveIndex((i) => (i >= ranked.length ? 0 : i));
  }, [ranked.length]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  // ---- commit ---------------------------------------------------------------

  const pickRailEntry = (entry: RailEntry) => setRailKey(entry.key);

  const pickModel = (id: string) => {
    setOpen(false);
    if (railKey.startsWith("harness:")) {
      onPick({ agent: railKey, provider: null, model: id });
    } else if (railKey.startsWith("acp:")) {
      onPick({ agent: railKey, provider: null, model: "" });
    } else if (railKey === "local") {
      onPick({ agent: "local", provider: "local_gguf", model: id });
    } else if (railKey.startsWith("provider:")) {
      onPick({ agent: "builtin", provider: railKey.slice("provider:".length), model: id });
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, ranked.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pickRow = ranked[activeIndex];
      if (pickRow) pickModel(pickRow.id);
    } else if (e.key === "Escape") {
      if (query.length > 0) {
        setQuery("");
      } else {
        setOpen(false);
      }
    }
  };

  // ---- chip label ------------------------------------------------------------

  const chipLabel = useMemo(() => {
    if (agent == null) return null;
    const h = harnessIdOf(agent);
    if (h) {
      const name = harnesses.find((x) => x.id === h)?.displayName ?? h;
      return model ? `${name} · ${modelLabels?.[model] ?? model}` : name;
    }
    const a = acpIdOf(agent);
    if (a) return acpAgents.find((x) => x.id === a)?.displayName ?? a;
    if (agent === "local") {
      return model ? `Local · ${shortModelName(model)}` : "Local model";
    }
    if (agent === "builtin") {
      const p = (provider ?? "") as ProviderId;
      const name = PROVIDER_LABELS[p] ?? "API";
      return model ? `${name} · ${model}` : name;
    }
    return null;
  }, [agent, model, provider, modelLabels, harnesses, acpAgents]);

  const dotClass =
    agent == null ? null : harnessIdOf(agent) || acpIdOf(agent) ? "" : agent === "local" ? "local" : "cloud";

  // ---- render ----------------------------------------------------------------

  const showEffort =
    !!onEffortChange &&
    effort !== undefined &&
    (railKey.startsWith("harness:") || railKey.startsWith("provider:"));

  return (
    <div className="agent-menu" ref={rootRef}>
      <button
        type="button"
        className={`agent-chip${chipLabel ? " selected" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {chipLabel ? (
          <>
            {loading ? (
              <span className="agent-chip-spinner" aria-hidden="true" />
            ) : (
              <span
                className={dotClass ? `agent-dot ${dotClass}` : "agent-dot"}
                aria-hidden="true"
              />
            )}
            <span className="agent-chip-label">{chipLabel}</span>
          </>
        ) : (
          <>⌘ Select agent</>
        )}
        <span className="model-effort-chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="agent-model-popup" role="menu" aria-label="Agent and model">
          {/* ---- left rail (icon-only, ~50px; tooltips carry the names) ---- */}
          <div className="agent-model-rail" role="tablist" aria-label="Agents" aria-orientation="vertical">
            {railSections.map((section, si) => (
              <div key={si} className="agent-model-rail-section">
                {si > 0 && <div className="agent-rail-divider" aria-hidden="true" />}
                {section.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    role="tab"
                    aria-selected={railKey === entry.key}
                    aria-label={entry.label}
                    title={entry.label}
                    className={`agent-rail-icon-btn${
                      railKey === entry.key ? " rail-selected" : ""
                    }${entry.enabled ? "" : " disabled"}`}
                    disabled={!entry.enabled}
                    onClick={() => pickRailEntry(entry)}
                  >
                    {railIcon(entry.key, entry.label)}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* ---- right pane ---- */}
          <div className="agent-model-pane">
            <div className="model-effort-search">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={
                  isAcpPane
                    ? "Agent decides its model"
                    : pane?.status === "loading"
                      ? "Loading models…"
                      : `Search ${pane?.rows.length ?? 0} models…`
                }
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="agent-model-list">
              {isAcpPane ? (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={sessionRailKey === railKey}
                  className={`model-effort-item${sessionRailKey === railKey ? " selected" : ""}`}
                  onClick={() => pickModel("")}
                >
                  <span>Default — the agent picks its own model</span>
                  {sessionRailKey === railKey && <span className="model-effort-check">✓</span>}
                </button>
              ) : pane?.status === "loading" ? (
                <div className="model-effort-empty">
                  <span className="agent-chip-spinner" /> Loading models…
                </div>
              ) : pane?.status === "error" ? (
                <div className="model-effort-empty">
                  <div>Couldn’t load models — {pane.error}</div>
                  <button
                    type="button"
                    className="model-effort-retry"
                    onClick={() => {
                      paneCache.delete(railKey);
                      bumpFetch();
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : pane && pane.rows.length === 0 ? (
                <div className="model-effort-empty">
                  {railKey === "local"
                    ? "No local models — add a folder in Settings → Local Models"
                    : "No models — set base URL & key in Settings → API Keys"}
                </div>
              ) : (
                <>
                  {ranked.length === 0 && (
                    <div className="model-effort-empty">No models match "{query}".</div>
                  )}
                  {ranked.map((r, i) => {
                    const isCurrent =
                      sessionRailKey === railKey && r.id === model;
                    const isLocalRow = railKey === "local";
                    return (
                      <button
                        key={r.id}
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isCurrent}
                        className={`model-effort-item${isCurrent ? " selected" : ""}${
                          i === activeIndex ? " active" : ""
                        }`}
                        onClick={() => pickModel(r.id)}
                        onPointerEnter={() => setActiveIndex(i)}
                      >
                          <span title={r.id}>
                            {query.trim().length > 0
                              ? highlight(r.label, { score: r.score, matches: r.matches })
                              : r.label}
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            {isCurrent && <span className="model-effort-check">✓</span>}
                            {isLocalRow && onLoadLocalModel && (
                              <span
                                role="button"
                                tabIndex={0}
                                className={`agent-model-gear${gearFor === r.id ? " open" : ""}`}
                                title="Advanced runtime settings — GPU layers, context, sampling…"
                                aria-label={`Advanced settings for ${r.label}`}
                                onClick={(e) => {
                                  // Toggle the gear panel without picking the model.
                                  e.stopPropagation();
                                  if (gearFor === r.id) {
                                    setGearFor(null);
                                  } else {
                                    setGearFor(r.id);
                                    setGearDraft({ ...(localOverridesMap?.[r.id] ?? {}) });
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (gearFor !== r.id) {
                                      setGearFor(r.id);
                                      setGearDraft({ ...(localOverridesMap?.[r.id] ?? {}) });
                                    } else {
                                      setGearFor(null);
                                    }
                                  }
                                }}
                              >
                                ⚙
                              </span>
                            )}
                          </span>
                        </button>
                    );
                  })}
                </>
              )}

              {/* ---- eject the running sidecar (session is local) ---- */}
              {railKey === "local" && isLocalSession && localModelActive && onEjectLocalModel && (
                <>
                  <div className="model-effort-divider" />
                  <button
                    type="button"
                    className="model-effort-item"
                    onClick={onEjectLocalModel}
                  >
                    <span>⏏ Eject model — free VRAM</span>
                  </button>
                </>
              )}
            </div>

            {/* Endpoint footnote — PINNED under the list (not inside the
                scroll area) so the relay/endpoint is visible without
                scrolling past every model. Host only; full URL in title. */}
            {paneEndpoint && (
              <div className="model-effort-endpoint" title={paneEndpoint}>
                ↦ via {hostOf(paneEndpoint)}
              </div>
            )}

            {/* ---- effort footer (CLI + cloud panes): High/Low/Medium on the
                 first row, Default full-width on the second, same heights ---- */}
            {showEffort && (
              <>
                <div className="model-effort-divider" />
                <div className="agent-model-effort">
                  <div className="agent-model-effort-row">
                    {(["high", "low", "medium"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={value === effort}
                        className={`agent-model-effort-opt${value === effort ? " selected" : ""}`}
                        onClick={() => onEffortChange!(value)}
                        title={`Prefer ${EFFORT_LABELS[value].toLowerCase()} reasoning effort`}
                      >
                        {EFFORT_LABELS[value]}
                      </button>
                    ))}
                  </div>
                  <div className="agent-model-effort-row">
                    <button
                      key="default"
                      type="button"
                      role="menuitemradio"
                      aria-checked={"" === effort}
                      className={`agent-model-effort-opt${"" === effort ? " selected" : ""}`}
                      onClick={() => onEffortChange!("")}
                      title="Provider default reasoning effort"
                    >
                      {EFFORT_LABELS[""]}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Advanced runtime settings SUB-MODAL — opened by a local row's gear.
          Portaled to <body> so the composer's stacking contexts (backdrop
          filters, popups) can't clip or trap it. */}
      {gearFor &&
        onLoadLocalModel &&
        createPortal(
          <div
            className="agent-model-gear-scrim"
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) setGearFor(null);
            }}
          >
            <div
              className="agent-model-gear-modal"
              role="dialog"
              aria-modal="true"
              aria-label={`Advanced runtime settings — ${gearFor}`}
            >
              <div className="agent-model-gear-head">
                <span className="agent-model-gear-title" title={gearFor}>
                  {shortModelName(gearFor)} — runtime settings
                </span>
                <button
                  type="button"
                  className="agent-model-gear-close"
                  aria-label="Close advanced settings"
                  onClick={() => setGearFor(null)}
                >
                  ✕
                </button>
              </div>
              <div className="agent-model-gear-body">
                <LlamaAdvancedFields overrides={gearDraft} onChange={setGearDraft} />
                <button
                  type="button"
                  className="model-effort-llama-apply"
                  title="Persist these settings, load the model with them, and switch the chat to it"
                  onClick={() => {
                    onLoadLocalModel(gearFor, gearDraft);
                    setGearFor(null);
                    setOpen(false);
                  }}
                >
                  Load model
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
