/**
 * SubagentPanel — renders the selected subagent's run inside the right-side
 * ToolPanel's "Agents" tab, at the same fidelity as the main chat view: the
 * spawn prompt renders as a user-style bubble and the output streams live
 * beneath it, parsed into ORDERED segments (markdown text / <think> reasoning
 * disclosures / tool rows) with the chat view's own parser. Tool markers with
 * an edit payload render as inline DiffCards; a following result marker
 * completes the preceding tool row and carries a collapsible output preview.
 * When no subagent is selected, shows the agent list.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { parseSegments, ThinkingBlock } from "../chat/MessageBubble";
import { DiffCard, type EditPayload } from "../chat/DiffCard";

/** The marker payload the backend embeds in <tool>{json}</tool> (see
 *  tool_meta_generic) — the same shape the chat view's ToolData carries. */
interface ToolData {
  kind?: string;
  title?: string;
  detail?: string;
  lang?: string;
  code?: string;
  path?: string;
  edit?: EditPayload;
  role?: string;
  task?: string;
  result?: string;
}

/** Ordered output segment — mirrors the chat view's Segment union. */
type SubSegment =
  | { type: "text"; text: string }
  | { type: "think"; text: string; done: boolean }
  | { type: "tool"; data: ToolData | null; done: boolean };

/** Parse a (possibly mid-stream) subagent output into ORDERED render
 *  segments using the chat view's own parser (text / think / tool, tolerant
 *  of a trailing unterminated marker). A `result` marker is folded into the
 *  most recent tool segment (its collapsible output) instead of becoming its
 *  own row — same merge rule as the chat view's activity grouping.
 *
 *  Done semantics differ from the chat view on purpose: the subagent loop
 *  announces every tool call with a FULLY-CLOSED marker and streams the
 *  result marker only after execution, so a tool segment counts as done when
 *  its result folded in — not when its marker closed. Exported for the
 *  pane-fidelity regression tests. */
export function parseSubagentOutput(output: string): SubSegment[] {
  const segs = parseSegments(output) as SubSegment[];
  const out: SubSegment[] = [];
  for (const seg of segs) {
    if (seg.type === "tool" && seg.data?.kind === "result") {
      const resultText =
        typeof seg.data.result === "string" ? seg.data.result : "";
      // Attach to the most recent tool segment that has no result yet.
      for (let i = out.length - 1; i >= 0; i--) {
        const prev = out[i];
        if (prev.type === "tool" && prev.data && prev.data.kind !== "result") {
          if (prev.data.result === undefined) {
            prev.data.result = resultText;
            prev.done = true;
          }
          break;
        }
      }
      continue;
    }
    if (seg.type === "tool") {
      // Announced, not yet completed — the result marker flips it.
      out.push({ type: "tool", data: seg.data, done: false });
      continue;
    }
    out.push(seg);
  }
  return out;
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

interface ToolRow {
  title: string;
  detail: string;
  done: boolean;
  result?: string;
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
          {/* Output — assistant-style bubble: the SAME ordered segment stream
              as the chat view (markdown text / think disclosures / tool rows
              / inline diff cards), in source order. */}
          <div className="subagent-bubble subagent-output-bubble">
            <div className="subagent-bubble-label">Output</div>
            <div className="subagent-bubble-content subagent-bubble-streaming">
              {segments.map((seg, i) => {
                if (seg.type === "text") {
                  return seg.text.trim().length > 0 ? (
                    <div className="subagent-seg-text" key={`t:${i}`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
                    </div>
                  ) : null;
                }
                if (seg.type === "think") {
                  return seg.text.length > 0 ? (
                    <ThinkingBlock key={`k:${i}`} thinking={seg.text} done={seg.done} />
                  ) : null;
                }
                const d = seg.data;
                if (d?.kind === "edit" && d.path && d.edit) {
                  return (
                    <DiffCard key={`d:${i}`} path={d.path} edit={d.edit} done={seg.done} />
                  );
                }
                return (
                  <ToolActivityRow
                    key={`r:${i}`}
                    row={{
                      title: d?.title?.trim() || "Running tool",
                      detail: d?.detail ?? "",
                      done: seg.done,
                      result: d?.result,
                    }}
                  />
                );
              })}
              {segments.length === 0 && selectedSub.status === "running" && (
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
