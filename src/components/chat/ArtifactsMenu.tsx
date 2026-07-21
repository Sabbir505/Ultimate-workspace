// Top-right artifacts control shown when the current chat has generated files.
// The icon button opens the most recent artifact in the preview pane; the
// caret toggles a dropdown listing every artifact (click to switch) plus a
// "Download all" action that saves them as a single zip.
import { useEffect, useRef, useState } from "react";
import { downloadArtifactsZip } from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";

function extLabel(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toUpperCase() : "FILE";
}

export function ArtifactsMenu({
  artifacts,
  onOpen,
}: {
  artifacts: ChatArtifact[];
  onOpen: (artifact: ChatArtifact) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const latest = artifacts[artifacts.length - 1];

  // Close the dropdown when clicking outside it.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const downloadAll = async () => {
    setBusy(true);
    try {
      await downloadArtifactsZip(artifacts.map((a) => a.path));
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className="artifacts-menu" ref={ref}>
      <button
        type="button"
        className="artifacts-menu-icon"
        title={latest ? `Open ${latest.filename}` : "Open latest artifact"}
        aria-label="Open latest artifact"
        onClick={() => latest && onOpen(latest)}
      >
        <PaperclipIcon />
        <span className="artifacts-menu-count">{artifacts.length}</span>
      </button>
      <button
        type="button"
        className="artifacts-menu-caret"
        title="All generated files"
        aria-label="All generated files"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div className="artifacts-menu-dropdown" role="menu">
          <div className="artifacts-menu-list">
            {artifacts.map((a) => (
              <button
                key={a.path}
                type="button"
                className="artifacts-menu-item"
                role="menuitem"
                title={`Preview ${a.filename}`}
                onClick={() => {
                  onOpen(a);
                  setOpen(false);
                }}
              >
                <span className="artifacts-menu-item-ext">{extLabel(a.filename)}</span>
                <span className="artifacts-menu-item-name">{a.filename}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="artifacts-menu-downloadall"
            disabled={busy}
            onClick={() => void downloadAll()}
          >
            {busy ? "Preparing…" : `Download all (${artifacts.length}) as zip`}
          </button>
        </div>
      )}
    </div>
  );
}

function PaperclipIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
