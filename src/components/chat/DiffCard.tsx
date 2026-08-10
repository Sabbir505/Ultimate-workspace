// Inline diff review card for chat-agent file edits (mockup 01 callout 5):
// filename, +/− stats, a short hunk preview, and per-edit Accept/Reject.
//
// Data source: the backend's `tool_block` (src-tauri/src/chat/proto.rs)
// embeds a rich payload in the `<tool>` stream marker for write_file /
// edit_file calls — path plus the model's old/new content — so hunks are
// computed client-side with no disk read-back.
//
// Accept/Reject is no longer surfaced: harness CLIs now run at full-auto
// permission (claude --dangerously-skip-permissions, kimi --yolo, opencode
// --auto), so every edit auto-applies. The card renders an "Applied" state
// with an "Open in Peek" action.
import { useMemo, useState } from "react";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";

function PencilIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/** The edit payload embedded in a `<tool>` marker for write_file / edit_file. */
export type EditPayload =
  | { mode: "write"; content: string }
  | { mode: "append"; append: string }
  | { mode: "replace"; find: string; replace: string };

interface PreviewLine {
  type: "add" | "del";
  text: string;
}

/** How many diff lines the collapsed card shows before the "N more" footer. */
const PREVIEW_LINE_CAP = 5;

/** Split edit content into lines, dropping a single trailing empty line so a
 *  final newline doesn't count as an added blank line. */
function toLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Compute the card's preview lines and stats from the edit payload. A single
 *  edit_file call is one replacement (one hunk); a write is one all-adds hunk. */
function buildPreview(edit: EditPayload): {
  lines: PreviewLine[];
  adds: number;
  dels: number;
  hunks: number;
} {
  let dels: string[] = [];
  let adds: string[] = [];
  if (edit.mode === "replace") {
    dels = toLines(edit.find);
    adds = toLines(edit.replace);
  } else if (edit.mode === "append") {
    adds = toLines(edit.append);
  } else {
    adds = toLines(edit.content);
  }
  const lines: PreviewLine[] = [
    ...dels.map((text): PreviewLine => ({ type: "del", text })),
    ...adds.map((text): PreviewLine => ({ type: "add", text })),
  ];
  return {
    lines,
    adds: adds.length,
    dels: dels.length,
    hunks: lines.length > 0 ? 1 : 0,
  };
}

export function DiffCard({
  path,
  edit,
  done,
}: {
  path: string;
  edit: EditPayload;
  /** False while the `<tool>` marker is still streaming in. */
  done: boolean;
}) {
  const openPeek = useUiStore((s) => s.openPeek);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);

  const { lines, adds, dels, hunks } = useMemo(() => buildPreview(edit), [edit]);
  // Cursor-style: clicking the file row toggles a local "expanded" state that
  // drops the full diff DOWN inline, beneath the preview. No Peek navigation.
  // `done` reset (e.g. new streaming `<tool>` for the same path) collapses.
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINE_CAP);
  const hiddenCount = expanded ? 0 : lines.length - visible.length;

  const openFullDiff = () => {
    if (!selectedProjectId) return;
    openPeek({ mode: "diff", projectId: selectedProjectId, filePath: path, cwd: null });
  };

  return (
    <div className={`diff-card${done ? "" : " live"}${expanded ? " expanded" : ""}`}>
      <div className="diff-card-head">
        <span className="diff-card-icon" aria-hidden="true">
          <PencilIcon />
        </span>
        <button
          type="button"
          className="diff-card-filename"
          title={`Toggle full diff for ${path}`}
          // Filename click toggles inline expansion (Cursor's behavior).
          // The original "open the file in the OS" affordance moved to the
          // "Open in Peek" button so it doesn't collide with expand.
          onClick={() => setExpanded((e) => !e)}
        >
          {path}
        </button>
        <span className="diff-card-stat">
          <span className="diff-card-adds">+{adds}</span>{" "}
          <span className="diff-card-dels">−{dels}</span>
          {` · ${hunks} hunk${hunks === 1 ? "" : "s"}`}
        </span>
        <div className="diff-card-actions">
          <>
            {done && <span className="diff-card-applied">Applied ✓</span>}
            {selectedProjectId && (
              <button type="button" className="diff-card-peek" onClick={openFullDiff}>
                Open in Peek
              </button>
            )}
          </>
        </div>
      </div>
      {lines.length > 0 && (
        <div
          className="diff-card-body"
          // Clicking the diff body collapses it (same pattern as
          // ThinkingBlock) — no need to hunt for the footer button.
          onClick={() => expanded && setExpanded(false)}
        >
          {visible.map((line, idx) => (
            <div key={`${idx}:${line.type}:${line.text}`} className={`diff-line ${line.type}`}>
              <span className="diff-line-content">
                {line.type === "add" ? "+ " : "- "}
                {line.text}
              </span>
            </div>
          ))}
        </div>
      )}
      {(hiddenCount > 0 || expanded) && (
        <button
          type="button"
          className="diff-card-more"
          // Toggle inline expand/collapse — same UX as Cursor's file review
          // cards. When already expanded, the label flips to "collapse" so
          // the user knows the button collapses the inline diff.
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? "Collapse inline diff" : "Expand full diff inline"}
        >
          {expanded
            ? `▴ Collapse`
            : hiddenCount > 0
            ? `▾ ${hiddenCount} more line${hiddenCount === 1 ? "" : "s"} · click to expand`
            : `▾ Click to expand`}
        </button>
      )}
    </div>
  );
}
