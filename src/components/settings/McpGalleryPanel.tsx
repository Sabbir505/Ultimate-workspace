/**
 * MCP server gallery (§3.2.14): one-click install of popular stdio MCP
 * servers + custom entries. Installed & enabled servers attach to every
 * tool-enabled chat turn; their tools surface to the model as
 * `mcp_<server>_<tool>` with the same Read/Write approval gating as
 * connectors. See src-tauri/src/mcp_gallery.rs for the backend design.
 *
 * UX notes: enabled/disabled is the persistent mental model (toggle);
 * Connect is a one-shot "start + list tools" test (sessions are lazy and
 * self-healing per chat turn), so its button pairs with Stop rather than a
 * fake daemon lifecycle.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  Check,
  Clock,
  Database,
  FlaskConical,
  FolderOpen,
  GitBranch,
  Globe,
  Network,
  Plus,
  Puzzle,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  mcpGalleryConnect,
  mcpGalleryDisconnect,
  mcpGalleryInstall,
  mcpGalleryList,
  mcpGalleryRemove,
  mcpGallerySetEnabled,
  mcpRegistryInstall,
  mcpRegistrySearch,
  type McpCatalogEntry,
  type McpConnectResult,
  type McpGalleryList,
  type McpServerDef,
  type RegistryServerEntry,
  type McpToolView,
} from "../../lib/ipc";
import { toastError } from "../../lib/ipc";
import { confirmDialog } from "../../state/confirm";

/** Icon tile per catalog id; custom servers fall back to the puzzle piece. */
const SERVER_ICONS: Record<string, LucideIcon> = {
  filesystem: FolderOpen,
  memory: Brain,
  sequentialthinking: Network,
  everything: FlaskConical,
  fetch: Globe,
  git: GitBranch,
  sqlite: Database,
  time: Clock,
};

function ServerIcon({ id, size = 15 }: { id: string; size?: number }) {
  const Icon = SERVER_ICONS[id] ?? Puzzle;
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}

/** Runtime badge: what this server's command needs on PATH. */
function runtimeOf(command: string): { label: string; hint: string } | null {
  const cmd = command.trim().toLowerCase();
  if (cmd === "npx") return { label: "node", hint: "Requires Node.js on PATH" };
  if (cmd === "uvx") return { label: "uv", hint: "Requires uv (astral.sh) on PATH" };
  return null;
}

/** iOS-style toggle switch — same visual language as SettingsView prefs. */
function ServerToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? "Disable server" : "Enable server"}
      className={`settings-toggle${checked ? " on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-thumb" />
    </button>
  );
}

export function McpGalleryPanel() {
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<McpServerDef[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  // Per-server tool previews (Connect result), keyed by server id so each
  // card keeps its own chips instead of one global overwrite.
  const [previews, setPreviews] = useState<Record<string, McpToolView[]>>({});
  // Custom-server form state.
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [customEnv, setCustomEnv] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customBusy, setCustomBusy] = useState(false);
  // Official MCP registry (§4.3.3): lazy search + one-click install. Kept
  // lazy so the panel paints instantly; a search only fires on demand.
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryResults, setRegistryResults] = useState<RegistryServerEntry[]>([]);
  const [registrySearching, setRegistrySearching] = useState(false);
  const [registrySearched, setRegistrySearched] = useState(false);
  const [registryInstalling, setRegistryInstalling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await mcpGalleryList();
      if (list) {
        setCatalog(list.catalog || []);
        setInstalled(list.installed || []);
        // Drop previews for servers that no longer exist.
        setPreviews((prev) => {
          const alive = new Set((list.installed || []).map((d) => d.id));
          const next: Record<string, McpToolView[]> = {};
          for (const [id, tools] of Object.entries(prev)) {
            if (alive.has(id)) next[id] = tools;
          }
          return next;
        });
      }
    } catch (err) {
      toastError("Failed to load MCP gallery", err);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installFromCatalog = useCallback(
    async (entryId: string) => {
      setInstalling(entryId);
      try {
        await mcpGalleryInstall(entryId);
        await refresh();
      } catch (err) {
        toastError("Install failed", err);
      } finally {
        setInstalling(null);
      }
    },
    [refresh],
  );

  const searchRegistry = useCallback(async (q: string) => {
    setRegistrySearching(true);
    try {
      const results = await mcpRegistrySearch(q, 30);
      setRegistryResults(results ?? []);
      setRegistrySearched(true);
    } catch (err) {
      // A failed search still counts as "answered" — the empty state below
      // must render, not leave the previous results (or nothing) hanging.
      setRegistryResults([]);
      setRegistrySearched(true);
      toastError("Registry search failed", err);
    } finally {
      setRegistrySearching(false);
    }
  }, []);

  // Auto-search: fires DEBOUNCED as the user types (400ms) — no Search
  // button to press. Cleared input clears the results; stale in-flight
  // responses are discarded so a fast typist never sees an older query's
  // results land under a newer one.
  useEffect(() => {
    const q = registryQuery.trim();
    if (!q) {
      setRegistryResults([]);
      setRegistrySearched(false);
      return;
    }
    const t = window.setTimeout(() => {
      void searchRegistry(q);
    }, 400);
    return () => window.clearTimeout(t);
  }, [registryQuery, searchRegistry]);

  const installFromRegistry = useCallback(
    async (entry: RegistryServerEntry) => {
      setRegistryInstalling(entry.name);
      try {
        await mcpRegistryInstall(entry);
        await refresh();
      } catch (err) {
        toastError("Registry install failed", err);
      } finally {
        setRegistryInstalling(null);
      }
    },
    [refresh],
  );

    const removeServer = useCallback(
    async (def: McpServerDef) => {
      // In-app confirm — window.confirm is rejected by this webview (see
      // state/confirm.ts).
      const ok = await confirmDialog({
        title: "Remove MCP server",
        body: `Remove "${def.name}"? Its process will be stopped.`,
        confirmLabel: "Remove server",
      });
      if (!ok) return;
      setBusyId(def.id);
      try {
        await mcpGalleryRemove(def.id);
        await refresh();
      } catch (err) {
        toastError("Remove failed", err);
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const toggleEnabled = useCallback(
    async (def: McpServerDef) => {
      setBusyId(def.id);
      try {
        await mcpGallerySetEnabled(def.id, !def.enabled);
        await refresh();
      } catch (err) {
        toastError("Toggle failed", err);
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const connectServer = useCallback(async (id: string) => {
    setConnectingId(id);
    try {
      const result = await mcpGalleryConnect(id);
      if (result) setPreviews((prev) => ({ ...prev, [id]: result.tools || [] }));
    } catch (err) {
      toastError("Connect failed (first run may download packages)", err);
    } finally {
      setConnectingId(null);
    }
  }, []);

  const disconnectServer = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await mcpGalleryDisconnect(id);
      setPreviews((prev) => {
        const { [id]: _dropped, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      toastError("Disconnect failed", err);
    } finally {
      setBusyId(null);
    }
  }, []);

  const saveCustom = useCallback(async () => {
    setCustomBusy(true);
    try {
      const env: Record<string, string> = {};
      for (const line of customEnv.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const eq = t.indexOf("=");
        if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
      }
      await mcpGalleryInstall(undefined, {
        name: customName,
        command: customCommand,
        args: customArgs.split(/\s+/).filter(Boolean),
        env,
        description: "",
        enabled: true,
      });
      setCustomName("");
      setCustomCommand("");
      setCustomArgs("");
      setCustomEnv("");
      setCustomOpen(false);
      await refresh();
    } catch (err) {
      toastError("Add server failed", err);
    } finally {
      setCustomBusy(false);
    }
  }, [customArgs, customCommand, customEnv, customName, refresh]);

  const installedIds = new Set(installed.map((d) => d.id));
  const enabledCount = installed.filter((d) => d.enabled).length;
  const canAddCustom = Boolean(customName.trim()) && Boolean(customCommand.trim());

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>MCP Servers</h3>
        {installed.length > 0 && (
          <span className="panel-count">
            {enabledCount} of {installed.length} active
          </span>
        )}
      </div>
      <p className="mcp-lede">Give the built-in chat extra tools by installing MCP servers.</p>

      <details className="mcp-details">
        <summary>How MCP tools work in chat</summary>
        <ul>
          <li>Enabled servers attach to every tool-enabled conversation automatically.</li>
          <li>
            Their tools appear to the model as <code>mcp_&lt;server&gt;_&lt;tool&gt;</code>; writes go
            through the same approval flow as connectors.
          </li>
          <li>
            <code>npx</code>-based servers need Node.js on PATH; <code>uvx</code>-based ones need{" "}
            <a href="https://astral.sh" target="_blank" rel="noreferrer">
              uv
            </a>
            .
          </li>
        </ul>
      </details>

      {/* Installed servers */}
      <h3 className="mcp-gallery-subhead">
        Your servers
        {installed.length > 0 && <span className="mcp-subhead-count">{installed.length}</span>}
      </h3>
      {installed.length === 0 ? (
        <div className="mcp-empty">
          <Puzzle size={20} strokeWidth={1.5} aria-hidden />
          <div>
            <strong>No servers yet</strong>
            <span>Pick one from the gallery below — installing takes one click.</span>
          </div>
        </div>
      ) : (
        <div className="mcp-installed-list">
          {installed.map((def) => {
            const busy = busyId === def.id || connectingId === def.id;
            const preview = previews[def.id];
            return (
              <div key={def.id} className={`mcp-server-card${def.enabled ? "" : " off"}`}>
                <div className="mcp-server-head">
                  <span className="mcp-server-icon">
                    <ServerIcon id={def.id} />
                  </span>
                  <span className="mcp-server-name">{def.name}</span>
                  <span className="mcp-badge">{def.fromGallery ? "gallery" : "custom"}</span>
                  <ServerToggle
                    checked={def.enabled}
                    disabled={busyId === def.id}
                    onChange={() => void toggleEnabled(def)}
                  />
                </div>
                <div className={`mcp-server-status ${def.enabled ? "on" : "off"}`}>
                  <span className="mcp-status-dot" />
                  {def.enabled ? "Active · attaches to every tool-enabled chat" : "Off · not attached to chats"}
                </div>
                <code className="mcp-server-cmd">
                  {def.command} {def.args.join(" ")}
                </code>
                {preview && (
                  <div className="mcp-tool-preview">
                    {preview.length === 0 ? (
                      <span className="mcp-tool-none">connected — no tools exposed</span>
                    ) : (
                      preview.map((t) => (
                        <span key={t.wireName} className="mcp-tool-chip" title={t.description || t.rawName}>
                          <span className={`mcp-tool-kind mcp-tool-${t.kind}`}>{t.kind}</span>
                          {t.rawName}
                        </span>
                      ))
                    )}
                  </div>
                )}
                <div className="mcp-server-actions">
                  {preview ? (
                    <button
                      className="ghost"
                      disabled={busy}
                      title="Stops the server process now; it restarts automatically when a chat needs it"
                      onClick={() => void disconnectServer(def.id)}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      className="ghost"
                      disabled={busy}
                      title="Starts the server once and lists the tools it exposes"
                      onClick={() => void connectServer(def.id)}
                    >
                      {connectingId === def.id && <span className="mcp-spinner" />}
                      Connect
                    </button>
                  )}
                  <button
                    className="mcp-remove-btn"
                    disabled={busy}
                    title={`Remove ${def.name}`}
                    aria-label={`Remove ${def.name}`}
                    onClick={() => void removeServer(def)}
                  >
                    <Trash2 size={17} strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Gallery */}
      <h3 className="mcp-gallery-subhead">Gallery</h3>
      <div className="mcp-gallery-grid">
        {catalog.map((entry) => {
          const installedAlready = installedIds.has(entry.id);
          const rt = runtimeOf(entry.command);
          return (
            <div key={entry.id} className={`mcp-gallery-card${installedAlready ? " installed" : ""}`}>
              <div className="mcp-gallery-card-head">
                <span className="mcp-server-icon">
                  <ServerIcon id={entry.id} />
                </span>
                <strong>{entry.name}</strong>
                {rt && (
                  <span className="mcp-runtime" title={rt.hint}>
                    {rt.label}
                  </span>
                )}
              </div>
              <div className="mcp-gallery-card-desc">{entry.description}</div>
              <div className="mcp-gallery-card-foot">
                {installedAlready ? (
                  <span className="mcp-badge mcp-badge-on">
                    <Check size={11} strokeWidth={2.5} /> Installed
                  </span>
                ) : (
                  <>
                    <code className="mcp-gallery-card-cmd">
                      {entry.command} {entry.args.join(" ")}
                    </code>
                    <button
                      className="primary"
                      disabled={installing === entry.id}
                      onClick={() => void installFromCatalog(entry.id)}
                    >
                      {installing === entry.id && <span className="mcp-spinner light" />}
                      {installing === entry.id ? "Installing" : "Install"}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Official registry (§4.3.3): open index, status-badged, one-click.
          Installed defs are NOT gallery-trusted (fromGallery=false) — the
          exec gate still confirms the first spawn. */}
      <h3 className="mcp-gallery-subhead">Registry</h3>
      <div className={`mcp-registry-search${registrySearching ? " searching" : ""}`}>
        <input
          placeholder="Search the official MCP registry — filesystem, github, sqlite…"
          value={registryQuery}
          aria-label="Search the official MCP registry"
          onChange={(e) => setRegistryQuery(e.target.value)}
        />
        {registrySearching && <span className="mcp-spinner" aria-label="Searching" />}
      </div>
      {registrySearching && registryResults.length === 0 && (
        <div className="mcp-registry-loading" role="status">
          <span className="mcp-spinner" />
          Searching the registry…
        </div>
      )}
      {registrySearched && registryResults.length === 0 && !registrySearching && (
        <p className="muted">No registry servers matched.</p>
      )}
      <div className="mcp-gallery-grid">
        {registryResults.map((entry) => {
          const first = entry.packages[0];
          const installable = !entry.remoteOnly && entry.packages.length > 0;
          const verified = entry.status === "active" && entry.isLatest;
          return (
            <div key={entry.name} className="mcp-gallery-card" data-testid="registry-result">
              <div className="mcp-gallery-card-head">
                <strong title={entry.name}>{entry.title || entry.name}</strong>
                <span
                  className={`mcp-badge ${verified ? "mcp-badge-on" : ""}`}
                  title={`Registry status: ${entry.status}${entry.isLatest ? " (latest version)" : ""}`}
                >
                  {verified ? "registry ✓" : entry.status}
                </span>
              </div>
              <code className="mcp-gallery-card-cmd">{entry.name}</code>
              <div className="mcp-gallery-card-desc">{entry.description}</div>
              <div className="mcp-gallery-card-foot">
                {first && (
                  <code className="mcp-gallery-card-cmd">
                    {first.registryType}
                    {entry.version ?? first.version ? ` · v${entry.version ?? first.version}` : ""}
                    {first.envVars.length > 0 ? ` · env: ${first.envVars.map((v) => v.name).join(", ")}` : ""}
                  </code>
                )}
                {entry.remoteOnly ? (
                  <span className="mcp-badge" title="This server is streamable-HTTP only — connect it through Settings → Connectors.">
                    remote-only
                  </span>
                ) : installable ? (
                  <button
                    className="primary"
                    disabled={registryInstalling === entry.name}
                    onClick={() => void installFromRegistry(entry)}
                  >
                    {registryInstalling === entry.name ? "Installing" : "Install"}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom server */}
      <h3 className="mcp-gallery-subhead">Custom server</h3>
      {!customOpen ? (
        <button type="button" className="mcp-add-trigger" onClick={() => setCustomOpen(true)}>
          <Plus size={15} strokeWidth={1.75} />
          Add custom server
        </button>
      ) : (
        <form
          className="mcp-custom-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAddCustom && !customBusy) void saveCustom();
          }}
        >
          <div className="mcp-form-grid">
            <label className="mcp-field">
              <span>Name</span>
              <input
                placeholder="My Company MCP"
                value={customName}
                autoFocus
                onChange={(e) => setCustomName(e.target.value)}
              />
            </label>
            <label className="mcp-field">
              <span>Command</span>
              <input
                placeholder="npx or C:\path\to\server.exe"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
              />
            </label>
          </div>
          <label className="mcp-field">
            <span>Arguments</span>
            <input
              placeholder="-y @some/mcp-server --port 3000"
              value={customArgs}
              onChange={(e) => setCustomArgs(e.target.value)}
            />
            <small>Space-separated.</small>
          </label>
          <label className="mcp-field">
            <span>Environment variables</span>
            <textarea
              rows={3}
              placeholder={"API_KEY=…\nOTHER=value"}
              value={customEnv}
              onChange={(e) => setCustomEnv(e.target.value)}
            />
            <small>One KEY=value per line — passed to the server process.</small>
          </label>
          <div className="mcp-form-foot">
            <button type="button" className="ghost" onClick={() => setCustomOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!canAddCustom || customBusy}>
              {customBusy ? "Adding…" : "Add server"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
