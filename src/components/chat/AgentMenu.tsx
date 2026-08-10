// Agent selector chip for the chat composer — mockup 02 (state B). The
// leftmost chip: "Select agent ▾" until one is picked, then the agent's name
// with a live status dot. The dropdown lists the installed CLI harnesses
// (from `list_harnesses`), uninstalled ones dimmed/disabled, then a divider
// and the two non-CLI modes that keep today's behavior: built-in cloud chat
// and local GGUF models.
import { useEffect, useRef, useState } from "react";
import { listHarnesses } from "../../lib/ipc";
import type { HarnessStatus } from "../../types";

interface Props {
  /** Current selection: null/undefined = none (locked state). Values:
   *  "builtin" | "local" | "harness:<id>". */
  agent: string | null | undefined;
  onAgentChange: (agent: string) => void;
  /** True while the selected harness is "opening" — its config/models are
   *  being discovered (listHarnessModels runs live CLI queries). Shows a
   *  spinner on the chip instead of the status dot. */
  loading?: boolean;
}

/** Parse "harness:<id>" → the harness id; null for builtin/local/none. */
function harnessIdOf(agent: string | null | undefined): string | null {
  return agent?.startsWith("harness:") ? agent.slice("harness:".length) : null;
}

export function AgentMenu({ agent, onAgentChange, loading }: Props) {
  const [open, setOpen] = useState(false);
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Refresh the install status every time the menu opens so a CLI installed
  // mid-session shows up without an app restart.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void listHarnesses().then((list) => {
      if (!stale && list) setHarnesses(list);
    });
    return () => {
      stale = true;
    };
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
  const selectedName = selectedHarness
    ? (harnesses.find((h) => h.id === selectedHarness)?.displayName ?? selectedHarness)
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
        title="Select agent"
      >
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
