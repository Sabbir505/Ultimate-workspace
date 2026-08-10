// Quick file/diff peek (§7.9): read-only slide-over. File mode shows raw file
// contents in monospace (syntax highlighting deliberately minimal per the
// task constraints); diff mode renders the project's working-tree diff with
// the minimal custom unified-diff renderer in lib/diff.ts.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getGitDiff, getGitFileDiff, readFileText } from "../../lib/ipc";
import { parseUnifiedDiff } from "../../lib/diff";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";

export function PeekPanel() {
  const peek = useUiStore((s) => s.peek);
  const closePeek = useUiStore((s) => s.closePeek);
  const openPeek = useUiStore((s) => s.openPeek);
  const project = useProjectsStore((s) => s.projectById(peek.projectId));

  const [fileText, setFileText] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);

  useEffect(() => {
    if (!peek.open) return;
    // M26: clear the previous target's content FIRST — until the new read
    // resolves, the panel must show nothing (loading), not the stale file
    // or diff from the last peek target.
    setFileText(null);
    setDiffText(null);
    if (peek.mode === "file" && peek.filePath) {
      void readFileText(peek.filePath).then((t) => setFileText(t ?? "(unable to read file)"));
    } else if (peek.mode === "diff" && project) {
      // Per-pane entry points (Dev-tab diff side panel) carry an explicit
      // `cwd` so a worktree-scoped session can show its own diff, not the
      // project root's. Fall back to the project root otherwise.
      const target = peek.cwd ?? project.path;
      if (peek.filePath) {
        // File-scoped peek: the user clicked a file row in the right-side
        // Files panel. Show ONLY that file's diff (newly-created files are
        // handled by `get_git_file_diff`'s untracked fallback).
        void getGitFileDiff(target, peek.filePath).then((d) => setDiffText(d ?? ""));
      } else {
        // Project-wide peek: the entire working-tree diff against HEAD
        // (still truncated at 200KB by the backend).
        void getGitDiff(target).then((d) => setDiffText(d ?? ""));
      }
    }
  }, [peek.open, peek.mode, peek.filePath, peek.cwd, project]);

  if (!peek.open) return null;

  const pickFile = async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        defaultPath: project?.path,
        title: "Peek at file",
      });
      if (typeof picked === "string") {
        setFileText(null);
        openPeek({ mode: "file", projectId: peek.projectId, filePath: picked, cwd: null });
      }
    } catch (err) {
      console.warn("file picker failed", err);
    }
  };

  const diffFiles = diffText !== null ? parseUnifiedDiff(diffText) : [];

  return (
    <div className="view-overlay" onPointerDown={(e) => e.target === e.currentTarget && closePeek()}>
      <div className="peek-panel">
        <div className="view-header">
          <h2>
            {peek.mode === "diff"
              ? peek.filePath
                ? `${peek.filePath} — ${project?.name ?? "project"}`
                : `Diff — ${project?.name ?? "project"}`
              : "File peek"}
          </h2>
          <button
            onClick={() => {
              if (project) {
                setFileText(null);
                setDiffText(null);
                openPeek({
                  mode: peek.mode === "diff" ? "file" : "diff",
                  projectId: peek.projectId,
                  filePath: null,
                  cwd: peek.cwd,
                });
              }
            }}
            disabled={!project}
          >
            {peek.mode === "diff" ? "View file" : "View diff"}
          </button>
          {peek.mode === "file" && <button onClick={() => void pickFile()}>Pick file…</button>}
          <button className="ghost" onClick={closePeek}>
            ✕
          </button>
        </div>
        <div className="peek-content">
          {peek.mode === "file" ? (
            peek.filePath ? (
              <>
                <p className="mono" style={{ color: "var(--text-dim)", fontSize: 11 }}>
                  {peek.filePath}
                </p>
                <pre>{fileText ?? "Loading…"}</pre>
              </>
            ) : (
              <div className="empty-state">
                <div>Pick a file to preview (read-only)</div>
                <button className="primary" onClick={() => void pickFile()}>
                  Pick file…
                </button>
              </div>
            )
          ) : diffText === null ? (
            <p>Loading diff…</p>
          ) : diffFiles.length === 0 ? (
            <p className="estimate-note">
              {peek.filePath
                ? `No changes in ${peek.filePath}.`
                : "Working tree is clean — no diff to show."}
            </p>
          ) : (
            diffFiles.map((file, i) => (
              <div className="diff-file" key={`${file.newPath}-${i}`}>
                <div className="diff-file-header">{file.newPath || file.oldPath || `file ${i + 1}`}</div>
                {file.lines
                  .filter((l) => l.type !== "meta")
                  .map((line, j) => (
                    <div key={j} className={`diff-line ${line.type}`}>
                      <span className="diff-line-gutter">
                        {line.oldLine ?? ""}
                        {line.oldLine !== null && line.newLine !== null && " "}
                        {line.newLine ?? ""}
                      </span>
                      <span className="diff-line-content">
                        {line.type === "add" ? "+ " : line.type === "del" ? "- " : line.type === "hunk" ? "" : "  "}
                        {line.text}
                      </span>
                    </div>
                  ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
