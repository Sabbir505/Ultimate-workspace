// Settings → Wiki (§6.15). Build-model picker across EVERY engine family
// (harness CLIs, cloud API providers), freshness, prompt layering, and the
// page cap. Follows the panel language of Notifications/Mesh (panel-head +
// settings-section + settings-toggle-row + ToggleSwitch) and the two-select
// model-picker convention of SubagentModelPanel: AGENT_OPTIONS sources +
// per-family model loads via listHarnessModels / listChatModels. Empty
// source = the cloud-summarizer chain (anthropic → openai → openrouter).
import { useEffect, useState } from "react";
import { getSetting, setSetting, toastError } from "../../lib/ipc";
import { listChatModels, type ChatModelInfo } from "../../lib/ipc/chatSessions";
import { listHarnessModels, type HarnessModelInfo } from "../../lib/ipc/artifacts";
import { AGENT_OPTIONS } from "../../lib/agents";
import { ToggleSwitch } from "./ToggleSwitch";

const PROVIDER_KEY = "wiki.build_provider";
const MODEL_KEY = "wiki.build_model";
const AUTO_UPDATE_KEY = "wiki.auto_update";
const LAYER_KEY = "wiki.layer_index";
const MAX_PAGES_KEY = "wiki.max_pages";

const HARNESS_SOURCES = AGENT_OPTIONS.filter((o) => o.group === "harness");
const API_SOURCES = AGENT_OPTIONS.filter((o) => o.group === "api");

type ModelRow = { id: string; label: string };

/** Clamp to the range `max_pages_from` accepts in Rust (2..=60), falling
 *  back to its default. The backend silently ignores an out-of-range or
 *  unparseable value, so typing "500" persisted something that then read as
 *  "20" with no indication anything was wrong. */
export function normalizeMaxPages(raw: string | null): string {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 2 || n > 60) return "20";
  return String(n);
}

export function WikiPanel() {
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(null);
  const [layerIndex, setLayerIndex] = useState<boolean | null>(null);
  const [maxPages, setMaxPages] = useState<string | null>(null);

  useEffect(() => {
    // Without this guard the settings resolve after the panel closes and
    // write state into an unmounted tree.
    let alive = true;
    void Promise.all([
      getSetting(PROVIDER_KEY),
      getSetting(MODEL_KEY),
      getSetting(AUTO_UPDATE_KEY),
      getSetting(LAYER_KEY),
      getSetting(MAX_PAGES_KEY),
    ])
      .then(([p, m, a, l, mp]) => {
        if (!alive) return;
        setProvider(p ?? "");
        setModel(m ?? "");
        setAutoUpdate(a == null || a.trim() !== "false");
        setLayerIndex(l == null || l.trim() !== "false");
        setMaxPages(mp ?? "20");
      })
      .catch((e) => toastError("Failed to load wiki settings", e));
    return () => {
      alive = false;
    };
  }, []);

  // Load the chosen family's model catalog — the SAME list the composer's
  // picker shows for that family. local_gguf is deliberately not offered:
  // the chat sidecar's context window can't carry page-sized file bundles.
  useEffect(() => {
    if (provider == null || provider === "") {
      setModels([]);
      setLoadingModels(false);
      return;
    }
    let alive = true;
    setLoadingModels(true);
    const isHarness = HARNESS_SOURCES.some((o) => o.id === provider);
    const load: Promise<ModelRow[]> = isHarness
      ? listHarnessModels(provider).then((cfg) =>
          (cfg?.models ?? []).map((m: HarnessModelInfo) => ({
            id: m.id,
            label: m.label || m.id,
          })),
        )
      : listChatModels(provider).then((list) =>
          (list ?? []).map((m: ChatModelInfo) => ({ id: m.id, label: m.id })),
        );
    load
      .then((rows) => {
        if (alive) setModels(rows);
      })
      .catch(() => {
        if (alive) setModels([]);
      })
      .finally(() => {
        if (alive) setLoadingModels(false);
      });
    return () => {
      alive = false;
    };
  }, [provider]);

  const pickSource = (source: string) => {
    setProvider(source);
    setModel("");
    setModels([]);
    void setSetting(PROVIDER_KEY, source).catch(() => {});
    void setSetting(MODEL_KEY, "").catch(() => {});
  };

  const pickModel = (id: string) => {
    setModel(id);
    void setSetting(MODEL_KEY, id).catch(() => {});
  };

  const savedModel = model ?? "";
  // A saved model that the family's catalog no longer lists stays selectable.
  const rows: ModelRow[] =
    savedModel && !models.some((r) => r.id === savedModel)
      ? [{ id: savedModel, label: `${savedModel} (saved)` }, ...models]
      : models;
  const isHarness = HARNESS_SOURCES.some((o) => o.id === provider);

  return (
    <>
      <div className="panel-head">
        <h3>Project Wiki</h3>
        <span className="panel-count">Generated project knowledge</span>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Build model</div>
        <p className="settings-section-hint">
          Writes the pages. Harness CLIs build with their own login — subscriptions and
          free-tier models work. Empty source = the first configured cloud provider
          (anthropic → openai → openrouter).
        </p>
        <div className="settings-row" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            aria-label="Wiki build source"
            data-testid="wiki-build-provider"
            value={provider ?? ""}
            onChange={(e) => pickSource(e.target.value)}
            style={{ minWidth: 200 }}
          >
            <option value="">Auto (summarizer chain)</option>
            <optgroup label="CLI Agents">
              {HARNESS_SOURCES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Cloud APIs">
              {API_SOURCES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </optgroup>
          </select>
          {provider ? (
            loadingModels ? (
              <span
                className="muted"
                data-testid="wiki-models-loading"
                style={{ alignSelf: "center", fontSize: 12 }}
              >
                Probing {provider} for models…
              </span>
            ) : (
              <select
                aria-label="Wiki build model"
                data-testid="wiki-build-model"
                value={savedModel}
                onChange={(e) => pickModel(e.target.value)}
                style={{ minWidth: 220 }}
              >
                <option value="">
                  {isHarness ? "CLI default model" : "Provider default model"}
                </option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            )
          ) : (
            <span className="muted" style={{ alignSelf: "center", fontSize: 12 }}>
              Uses whichever cloud provider is configured first.
            </span>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Freshness</div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Auto-update on commit</span>
            <span className="settings-toggle-desc">
              {autoUpdate == null
                ? "Loading…"
                : autoUpdate
                  ? "Relay re-checks each wiki's HEAD every minute; pages regenerate only when their cited sources changed — a clean repo costs nothing."
                  : "Update manually with the Update button in the Wiki tab."}
            </span>
          </div>
          <ToggleSwitch
            checked={autoUpdate ?? true}
            onChange={(v) => {
              setAutoUpdate(v);
              void setSetting(AUTO_UPDATE_KEY, v ? "true" : "false").catch(() => {});
            }}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Agent context</div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Layer page index into prompts</span>
            <span className="settings-toggle-desc">
              {layerIndex == null
                ? "Loading…"
                : layerIndex
                  ? "Chats and harness sessions see the page index (capped, firewalled) beside AGENTS.md, and pull pages via the search_wiki / read_wiki_page tools."
                  : "Agents discover the wiki only through the tools."}
            </span>
          </div>
          <ToggleSwitch
            checked={layerIndex ?? true}
            onChange={(v) => {
              setLayerIndex(v);
              void setSetting(LAYER_KEY, v ? "true" : "false").catch(() => {});
            }}
          />
        </div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <span className="settings-toggle-name">Page cap</span>
            <span className="settings-toggle-desc">
              Maximum pages per build (2–60). Monorepos: fewer, broader pages stay fresher.
            </span>
          </div>
          <input
            aria-label="Wiki page cap"
            data-testid="wiki-max-pages"
            value={maxPages ?? ""}
            onChange={(e) => setMaxPages(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              // Persist on Enter too — onBlur alone meant typing a value and
              // pressing Enter silently discarded it.
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            onBlur={() => void setSetting(MAX_PAGES_KEY, normalizeMaxPages(maxPages)).catch(() => {})}
            style={{ width: 64 }}
          />
        </div>
      </div>
    </>
  );
}
