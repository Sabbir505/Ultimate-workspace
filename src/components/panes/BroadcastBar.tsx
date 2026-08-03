// Broadcast bar (§4.5/§7.8): one input, fanned out as the same literal text
// to every selected terminal pane via write_pty. Skill expansion is NOT
// applied here — §4.5 specifies the literal text is sent.
import { useState } from "react";
import { writePtySubmit } from "../../lib/ipc";
import { broadcastTargets, usePanesStore } from "../../state/panes";

export function BroadcastBar() {
  const broadcast = usePanesStore((s) => s.broadcast);
  const panes = usePanesStore((s) => s.panes);
  const toggleBroadcastPane = usePanesStore((s) => s.toggleBroadcastPane);
  const selectAllBroadcast = usePanesStore((s) => s.selectAllBroadcast);
  const [text, setText] = useState("");

  if (!broadcast.enabled) return null;

  const terminalPanes = panes.filter((p) => p.data.kind === "terminal");
  const targets = broadcastTargets(panes, broadcast.selected);

  const send = () => {
    const payload = text;
    if (payload.trim().length === 0 || targets.length === 0) return;
    for (const pane of targets) {
      // writePtySubmit: text write, then a separate "\r" write so the Enter
      // actually submits in TUI harnesses (a merged trailing \r does not).
      writePtySubmit(pane.paneId, payload);
    }
    setText("");
  };

  return (
    <div className="broadcast-bar">
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
          <line x1="2" y1="20" x2="2.01" y2="20" />
        </svg>
        <span style={{ fontWeight: 600 }}>Broadcast</span>
      </div>
      <div className="pane-checks">
        {terminalPanes.map((pane) => (
          <label key={pane.paneId}>
            <input
              type="checkbox"
              checked={broadcast.selected.includes(pane.paneId)}
              onChange={() => toggleBroadcastPane(pane.paneId)}
            />
            Pane {panes.indexOf(pane) + 1}
          </label>
        ))}
        <button className="ghost" onClick={selectAllBroadcast}>
          select all
        </button>
      </div>
      <input
        className="broadcast-input"
        placeholder={`Send the same prompt to ${targets.length} pane(s)…`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
      />
      <button className="primary" onClick={send} disabled={targets.length === 0 || text.trim().length === 0}>
        Send to {targets.length}
      </button>
    </div>
  );
}
