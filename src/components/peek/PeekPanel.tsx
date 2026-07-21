// Quick file/diff peek (§7.9): read-only slide-over. File mode shows raw file
// contents in monospace (syntax highlighting deliberately minimal per the
// task constraints); diff mode renders the project's working-tree diff with
// the minimal custom unified-diff renderer in lib/diff.ts.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getGitDiff, readFileText } from "../../lib/ipc";
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
    if (peek.mode === "file" && peek.filePath) {
      void readFileText(peek.filePath).then((t) => setFileText(t ?? "(unable to read file)"));
    } else if (peek.mode === "diff" && project) {
      void getGitDiff(project.path).then((d) => setDiffText(d ?? ""));
    }
  }, [peek.open, peek.mode, peek.filePath, project]);

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
        openPeek({ mode: "file", projectId: peek.projectId, filePath: picked });
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
          <h2>{peek.mode === "diff" ? `Diff — ${project?.name ?? "project"}` : "File peek"}</h2>
          <button
            onClick={() => {
              if (project) {
                setFileText(null);
                setDiffText(null);
                openPeek({ mode: peek.mode === "diff" ? "file" : "diff", projectId: peek.projectId, filePath: null });
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
            <p className="estimate-note">Working tree is clean — no diff to show.</p>
          ) : (
            diffFiles.map((file, i) => (
              <div className="diff-file" key={`${file.newPath}-${i}`}>
                <div className="diff-file-header">{file.newPath || file.oldPath || `file ${i + 1}`}</div>
                {file.lines
                  .filter((l) => l.type !== "meta")
                  .map((line, j) => (
                    <div key={j} className={`diff-line ${line.type}`}>
                      {line.type === "add" ? "+ " : line.type === "del" ? "- " : line.type === "hunk" ? "" : "  "}
                      {line.text}
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
