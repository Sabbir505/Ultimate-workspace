// Broadcast bar (§4.5/§7.8): one input, fanned out as the same literal text
// to every selected terminal pane via write_pty. Skill expansion is NOT
// applied here — §4.5 specifies the literal text is sent.
import { useState } from "react";
import { writePty } from "../../lib/ipc";
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
      void writePty(pane.paneId, payload + "\r");
    }
    setText("");
  };

  return (
    <div className="broadcast-bar">
      <span style={{ fontWeight: 600 }}>Broadcast</span>
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
