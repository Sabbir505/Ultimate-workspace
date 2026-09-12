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
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listHarnesses, listAcpAgents, listHarnessModels, listChatModels, scanLocalModels, getChatConfig, type ChatConfigPayload, type GgufModel, type HarnessModelConfig, type LlamaOverrides } from "../../lib/ipc";
import type { HarnessStatus, AcpAgentStatus } from "../../types";
import { fuzzyFilter, type FuzzyResult } from "../../lib/fuzzy";
import { shortModelName } from "../../lib/modelLabel";
import { CLOUD_PROVIDER_IDS as PROVIDER_IDS } from "../../lib/agents";
import { useSettingsStore } from "../../state/settings";
import { harnessModelCatalog } from "../../lib/harnessModels";
import {
  acpIdOf,
  dedupeIds,
  fetchAgentStatuses,
  getCachedAgentStatuses,
  harnessIdOf,
  highlight,
  hostOf,
  paneCache,
  paneInFlight,
  type PaneData,
} from "./agentPickerShared";
import {
  AutoBiasFooter,
  GearSubModal,
  HarnessEffortFooter,
  ProviderEffortFooter,
} from "./agentPickerParts";
// Split-boundary re-exports: the effort label tables are public surface of
// this module (moved to agentPickerShared with the footer parts).
export { EFFORT_LABELS, HARNESS_EFFORT_LABELS } from "./agentPickerShared";
import {
  ClaudeIcon,
  AnthropicIcon,
  OpenAiIcon,
  OpenRouterIcon,
  OpenCodeIcon,
  KimiIcon,
  PiIcon,
  OmpIcon,
  CommandCodeIcon,
  ZedIcon,
  LocalModelIcon,
  MonogramIcon,
  AutoRouteIcon,
  railIcon,
} from "./agentIcons";


/** The five cloud providers from Settings → API Keys — each is its own
 *  endpoint, so each gets its own rail entry. */
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
 *  local_gguf; flipping the session to Auto routing when provider is
 *  "auto"). `model: ""` means "the agent decides" (ACP). */
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
  /** HARNESS session's effort tier ("" = "Default"). Undefined = session
   *  isn't a harness chat — the harness panes then render slider-free (there
   *  is no session to persist a tier onto). */
  harnessEffort?: string;
  /** Change the harness session's tier — persisted per session, applied at
   *  the next spawn (claude respawns with the new flag). */
  onHarnessEffortChange?: (effort: string) => void;
  // --- Auto routing bias (Auto pane): Quality / Balanced / Economy, the
  // cost-vs-quality dial the backend resolver ranks with. ---
  autoBias?: string;
  onAutoBiasChange?: (bias: string) => void;
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

interface RailEntry {
  key: string;
  label: string;
  enabled: boolean;
}

/** The 50px icon rail carries no text — the icon is identified by its
 *  tooltip/aria-label (the agent name) and, for the rare agents without a
 *  freely-licensed mark, by a monogram of the display name. The mapping
 *  itself lives in agentIcons.tsx (railIcon) so lightweight consumers like
 *  the sidebar inbox rows share it without importing the picker. */
// ---- component -------------------------------------------------------------

export function AgentModelPickerInner({
  agent,
  model,
  provider,
  modelLabels,
  loading,
  onPick,
  effort,
  onEffortChange,
  harnessEffort,
  onHarnessEffortChange,
  onAutoBiasChange,
  autoBias,
  onEjectLocalModel,
  localModelActive,
  localOverridesMap,
  onLoadLocalModel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [railKey, setRailKey] = useState<string>("local");
  const [query, setQuery] = useState("");
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>(() => getCachedAgentStatuses()?.harnesses ?? []);
  const [acpAgents, setAcpAgents] = useState<AcpAgentStatus[]>(() => getCachedAgentStatuses()?.acpAgents ?? []);
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

  // Cached provider panes to revalidate in the background when their pane
  // next renders (marked on popup open — see the reset effect below). A ref,
  // not state: marking must not re-render; the pane effect consumes it.
  const refreshOnOpen = useRef(new Set<string>());
  // Which rail entry the pane fetches may still write to — completions for a
  // stale entry update only the cache, never the pane being viewed.
  const railKeyRef = useRef(railKey);

  // Fetch one rail pane's model list into the cache, updating the live pane
  // state only when the user is still looking at that entry. Shared by the
  // pane effect, the open-time refresh, and the warm-up; the module-level
  // in-flight guard keeps them from double-fetching the same pane.
  const startPaneFetch = useCallback((key: string) => {
    if (paneInFlight.has(key)) return;
    paneInFlight.add(key);
    const settle = (data: PaneData) => {
      paneInFlight.delete(key);
      paneCache.set(key, data);
      if (railKeyRef.current === key) setPane(data);
    };
    if (key.startsWith("harness:")) {
      const id = key.slice("harness:".length);
      void listHarnessModels(id)
        .then((cfg: HarnessModelConfig | null) => {
          // Config-discovered models first, then static-catalog entries the
          // config didn't mention (same merge ChatView uses). Per-model
          // thinking tiers ride along when the CLI reports them (omp).
          const toRow = (m: { id: string; label: string; thinking?: string[] }) => ({
            id: m.id,
            label: m.label || m.id,
            ...(m.thinking?.length ? { thinking: m.thinking } : {}),
          });
          const fromCfg = cfg?.models ?? [];
          const cfgIds = new Set(fromCfg.map((m) => m.id));
          const extra = harnessModelCatalog(id).filter((m) => !cfgIds.has(m.id));
          settle({
            status: "ready",
            rows: [...fromCfg.map(toRow), ...extra.map(toRow)],
            endpoint: cfg?.endpoint ?? null,
            // Read-only effort level the CLI publishes in its own config
            // (Claude Code's settings env today; null = nothing published).
            effort: cfg?.effort ?? null,
            // Spawn-able tiers (claude/kimi/omp/pi); [] = no knob.
            effortOptions: cfg?.effortOptions ?? [],
          });
        })
        .catch((err: unknown) =>
          settle({
            status: "error",
            rows: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    } else if (key.startsWith("provider:")) {
      const p = key.slice("provider:".length);
      // Curated Model list (Settings → API provider → Model list): when the
      // user pinned a set of models for this provider, the picker shows ONLY
      // those — in curated order, each labeled with its pinned context
      // window (falling back to the provider-reported one). An empty or
      // absent list keeps the old behavior: every model the /v1/models
      // fetch returns.
      const curated = useSettingsStore.getState().providerModels[p] ?? [];
      const toRows = (ids: string[]): { id: string; label: string }[] =>
        ids.map((id) => ({ id, label: id }));
      void listChatModels(p)
        .then((list) => {
          // Curated list wins when present (picker shows ONLY those, in
          // curated order); otherwise every model the fetch returned. The
          // per-model context windows ride along invisibly — the meter and
          // compaction trigger consume them, the labels stay clean.
          const ids =
            curated.length > 0
              ? curated.map((e) => e.id)
              : dedupeIds((list ?? []).map((m) => m.id));
          settle({ status: "ready", rows: toRows(ids) });
        })
        .catch((err: unknown) => {
          // Fetch failed (offline / no key yet) — a curated list still gives
          // the picker content; only without one do we surface the error.
          if (curated.length > 0) {
            settle({ status: "ready", rows: toRows(curated.map((e) => e.id)) });
            return;
          }
          settle({
            status: "error",
            rows: [],
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } else if (key === "local") {
      void scanLocalModels()
        .then((list: GgufModel[] | null) => {
          const rows = dedupeIds((list ?? []).map((m) => m.name || m.filename)).map((id) => ({
            id,
            label: shortModelName(id),
          }));
          settle({ status: "ready", rows });
        })
        .catch((err: unknown) =>
          settle({
            status: "error",
            rows: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    } else {
      // ACP and Auto panes are static (the agent/resolver decides) —
      // nothing to fetch.
      paneInFlight.delete(key);
    }
  }, []);

  // Prefetch statuses once per app run (warms the cache before first click).
  useEffect(() => {
    if (getCachedAgentStatuses()) return;
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
        // Warm panes we have no list for yet (first open of the run, or a
        // provider keyed since the last open) so the first click on their
        // rail entry renders rows immediately instead of a spinner.
        for (const id of PROVIDER_IDS) {
          if (!out[id]?.hasKey) continue;
          const key = `provider:${id}`;
          if (paneCache.has(key) || paneInFlight.has(key)) continue;
          startPaneFetch(key);
        }
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

  // Close on outside pointer — EXCEPT inside the portaled popup and the gear
  // sub-modal: both live outside rootRef (see the portal note below), and
  // closing the picker here would kill them on their own clicks/edits.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.(".agent-model-popup, .agent-model-gear-modal, .agent-model-gear-scrim")) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Viewport anchor for the portaled popup (re-measured while open so the
  // popup tracks the chip on window resizes and layout scrolls).
  const [popupPos, setPopupPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPopupPos(null);
      return;
    }
    const measure = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = {
        left: rect.left,
        // Open UPWARD from the chip's top edge (same anchor the old absolute
        // positioning expressed as bottom: calc(100% + 6px)).
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
      };
      // Scroll events fire constantly while the model list scrolls — skip
      // no-op updates.
      setPopupPos((prev) =>
        prev && prev.left === next.left && prev.bottom === next.bottom ? prev : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    // Capture: the transcript scrolls inside a nested container.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // ---- rail entries --------------------------------------------------------
  // The rail is icon-only (~50px); each icon's tooltip carries the agent
  // name. Sections are separated by a divider in the render below.
  // ONLY AVAILABLE entries are listed — uninstalled CLIs/ACP agents and
  // keyless providers used to sit in the rail as grayed-out ghosts, which
  // read as clutter (and as "all agents/providers" instead of what this
  // machine can actually run). Local is always present (built-in).
  const railSections = useMemo(() => {
    const sections: RailEntry[][] = [];
    // Auto leads the rail in its own section — it's not a place a model
    // lives (like a CLI or provider) but a routing mode over all keyed
    // cloud providers, so it's always present and always first.
    sections.push([{ key: "auto", label: "Auto", enabled: true }]);
    const cli = harnesses
      .filter((h) => h.installed)
      .map((h) => ({
        key: `harness:${h.id}`,
        label: h.displayName,
        enabled: true,
      }));
    if (cli.length > 0) sections.push(cli);
    const acp = acpAgents
      .filter((a) => a.installed)
      .map((a) => ({
        key: `acp:${a.id}`,
        label: a.displayName,
        enabled: true,
      }));
    if (acp.length > 0) sections.push(acp);
    const direct: RailEntry[] = [
      { key: "local", label: "Local model", enabled: true },
    ];
    for (const p of PROVIDER_IDS) {
      const cfg = providerCfgs[p];
      if (!cfg?.hasKey) continue;
      direct.push({
        key: `provider:${p}`,
        label: PROVIDER_LABELS[p],
        enabled: true,
      });
    }
    sections.push(direct);
    return sections;
  }, [harnesses, acpAgents, providerCfgs]);

  /** Which rail entry the session is currently running on — highlighted when
   *  the popup opens, and the ✓-carrier in the right pane. */
  const sessionRailKey = useMemo(() => {
    if (agent === "builtin" && provider === "auto") return "auto";
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
    // Provider panes revalidate on every open: their content is curated in
    // Settings (Model list) and reported live by the provider's models API,
    // so a cached pane could show a list the user just edited. Local panes
    // revalidate too — a Model Market download or a folder added in Settings
    // must show up on the next open, not after an app restart (the pane used
    // to cache its first scan for the whole run, which read as "local models
    // are detected only if a custom folder is added"). Harness panes keep
    // their cache outright (CLI configs change far less often) — EXCEPT panes
    // cached before the effort feature / by an older backend: their payload
    // has no `effortOptions` at all (vs [] for "no knob"), so they'd keep the
    // effort slider hidden for the whole run. Mark those for one revalidate.
    for (const key of paneCache.keys()) {
      if (key.startsWith("provider:") || key === "local") refreshOnOpen.current.add(key);
      else if (key.startsWith("harness:")) {
        const cached = paneCache.get(key);
        if (cached?.status === "ready" && cached.effortOptions === undefined) {
          refreshOnOpen.current.add(key);
        }
      }
    }
    // Default to the session's entry; fall back to the first enabled one so
    // the right pane is never empty on first open.
    const fallback = railSections.flat().find((e) => e.enabled)?.key ?? "local";
    setRailKey(sessionRailKey ?? fallback);
    requestAnimationFrame(() => searchRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ---- right-pane model list per rail selection ----------------------------

  // Render the pane immediately from cache; fetch only when there is nothing
  // cached, the cache holds an error, or the entry was marked stale on popup
  // open (stale-while-revalidate — see the reset effect). Switching rail
  // entries never blanks the pane or waits on the network: cached rows show
  // at once and the fresh list swaps in when the fetch lands.
  useEffect(() => {
    railKeyRef.current = railKey;
    if (!open || !railKey) return;
    const cached = paneCache.get(railKey);
    setPane(cached ?? { status: "loading", rows: [] });
    if (cached && cached.status !== "error" && !refreshOnOpen.current.has(railKey)) return;
    refreshOnOpen.current.delete(railKey);
    startPaneFetch(railKey);
  }, [open, railKey, fetchNonce, startPaneFetch]);

  // ---- ranked rows (fuzzy search) -------------------------------------------

  const isAcpPane = railKey.startsWith("acp:");
  const isAutoPane = railKey === "auto";
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
    if (isAcpPane || isAutoPane) return [];
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

  const pickRailEntry = (entry: RailEntry) => {
    // Auto commits STRAIGHT from the rail — there is nothing to choose in
    // its pane (no model rows), so an extra click would be dead weight. The
    // pane only opens when the session is ALREADY auto (rail click then just
    // views it) so the bias slider stays reachable without re-committing.
    // Committed here directly (NOT via pickModel, which keys off the
    // currently-displayed pane and would commit the wrong provider).
    if (entry.key === "auto" && sessionRailKey !== "auto") {
      setOpen(false);
      onPick({ agent: "builtin", provider: "auto", model: "auto" });
      return;
    }
    setRailKey(entry.key);
  };

  const pickModel = (id: string) => {
    setOpen(false);
    if (railKey === "auto") {
      // Auto routing: ChatView flips the session to backend-resolved
      // provider+model per send (cloud providers only).
      onPick({ agent: "builtin", provider: "auto", model: "auto" });
    } else if (railKey.startsWith("harness:")) {
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

  // The chip shows the PROVIDER/AGENT ICON (same marks the picker rail uses)
  // instead of spelling the provider name out — the model name carries the
  // information. Full label survives as the tooltip.
  const chipLabel = useMemo(() => {
    if (agent == null) return null;
    const h = harnessIdOf(agent);
    if (h) {
      const name = harnesses.find((x) => x.id === h)?.displayName ?? h;
      return model ? (modelLabels?.[model] ?? model) : name;
    }
    const a = acpIdOf(agent);
    if (a) return acpAgents.find((x) => x.id === a)?.displayName ?? a;
    if (agent === "local") {
      return model ? shortModelName(model) : "Local model";
    }
    if (agent === "builtin" && provider === "auto") return "Auto";
    if (agent === "builtin") {
      const p = (provider ?? "") as ProviderId;
      return model ? (modelLabels?.[model] ?? model) : (PROVIDER_LABELS[p] ?? "API");
    }
    return null;
  }, [agent, model, provider, modelLabels, harnesses, acpAgents]);

  // Full "Provider · model" text for the tooltip (the label alone no longer
  // names the provider).
  const chipFullLabel = useMemo(() => {
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
    if (agent === "builtin" && provider === "auto") {
      return model && model !== "auto"
        ? `Auto · ${modelLabels?.[model] ?? model} (resolved this chat)`
        : "Auto — Relay picks an available cloud model";
    }
    if (agent === "builtin") {
      const p = (provider ?? "") as ProviderId;
      const name = PROVIDER_LABELS[p] ?? "API";
      return model ? `${name} · ${model}` : name;
    }
    return null;
  }, [agent, model, provider, modelLabels, harnesses, acpAgents]);

  // Same icon set the picker rail renders (Claude slash-A, OpenAI knot, …);
  // falls back to the colored dot for anything the rail doesn't mark.
  const chipIcon = useMemo(() => {
    if (agent == null) return null;
    const h = harnessIdOf(agent);
    if (h) return railIcon(`harness:${h}`, h);
    const a = acpIdOf(agent);
    if (a) return railIcon(`acp:${a}`, a);
    if (agent === "local") return railIcon("local", "Local");
    if (agent === "builtin" && provider === "auto") return railIcon("auto", "Auto");
    if (agent === "builtin") {
      const p = (provider ?? "") as ProviderId;
      return railIcon(`provider:${p}`, PROVIDER_LABELS[p] ?? "API");
    }
    return null;
  }, [agent, provider]);

  const dotClass =
    agent == null ? null : harnessIdOf(agent) || acpIdOf(agent) ? "" : agent === "local" ? "local" : "cloud";

  // ---- render ----------------------------------------------------------------

  // Effort footer: shown on every pane the wire can actually carry it —
  // provider rails and local (local_gguf rides the OpenAI body, so
  // reasoning_effort is sent; servers that don't use it ignore the field,
  // and "" filters to nothing at the send boundary). The Auto pane is bias
  // slider ONLY — stacking a second slider there read as clutter, and a
  // manual effort is ambiguous when the model changes per message.
  // Harness/ACP panes keep the PROVIDER slider off: the CLI/agent owns its
  // own reasoning config. Harness panes get their OWN slider instead —
  // the session tier (showHarnessEffort) — on every pane with tiers.
  const showEffort =
    !!onEffortChange &&
    effort !== undefined &&
    (railKey.startsWith("provider:") || railKey === "local");

  // Harness effort SLIDER tiers: the CLI's spawn-able vocabulary, narrowed to
  // the selected model's own report when the CLI provides one (omp's models
  // dump) — glm-5.2 has no "xhigh", and the slider shouldn't offer tiers the
  // model can't honor.
  const harnessEffortTiers = useMemo(() => {
    if (!railKey.startsWith("harness:") || pane?.status !== "ready") return [] as string[];
    const opts = pane.effortOptions ?? [];
    if (opts.length === 0) return [] as string[];
    const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
    const row = pane.rows.find(
      (r) => r.id === model || r.id.endsWith(`/${bare}`),
    );
    return row?.thinking?.length ? row.thinking : opts;
  }, [railKey, pane?.status, pane?.effortOptions, pane?.rows, model]);

  // The slider shows on EVERY harness pane with tiers, not just the session's
  // own: the tier is stored per chat session and applied to whichever harness
  // spawns, so setting it on a pane the user is browsing still lands on the
  // session (and matters the moment they switch to that harness). Needs a
  // setter; "" (Default) is a legitimate value.
  const showHarnessEffort =
    typeof harnessEffort === "string" &&
    !!onHarnessEffortChange &&
    harnessEffortTiers.length > 0;

  return (
    <div className="agent-menu" ref={rootRef}>
      <button
        type="button"
        className={`agent-chip${chipLabel ? " selected" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={chipFullLabel ?? undefined}
      >
        {chipLabel ? (
          <>
            {loading ? (
              <span className="agent-chip-spinner" aria-hidden="true" />
            ) : chipIcon ? (
              <span className="agent-chip-icon" aria-hidden="true">
                {chipIcon}
              </span>
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

      {/* The popup is portaled to <body>: rendered inside the composer card
          its backdrop-filter could only sample the CARD's paint (a
          backdrop-filter ancestor is a backdrop root), so the frost never
          saw the transcript and the popup read as a thin see-through veil.
          Portaled + viewport-anchored it frosts the real page — the same
          glass the composer card itself shows. */}
      {open &&
        createPortal(
          <div
            className="agent-model-popup"
            role="menu"
            aria-label="Agent and model"
            style={popupPos ?? undefined}
          >
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
                  isAutoPane
                    ? "Relay picks the model per message"
                    : isAcpPane
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
              {isAutoPane ? (
                // Informational only — the rail click already committed the
                // pick; this pane carries the bias slider below.
                <div className="agent-model-auto-info">
                  Auto — Relay picks the best available cloud model for each
                  message. It skips providers whose key is rejected or out of
                  credit and fails over when one is down.
                </div>
              ) : isAcpPane ? (
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
                    : railKey.startsWith("harness:")
                      ? `No models discovered from ${
                          harnesses.find((x) => x.id === railKey.slice("harness:".length))
                            ?.displayName ?? "this CLI"
                        } — turns will use its own default model`
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

            {isAutoPane && onAutoBiasChange && (
              <AutoBiasFooter autoBias={autoBias} onAutoBiasChange={onAutoBiasChange} />
            )}

            {showHarnessEffort && (
              <HarnessEffortFooter
                harnessEffort={harnessEffort}
                onHarnessEffortChange={onHarnessEffortChange}
                paneEffort={pane?.effort}
                tiers={harnessEffortTiers}
              />
            )}

            {/* Endpoint footnote — PINNED under the list (not inside the
                scroll area) so the relay/endpoint is visible without
                scrolling past every model. Host only; full URL in title. */}
            {paneEndpoint && (
              <div className="model-effort-endpoint" title={paneEndpoint}>
                ↦ via {hostOf(paneEndpoint)}
              </div>
            )}

            {showEffort && (
              <ProviderEffortFooter effort={effort} onEffortChange={onEffortChange} />
            )}
          </div>
          </div>,
          document.body,
      )}

      {/* Advanced runtime settings SUB-MODAL — opened by a local row's gear;
          the portaled dialog lives in agentPickerParts.tsx. */}
      {gearFor && onLoadLocalModel && (
        <GearSubModal
          gearFor={gearFor}
          gearDraft={gearDraft}
          setGearDraft={setGearDraft}
          onClose={() => setGearFor(null)}
          onLoadLocalModel={onLoadLocalModel}
          closePopup={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// Memoized (PERF): the picker chip lives inside the composer, which
// re-renders on every keystroke. All props are primitives or stable
// references (ChatView memoizes modelLabels and the callbacks), so memo
// skips the chip subtree on typing re-renders. The open popup re-renders as
// usual whenever its own state changes.
export const AgentModelPicker = memo(AgentModelPickerInner);
