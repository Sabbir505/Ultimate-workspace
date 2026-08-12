// Commit modal: a centered dialog with a textarea for the commit message and
// three action buttons — Commit, Commit & Push, Push. Opened from the
// GitToolsSidebar's "Commit or push" row.
import { useState, useRef, useEffect } from "react";
import { Modal } from "../common/Modal";
import { gitCommit, gitPush, generateCommitMessage } from "../../lib/ipc";

interface CommitModalProps {
  path: string;
  branch: string;
  chatSessionId: string;
  onClose: () => void;
}

export function CommitModal({ path, branch, chatSessionId, onClose }: CommitModalProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "commit" | "commit-push" | "push"
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-generate a commit message from the working-tree diff on open. The
  // result pre-fills the textarea but is fully editable; if the user has
  // typed anything by the time it resolves, don't clobber their input.
  useEffect(() => {
    if (!path || !chatSessionId) return;
    let stale = false;
    setGenerating(true);
    void (async () => {
      try {
        const suggestion = await generateCommitMessage(path, chatSessionId);
        if (stale) return;
        if (suggestion && suggestion.trim()) {
          setMessage((prev) => (prev.trim() ? prev : suggestion));
        }
      } catch {
        // Silent — the user just gets an empty textarea to fill in themselves.
      } finally {
        if (!stale) setGenerating(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [path, chatSessionId]);

  const handleCommit = async () => {
    if (!message.trim()) return;
    setBusy("commit");
    setResult(null);
    try {
      const sha = await gitCommit(path, message.trim());
      setResult({ ok: true, text: `Committed ${sha}` });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const handleCommitAndPush = async () => {
    if (!message.trim()) return;
    setBusy("commit-push");
    setResult(null);
    try {
      const sha = await gitCommit(path, message.trim());
      const pushOut = await gitPush(path);
      setResult({ ok: true, text: `Committed ${sha} and pushed.\n${pushOut}` });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const handlePush = async () => {
    setBusy("push");
    setResult(null);
    try {
      const pushOut = await gitPush(path);
      setResult({ ok: true, text: pushOut });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Commit"
      onClose={onClose}
      className="commit-modal"
      actions={
        <div className="commit-modal-actions">
          <button
            className="primary"
            onClick={() => void handleCommit()}
            disabled={!message.trim() || busy !== null}
          >
            {busy === "commit" ? "Committing…" : "Commit"}
          </button>
          <button
            className="primary"
            onClick={() => void handleCommitAndPush()}
            disabled={!message.trim() || busy !== null}
          >
            {busy === "commit-push" ? "Working…" : "Commit & Push"}
          </button>
          <button
            onClick={() => void handlePush()}
            disabled={busy !== null}
          >
            {busy === "push" ? "Pushing…" : "Push"}
          </button>
        </div>
      }
    >
      <div className="commit-modal-branch">
        <svg
          width={14}
          height={14}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="3" r="1.5" />
          <path d="M4 4.5v7" />
          <path d="M12 4.5c0 4-4 2-4 4.5" />
        </svg>
        <span>{branch}</span>
      </div>
      <textarea
        ref={textareaRef}
        className="commit-modal-textarea"
        placeholder="Describe your changes…"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void handleCommit();
          }
        }}
        rows={4}
        disabled={busy !== null}
      />
      {generating && (
        <div className="commit-modal-hint">Generating suggestion from diff…</div>
      )}
      {result && (
        <div className={`commit-modal-result${result.ok ? " ok" : " err"}`}>
          {result.text}
        </div>
      )}
    </Modal>
  );
}
