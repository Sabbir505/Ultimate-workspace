// Inline per-pane diff overlay: when the user clicks a file row in the
// right-side Dev-tab Files panel, this overlay slides over the FOCUSED
// terminal pane (not a global modal) and renders the unified diff for that
// single file. The terminal stays mounted and visible underneath, so the
// user can close the overlay and keep typing without losing scrollback or
// pty state. The Escape key and the ✕ button both close it; clicking the
// scrim around it also closes it (same as PeekPanel's UX).
//
// Why not reuse PeekPanel? PeekPanel is a global view-overlay (full-window
// slide-over). The user explicitly asked for the diff to appear "in the
// same pane from where we click on the file" — i.e. a per-pane overlay, so
// the user can still see the rest of the workspace and keep an eye on the
// terminal the click originated from.
import { useEffect, useState } from "react";
import { getGitFileDiff } from "../../lib/ipc";
import { parseUnifiedDiff } from "../../lib/diff";
import { useUiStore } from "../../state/ui";

export function PaneDiffOverlay({ paneId }: { paneId: string }) {
  // Hooks MUST be called unconditionally and in the same order on every
  // render. Subscribing to the slice we need (not the whole store) keeps
  // re-renders narrow and avoids touching the `paneId` prop in a way that
  // would re-subscribe every parent update.
  const paneDiff = useUiStore((s) => s.paneDiff);
  const setPaneDiff = useUiStore((s) => s.setPaneDiff);

  // The "active" overlay is the one for THIS pane. When null, the overlay
  // is closed — we still keep the same hook set below so React doesn't see
  // a different hook count between open/closed renders.
  const active = paneDiff && paneDiff.paneId === paneId ? paneDiff : null;

  // Local state: the diff text we just fetched. Null while loading.
  const [diffText, setDiffText] = useState<string | null>(null);

  // Fetch the diff whenever the active overlay's file/cwd changes. The
  // early `if (!active) return;` is INSIDE the effect (not before hooks)
  // so the hook order is stable.
  useEffect(() => {
    if (!active) {
      setDiffText(null);
      return;
    }
    setDiffText(null);
    let cancelled = false;
    void getGitFileDiff(active.cwd, active.filePath).then((d) => {
      if (cancelled) return;
      setDiffText(d ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [active?.cwd, active?.filePath]);

  // Escape closes — same keyboard contract as the global PeekPanel so
  // muscle memory carries over. Only register the listener while the
  // overlay is open; otherwise it would swallow Escape on every keystroke
  // even when no overlay is showing.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPaneDiff(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, setPaneDiff]);

  // NOW (after all hooks) we can return null when the overlay is closed.
  // The body below only runs when the overlay is open for this pane.
  if (!active) return null;
  const diffFiles = diffText !== null ? parseUnifiedDiff(diffText) : [];

  return (
    <div
      className="pane-diff-overlay"
      role="dialog"
      aria-label={`Diff for ${active.filePath}`}
      onPointerDown={(e) => {
        // Click on the scrim (outside the panel itself) closes — matches
        // PeekPanel's UX so both overlays feel the same.
        if (e.target === e.currentTarget) setPaneDiff(null);
      }}
    >
      <div className="pane-diff-panel">
        <div className="pane-diff-header">
          <span className="pane-diff-title">{active.filePath}</span>
          <button
            className="ghost pane-diff-close"
            onClick={() => setPaneDiff(null)}
            title="Close diff (Esc)"
            aria-label="Close diff"
          >
            ✕
          </button>
        </div>
        <div className="pane-diff-body">
          {diffText === null ? (
            <p className="estimate-note">Loading diff…</p>
          ) : diffFiles.length === 0 ? (
            <p className="estimate-note">No changes in {active.filePath}.</p>
          ) : (
            diffFiles.map((file, i) => (
              <div className="diff-file" key={`${file.newPath}-${i}`}>
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
                        {line.type === "add"
                          ? "+ "
                          : line.type === "del"
                          ? "- "
                          : line.type === "hunk"
                          ? ""
                          : "  "}
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
