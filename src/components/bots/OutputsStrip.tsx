// OutputsStrip — files the selected bot has produced across its thread and its
// runs. Only rendered when there is at least one output; clicking a row opens
// the artifact preview (same tab surface the chat's own artifact chip uses).

import type { ArtifactRecord } from "../../lib/ipc/artifacts";
import { relativeTime } from "../../lib/relativeTime";

export function OutputsStrip({
  outputs,
  onOpen,
}: {
  outputs: ArtifactRecord[];
  onOpen: (output: ArtifactRecord) => void;
}) {
  if (outputs.length === 0) return null;
  return (
    <section className="bots-strip" aria-label="Output">
      <header className="bots-strip-head">
        <span>Output</span>
        <span className="bots-strip-count">{outputs.length}</span>
      </header>
      <ul className="bots-strip-list">
        {outputs.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="bots-run-row"
              title={`Preview ${a.filename}`}
              onClick={() => onOpen(a)}
            >
              <span className="bots-run-name">{a.filename}</span>
              {a.kind && <span className="bots-output-kind">{a.kind.toUpperCase()}</span>}
              <span className="bots-run-when">{relativeTime(a.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
