/**
 * SubagentPanel — renders the selected subagent's run inside the right-side
 * ToolPanel's "Agents" tab. The spawn prompt renders as a user-style bubble,
 * the output streams live beneath it as an assistant-style bubble — parsed
 * into markdown text interleaved with tool-activity rows (the backend embeds
 * `<tool>{json}</tool>` markers in the token stream: {"kind":"tool"} rows go
 * live at call time, a following {"kind":"result"} completes the row and
 * carries a collapsible output preview). When no subagent is selected, shows
 * the agent list.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";

interface ToolRow {
  title: string;
  detail: string;
  done: boolean;
  result?: string;
}

/** Parse a (possibly mid-stream) subagent output into ordered render
 *  segments: markdown text and tool rows. A `result` marker completes the
 *  most recent tool row; a trailing unclosed `<tool>` (mid-stream) renders
 *  as a running row when its JSON is parseable, otherwise is skipped. */
function parseSubagentOutput(output: string): { text: string[]; rows: ToolRow[] } {
  const text: string[] = [];
  const rows: ToolRow[] = [];
  const re = /<tool>([\s\S]*?)<\/tool>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => {
    if (t.trim()) text.push(t);
  };
  while ((m = re.exec(output)) !== null) {
    pushText(output.slice(last, m.index));
    last = m.index + m[0].length;
    try {
      const v = JSON.parse(m[1]);
      if (v.kind === "result") {
        const row = [...rows].reverse().find((r) => !r.done);
        if (row) {
          row.done = true;
          row.result = typeof v.result === "string" ? v.result : undefined;
        }
      } else {
        rows.push({
          title: typeof v.title === "string" ? v.title : "Running tool",
          detail: typeof v.detail === "string" ? v.detail : "",
          done: false,
        });
      }
    } catch {
      /* malformed marker — skip */
    }
  }
  pushText(output.slice(last));
  return { text, rows };
}

function ToolActivityRow({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`subagent-tool-row ${row.done ? "done" : "running"}`}>
      {row.done ? (
        <span aria-hidden="true" style={{ color: "#3fb970" }}>✓</span>
      ) : (
        <span className="subagent-tool-spinner" aria-hidden="true" />
      )}
      <span
        className="subagent-tool-title"
        onClick={row.done && row.result ? () => setOpen((o) => !o) : undefined}
        style={row.done && row.result ? { cursor: "pointer" } : undefined}
        title={row.done && row.result ? "Toggle output" : undefined}
      >
        {row.title}
      </span>
      {row.detail && <span className="subagent-tool-detail">{row.detail}</span>}
      {open && row.result && (
        <div className="subagent-tool-result" style={{ whiteSpace: "pre-wrap", fontSize: 10.5, opacity: 0.85, marginTop: 4, maxHeight: 160, overflowY: "auto" }}>
          {row.result}
        </div>
      )}
    </div>
  );
}

function SubagentListItem({
  sub,
  selected,
  onClick,
}: {
  sub: { id: string; role: string; task: string; status: "running" | "completed" | "error" };
  selected: boolean;
  onClick: () => void;
}) {
  const dotClass =
    sub.status === "running"
      ? "subagent-dot running"
      : sub.status === "error"
        ? "subagent-dot error"
        : "subagent-dot done";
  return (
    <button
      className={`subagent-list-item${selected ? " selected" : ""}`}
      onClick={onClick}
      title={`${sub.role}: ${sub.task}`}
    >
      <span className={dotClass} />
      <span className="subagent-list-role">{sub.role}</span>
      <span className="subagent-list-task">{sub.task}</span>
      {sub.status === "running" && (
        <span className="subagent-list-spinner" />
      )}
      {sub.status === "completed" && <span className="subagent-check">✓</span>}
      {sub.status === "error" && <span className="subagent-x">✕</span>}
    </button>
  );
}

export function SubagentPanel() {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const subagents = useChatStore(
    (s) => (activeChatSessionId ? s.subagents[activeChatSessionId] ?? {} : {}),
  );
  const activeSubagentId = useUiStore((s) => s.activeSubagentId);
  const setActiveSubagentId = useUiStore((s) => s.setActiveSubagentId);
  const panelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const selectedSub =
    activeSubagentId != null ? subagents[activeSubagentId] : undefined;

  // Parsed render segments — recomputed as tokens stream in.
  const segments = useMemo(
    () => (selectedSub ? parseSubagentOutput(selectedSub.output) : null),
    [selectedSub?.output],
  );

  // Auto-scroll to the end as the subagent outputs tokens
  useLayoutEffect(() => {
    if (panelRef.current) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  });

  // When a subagent is selected, make sure the tool panel is actually VISIBLE
  // (the click sites open/focus the agents tab themselves via openAgentsTab —
  // this effect must never stack another tab instance on selection changes).
  useEffect(() => {
    if (selectedSub) {
      useUiStore.getState().setToolPanelCollapsed(false);
    }
  }, [selectedSub?.id]);

  // Navigate back to the list when the selected sub is gone (e.g., session switch)
  useEffect(() => {
    if (activeSubagentId && !subagents[activeSubagentId]) {
      setActiveSubagentId(null);
    }
  }, [activeSubagentId, subagents]);

  if (!activeChatSessionId || Object.keys(subagents).length === 0) {
    return (
      <div className="subagent-panel-empty">
        <div className="subagent-empty-icon">⬡</div>
        <div>No subagents yet</div>
        <div className="subagent-empty-hint">
          Spawned by the agent will appear here.
        </div>
      </div>
    );
  }

  if (selectedSub && segments) {
    return (
      <div className="subagent-panel-view">
        <div className="subagent-panel-header">
          <button
            className="ghost subagent-back-btn"
            onClick={() => setActiveSubagentId(null)}
            title="Back to list"
          >
            ←
          </button>
          <span className="subagent-panel-title">
            <span className="subagent-panel-role">{selectedSub.role}</span>
            <span className="subagent-panel-task-truncate" title={selectedSub.task}>
              {selectedSub.task}
            </span>
          </span>
          <span
            className={`subagent-panel-status ${
              selectedSub.status === "running"
                ? "running"
                : selectedSub.status === "error"
                  ? "error"
                  : "done"
            }`}
          >
            {selectedSub.status === "running" && (
              <span className="subagent-panel-spinner" />
            )}
            {selectedSub.status === "completed" && "Done"}
            {selectedSub.status === "error" && "Error"}
          </span>
        </div>
        <div className="subagent-panel-body" ref={panelRef}>
          {/* Prompt — user-style bubble (the subagent's "user message"). */}
          <div className="subagent-bubble subagent-prompt-bubble">
            <div className="subagent-bubble-label">Prompt</div>
            <div className="subagent-bubble-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {selectedSub.prompt}
              </ReactMarkdown>
            </div>
          </div>
          {/* Output — assistant-style bubble: live markdown interleaved with
              tool-activity rows parsed from the <tool> marker stream. */}
          <div className="subagent-bubble subagent-output-bubble">
            <div className="subagent-bubble-label">Output</div>
            <div className="subagent-bubble-content subagent-bubble-streaming">
              {segments.rows.length > 0 && (
                <div className="subagent-tool-rows">
                  {segments.rows.map((row, i) => (
                    <ToolActivityRow key={`row-${i}-${row.title}`} row={row} />
                  ))}
                </div>
              )}
              {segments.text.map((t, i) => (
                <ReactMarkdown key={`text-${i}`} remarkPlugins={[remarkGfm]}>
                  {t}
                </ReactMarkdown>
              ))}
              {segments.text.length === 0 && segments.rows.length === 0 &&
                selectedSub.status === "running" && (
                  <div className="subagent-tool-row running">
                    <span className="subagent-tool-spinner" aria-hidden="true" />
                    <span className="subagent-tool-title">Working…</span>
                  </div>
                )}
              {selectedSub.status === "running" && (
                <span className="streaming-cursor" />
              )}
            </div>
          </div>
          <div ref={bottomRef} />
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="subagent-panel-list">
      <div className="subagent-panel-header">
        <span className="subagent-panel-title">Agents</span>
        <span className="subagent-count-badge">{Object.keys(subagents).length}</span>
      </div>
      <div className="subagent-list">
        {Object.values(subagents).map((sub) => (
          <SubagentListItem
            key={sub.id}
            sub={sub}
            selected={activeSubagentId === sub.id}
            onClick={() => setActiveSubagentId(sub.id)}
          />
        ))}
      </div>
    </div>
  );
}
