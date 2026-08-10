// Sidebar connector grid: real product icons instead of a text row. Four
// tiles per row, at most three rows (12 tiles); when more connectors exist
// the last tile becomes a "more" button opening a modal with the full list.
// Clicking a tile opens Settings → Connectors for management.
import { useEffect, useState } from "react";
import { listConnectors, type ConnectorWithStatus } from "../../lib/ipc";
import { ConnectorIcon } from "../settings/ConnectorIcon";
import { Modal } from "../common/Modal";
import { useUiStore } from "../../state/ui";

const GRID_CAP = 12; // 4 columns × 3 rows

export function ConnectorGrid({ onManage }: { onManage: () => void }) {
  const [connectors, setConnectors] = useState<ConnectorWithStatus[]>([]);
  const [showAll, setShowAll] = useState(false);
  const setModalOpen = useUiStore((s) => s.setModalOpen);

  // M25: the "more" modal must hide native webviews like every other modal —
  // register its open state (under its own id, M22) or the browser webview
  // floats above the dialog.
  useEffect(() => {
    setModalOpen("connector-grid:all", showAll);
    return () => { setModalOpen("connector-grid:all", false); };
  }, [showAll, setModalOpen]);

  useEffect(() => {
    let stale = false;
    void listConnectors().then((list) => {
      if (!stale && list) setConnectors(list);
    });
    return () => {
      stale = true;
    };
  }, []);

  if (connectors.length === 0) return null;

  const overflow = connectors.length > GRID_CAP;
  const visible = overflow ? connectors.slice(0, GRID_CAP - 1) : connectors;

  return (
    <div className="connector-grid-wrap">
      <div className="connector-grid">
        {visible.map((c) => (
          <button
            key={c.id}
            type="button"
            className="connector-tile"
            title={`${c.displayName}${c.status.connected ? " — connected" : ""}`}
            onClick={onManage}
          >
            <ConnectorIcon id={c.id} size={20} />
          </button>
        ))}
        {overflow && (
          <button
            type="button"
            className="connector-tile connector-tile-more"
            title={`All connectors (${connectors.length})`}
            onClick={() => setShowAll(true)}
          >
            ···
          </button>
        )}
      </div>

      {showAll && (
        <Modal
          title="Connectors"
          onClose={() => setShowAll(false)}
          actions={
            <>
              <button className="ghost" onClick={() => setShowAll(false)}>
                Close
              </button>
              <button
                className="primary"
                onClick={() => {
                  setShowAll(false);
                  onManage();
                }}
              >
                Manage
              </button>
            </>
          }
        >
          <div className="connector-modal-list">
            {connectors.map((c) => (
              <div key={c.id} className="connector-modal-row">
                <ConnectorIcon id={c.id} size={20} />
                <span className="connector-modal-name">{c.displayName}</span>
                <span className={`connector-modal-status${c.status.connected ? " on" : ""}`}>
                  {c.status.connected ? (c.status.accountDisplay ?? "Connected") : "Not connected"}
                </span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
