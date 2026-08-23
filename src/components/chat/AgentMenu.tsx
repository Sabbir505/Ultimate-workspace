// Agent selector chip for the chat composer — mockup 02 (state B). The
// leftmost chip: "Select agent ▾" until one is picked, then the agent's name
// with a live status dot. The dropdown lists the installed CLI harnesses
// (from `list_harnesses`), uninstalled ones dimmed/disabled, then a divider
// and the two non-CLI modes that keep today's behavior: built-in cloud chat
// and local GGUF models.
import { useEffect, useRef, useState } from "react";
import { listHarnesses, listAcpAgents } from "../../lib/ipc";
import type { HarnessStatus, AcpAgentStatus } from "../../types";

interface Props {
  /** Current selection: null/undefined = none (locked state). Values:
   *  "builtin" | "local" | "harness:<id>" | "acp:<id>". */
  agent: string | null | undefined;
  onAgentChange: (agent: string) => void;
  /** True while the selected harness is "opening" — its config/models are
   *  being discovered (listHarnessModels runs live CLI queries). Shows a
   *  spinner on the chip instead of the status dot. */
  loading?: boolean;
}

/** Module-level status cache (stale-while-revalidate). The backend probes
 *  each CLI with `--version` (spawning real processes), so a cold fetch can
 *  take seconds; caching here means reopening the menu paints instantly from
 *  the last-known statuses while a background refresh updates them. Also
 *  prefetched once per app run as soon as the composer mounts, so by the
 *  time the user first clicks the chip the rows are usually already there. */
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

/** Parse "harness:<id>" → the harness id; null for builtin/local/none. */
function harnessIdOf(agent: string | null | undefined): string | null {
  return agent?.startsWith("harness:") ? agent.slice("harness:".length) : null;
}

/** Parse "acp:<id>" → the ACP agent id; null for everything else. */
function acpIdOf(agent: string | null | undefined): string | null {
  return agent?.startsWith("acp:") ? agent.slice("acp:".length) : null;
}

export function AgentMenu({ agent, onAgentChange, loading }: Props) {
  const [open, setOpen] = useState(false);
  // Seeded from the module cache so an open paints last-known rows instantly;
  // the effect below refreshes in the background.
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>(() => agentStatusCache?.harnesses ?? []);
  const [acpAgents, setAcpAgents] = useState<AcpAgentStatus[]>(() => agentStatusCache?.acpAgents ?? []);
  const rootRef = useRef<HTMLDivElement>(null);

  // Prefetch once per app run as soon as the composer mounts — warms the
  // cache before the user's first click so the menu opens populated.
  useEffect(() => {
    if (agentStatusCache) return;
    return fetchAgentStatuses((h, a) => {
      setHarnesses(h);
      setAcpAgents(a);
    });
  }, []);

  // Refresh the statuses every time the menu opens so a CLI installed
  // mid-session shows up without an app restart. The popup renders from
  // cached state immediately; this only updates it.
  useEffect(() => {
    if (!open) return;
    return fetchAgentStatuses((h, a) => {
      setHarnesses(h);
      setAcpAgents(a);
    });
  }, [open]);

  // Close on outside pointer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const selectedHarness = harnessIdOf(agent);
  const selectedAcp = acpIdOf(agent);
  const selectedName = selectedHarness
    ? (harnesses.find((h) => h.id === selectedHarness)?.displayName ?? selectedHarness)
    : selectedAcp
      ? (acpAgents.find((a) => a.id === selectedAcp)?.displayName ?? selectedAcp)
      : agent === "local"
        ? "Local model"
        : agent === "builtin"
          ? "API based"
          : null;

  const pick = (value: string) => {
    onAgentChange(value);
    setOpen(false);
  };

  return (
    <div className="agent-menu" ref={rootRef}>
      <button
        type="button"
        className={`agent-chip${selectedName ? " selected" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {/* No title tooltip: the label already reads "Select agent", and the
            native hover tooltip rendered as a stray white box that looked
            like a second ghost button under the cursor. */}
        {selectedName ? (
          <>
            {loading ? (
              <span className="agent-chip-spinner" aria-hidden="true" />
            ) : (
              <span className="agent-dot" aria-hidden="true" />
            )}
            {selectedName}
          </>
        ) : (
          <>⌘ Select agent</>
        )}
        <span className="model-effort-chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="agent-menu-popup" role="menu" aria-label="Agents">
          <div className="model-effort-section-label">Agents · CLI</div>
          {harnesses.map((h) => (
            <button
              key={h.id}
              type="button"
              role="menuitemradio"
              aria-checked={agent === `harness:${h.id}`}
              className={`model-effort-item agent-item${
                agent === `harness:${h.id}` ? " selected" : ""
              }${h.installed ? "" : " disabled"}`}
              disabled={!h.installed}
              onClick={() => pick(`harness:${h.id}`)}
            >
              <span className="agent-item-name">
                <span className={`agent-dot${h.installed ? "" : " off"}`} aria-hidden="true" />
                {h.displayName}
              </span>
              <span className={`agent-status${h.installed ? " on" : ""}`}>
                {h.installed ? "installed" : "not installed"}
              </span>
            </button>
          ))}
          {/* ACP agents (roadmap #20): Zed/Devin-ecosystem CLIs speaking the
              Agent Client Protocol over stdio. Same installed/dimmed shape as
              the harness list. */}
          {acpAgents.length > 0 && (
            <>
              <div className="model-effort-section-label">Agents · ACP</div>
              {acpAgents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={agent === `acp:${a.id}`}
                  className={`model-effort-item agent-item${
                    agent === `acp:${a.id}` ? " selected" : ""
                  }${a.installed ? "" : " disabled"}`}
                  disabled={!a.installed}
                  onClick={() => pick(`acp:${a.id}`)}
                >
                  <span className="agent-item-name">
                    <span className={`agent-dot${a.installed ? "" : " off"}`} aria-hidden="true" />
                    {a.displayName}
                  </span>
                  <span className={`agent-status${a.installed ? " on" : ""}`}>
                    {a.installed ? "installed" : "not installed"}
                  </span>
                </button>
              ))}
            </>
          )}
          {/* Gemini CLI isn't a harness adapter yet — shown as a disabled
              placeholder like the mockup's "not installed" row. */}
          <button type="button" className="model-effort-item agent-item disabled" disabled>
            <span className="agent-item-name">
              <span className="agent-dot off" aria-hidden="true" />
              Gemini CLI
            </span>
            <span className="agent-status">not installed</span>
          </button>
          <div className="model-effort-divider" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={agent === "builtin"}
            className={`model-effort-item agent-item${agent === "builtin" ? " selected" : ""}`}
            onClick={() => pick("builtin")}
          >
            <span className="agent-item-name">☁ API based</span>
            <span className="agent-status">direct API</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={agent === "local"}
            className={`model-effort-item agent-item${agent === "local" ? " selected" : ""}`}
            onClick={() => pick("local")}
          >
            <span className="agent-item-name">🖥 Local model</span>
            <span className="agent-status">GGUF · offline</span>
          </button>
        </div>
      )}
    </div>
  );
}
