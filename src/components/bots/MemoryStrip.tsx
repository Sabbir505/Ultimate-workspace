// MemoryStrip — what the selected bot remembers, right in the activity rail.
// Memory was previously only visible inside the editor's Memory section; this
// makes it discoverable where the bot's jobs/runs/approvals already live.
// Read-only: "Manage" opens the editor, which can delete rows.
import { useEffect, useState } from "react";
import type { BotMemoryRow } from "../../lib/ipc/bots";

const MAX_ROWS = 6;

export function MemoryStrip({
  botId,
  listMemory,
  onManage,
}: {
  botId: string;
  listMemory: (botId: string) => Promise<BotMemoryRow[]>;
  onManage: () => void;
}) {
  const [rows, setRows] = useState<BotMemoryRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void listMemory(botId)
      .then((r) => {
        if (!cancelled) setRows(r ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, listMemory]);

  return (
    <section className="bots-strip" aria-label="Memory" data-testid="bot-memory-strip">
      <header className="bots-strip-head">
        <span>Memory</span>
        <button type="button" onClick={onManage} title="Open the bot editor's Memory section">
          Manage
        </button>
      </header>
      {rows === null ? (
        <p className="bots-strip-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="bots-strip-empty">
          Nothing remembered yet. It learns from its conversations and runs.
        </p>
      ) : (
        <>
          <ul className="bots-strip-list">
            {rows.slice(0, MAX_ROWS).map((m) => (
              <li key={m.id} className="bots-memory-row">
                <span className="bots-memory-kind">{m.kind}</span>
                <span className="bots-memory-content" title={m.content}>
                  {m.content}
                </span>
              </li>
            ))}
          </ul>
          {rows.length > MAX_ROWS && (
            <p className="bots-strip-empty">+{rows.length - MAX_ROWS} more — Manage to see all.</p>
          )}
        </>
      )}
    </section>
  );
}
