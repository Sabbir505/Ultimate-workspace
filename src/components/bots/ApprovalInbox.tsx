// ApprovalInbox — the writes a background bot run wanted to make and did NOT
// execute (docs/architecture/BOTS.md §Unattended permissions).
//
// Every row is a deterministic summary built from the tool name + its declared
// arguments (never model-written text), so an injected run cannot disguise
// what it is asking for. Approve replays the stored call; Deny writes it off.
// The rail's gold dot and this list read the same pending count.

import { useState } from "react";
import type { BotApproval } from "../../lib/ipc/bots";
import { relativeTime } from "../../lib/relativeTime";

export function ApprovalInbox({
  approvals,
  onResolve,
}: {
  approvals: BotApproval[];
  onResolve: (id: string, approve: boolean) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const pending = approvals.filter((a) => a.status === "pending");

  return (
    <section className="bots-strip bots-inbox" aria-label="Needs approval">
      <header className="bots-strip-head">
        <span>
          Needs approval{pending.length > 0 ? ` (${pending.length})` : ""}
        </span>
      </header>
      {pending.length === 0 ? (
        <p className="bots-strip-empty">
          Nothing waiting. Writes a standing job wants are queued here instead of running.
        </p>
      ) : (
        <ul className="bots-strip-list">
          {pending.map((a) => (
            <li key={a.id} className="bots-approval-row">
              <div className="bots-approval-main">
                <span className="bots-approval-summary">{a.summary}</span>
                <span className="bots-approval-meta">
                  <code>{a.toolName}</code> · {relativeTime(a.createdAt)}
                  <button
                    type="button"
                    className="bots-approval-toggle"
                    onClick={() => setOpenId(openId === a.id ? null : a.id)}
                  >
                    {openId === a.id ? "Hide arguments" : "Arguments"}
                  </button>
                </span>
                {openId === a.id && <pre className="bots-approval-args">{prettyArgs(a.argsJson)}</pre>}
              </div>
              <div className="bots-approval-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busyId === a.id}
                  onClick={async () => {
                    setBusyId(a.id);
                    try {
                      await onResolve(a.id, true);
                    } finally {
                      setBusyId(null);
                    }
                  }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busyId === a.id}
                  onClick={async () => {
                    setBusyId(a.id);
                    try {
                      await onResolve(a.id, false);
                    } finally {
                      setBusyId(null);
                    }
                  }}
                >
                  Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Arguments are shown read-only and truncated — enough to judge, not enough
 *  to paste a novel into the strip. */
function prettyArgs(json: string): string {
  try {
    const parsed = JSON.parse(json);
    const text = JSON.stringify(parsed, null, 2);
    return text.length > 2000 ? `${text.slice(0, 2000)}\n…` : text;
  } catch {
    return json.slice(0, 2000);
  }
}
