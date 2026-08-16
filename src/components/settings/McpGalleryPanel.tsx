/**
 * MCP server gallery (§3.2.14): one-click install of popular stdio MCP
 * servers + custom entries. Installed & enabled servers attach to every
 * tool-enabled chat turn; their tools surface to the model as
 * `mcp_<server>_<tool>` with the same Read/Write approval gating as
 * connectors. See src-tauri/src/mcp_gallery.rs for the backend design.
 */

import { useCallback, useEffect, useState } from "react";
import {
  mcpGalleryConnect,
  mcpGalleryDisconnect,
  mcpGalleryInstall,
  mcpGalleryList,
  mcpGalleryRemove,
  mcpGallerySetEnabled,
  type McpCatalogEntry,
  type McpConnectResult,
  type McpGalleryList,
  type McpServerDef,
} from "../../lib/ipc";
import { toastError } from "../../lib/ipc";

interface ToolPreview {
  serverId: string;
  tools: McpConnectResult["tools"];
}

export function McpGalleryPanel() {
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<McpServerDef[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toolPreview, setToolPreview] = useState<ToolPreview | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  // Custom-server form state.
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [customEnv, setCustomEnv] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customBusy, setCustomBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await mcpGalleryList();
      if (list) {
        setCatalog(list.catalog || []);
        setInstalled(list.installed || []);
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

  const removeServer = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await mcpGalleryRemove(id);
        if (toolPreview?.serverId === id) setToolPreview(null);
        await refresh();
      } catch (err) {
        toastError("Remove failed", err);
      } finally {
        setBusyId(null);
      }
    },
    [refresh, toolPreview],
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

  const connectServer = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const result = await mcpGalleryConnect(id);
        if (result) setToolPreview({ serverId: id, tools: result.tools || [] });
      } catch (err) {
        toastError("Connect failed (first run may download packages)", err);
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const disconnectServer = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await mcpGalleryDisconnect(id);
      if (toolPreview?.serverId === id) setToolPreview(null);
    } catch (err) {
      toastError("Disconnect failed", err);
    } finally {
      setBusyId(null);
    }
  }, [toolPreview]);

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

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h2>MCP Servers</h2>
      </div>
      <p className="settings-note">
        Install MCP servers to give the built-in chat extra tools. Enabled servers attach to
        every tool-enabled conversation; their tools appear to the model as
        <code> mcp_&lt;server&gt;_&lt;tool&gt;</code> and writes go through the same approval
        flow as connectors. <code>npx</code>-based servers need Node on PATH;
        <code> uvx</code>-based ones need <a href="https://astral.sh" target="_blank" rel="noreferrer">uv</a>.
      </p>

      {/* Installed servers */}
      {installed.length > 0 && (
        <>
          <h3 className="mcp-gallery-subhead">Your servers</h3>
          <div className="mcp-installed-list">
            {installed.map((def) => {
              const preview = toolPreview?.serverId === def.id ? toolPreview : null;
              return (
                <div key={def.id} className="mcp-installed-row">
                  <div className="mcp-installed-main">
                    <label className="mcp-installed-name">
                      <input
                        type="checkbox"
                        checked={def.enabled}
                        disabled={busyId === def.id}
                        onChange={() => void toggleEnabled(def)}
                      />
                      {def.name}
                      {def.fromGallery && <span className="mcp-badge">gallery</span>}
                      {!def.enabled && <span className="mcp-badge mcp-badge-off">off</span>}
                    </label>
                    <div className="mcp-installed-cmd">
                      {def.command} {def.args.join(" ")}
                    </div>
                    {preview && (
                      <div className="mcp-tool-preview">
                        {preview.tools.length === 0 ? (
                          <span className="mcp-tool-kind">no tools exposed</span>
                        ) : (
                          preview.tools.map((t) => (
                            <span key={t.wireName} className="mcp-tool-chip" title={t.description || t.rawName}>
                              <span className={`mcp-tool-kind mcp-tool-${t.kind}`}>{t.kind}</span>
                              {t.rawName}
                            </span>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <div className="mcp-installed-actions">
                    <button
                      className="ghost"
                      disabled={busyId === def.id}
                      onClick={() => void connectServer(def.id)}
                    >
                      {busyId === def.id ? "…" : "Connect"}
                    </button>
                    <button
                      className="ghost"
                      disabled={busyId === def.id}
                      onClick={() => void disconnectServer(def.id)}
                    >
                      Stop
                    </button>
                    <button
                      className="ghost danger"
                      disabled={busyId === def.id}
                      onClick={() => void removeServer(def.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Gallery */}
      <h3 className="mcp-gallery-subhead">Gallery</h3>
      <div className="mcp-gallery-grid">
        {catalog.map((entry) => {
          const installedAlready = installedIds.has(entry.id);
          return (
            <div key={entry.id} className="mcp-gallery-card">
              <div className="mcp-gallery-card-head">
                <strong>{entry.name}</strong>
                {installedAlready ? (
                  <span className="mcp-badge mcp-badge-on">installed</span>
                ) : (
                  <button
                    className="primary"
                    disabled={installing === entry.id}
                    onClick={() => void installFromCatalog(entry.id)}
                  >
                    {installing === entry.id ? "Installing…" : "Install"}
                  </button>
                )}
              </div>
              <div className="mcp-gallery-card-desc">{entry.description}</div>
              <code className="mcp-gallery-card-cmd">
                {entry.command} {entry.args.join(" ")}
              </code>
            </div>
          );
        })}
      </div>

      {/* Custom server */}
      <h3 className="mcp-gallery-subhead">Custom server</h3>
      {!customOpen ? (
        <div>
          <button className="ghost" onClick={() => setCustomOpen(true)}>
            + Add custom stdio server
          </button>
        </div>
      ) : (
        <div className="settings-form-row" style={{ alignItems: "flex-start" }}>
          <div className="settings-form-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <input
              placeholder="Name (e.g. My Company MCP)"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
            />
            <input
              placeholder="Command (e.g. npx or C:\path\to\server.exe)"
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
            />
            <input
              placeholder="Arguments, space-separated (e.g. -y @some/mcp-server)"
              value={customArgs}
              onChange={(e) => setCustomArgs(e.target.value)}
            />
            <textarea
              placeholder={"Environment, one KEY=value per line (API keys etc.)"}
              value={customEnv}
              onChange={(e) => setCustomEnv(e.target.value)}
              rows={3}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="primary" disabled={customBusy} onClick={() => void saveCustom()}>
                {customBusy ? "Adding…" : "Add server"}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setCustomOpen(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
