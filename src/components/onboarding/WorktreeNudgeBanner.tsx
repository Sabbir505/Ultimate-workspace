// Worktree-per-session migration nudge (roadmap P0 §3.1.1): a one-time,
// dismissible banner shown to users who already have chats — NEW chats now
// get their own isolated git worktree, and existing chats can be moved with
// the per-chat toggle. Dismiss persists via the `worktrees.nudgeSeen` KV so
// it only appears once.
import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../../lib/ipc";
import { useChatStore } from "../../state/chat";

export function WorktreeNudgeBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [seen, setSeen] = useState<boolean | null>(null);
  const chatSessions = useChatStore((s) => s.sessions);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const toggleSessionWorktree = useChatStore((s) => s.toggleSessionWorktree);

  useEffect(() => {
    let alive = true;
    void getSetting("worktrees.nudgeSeen")
      .then((v) => {
        if (alive) setSeen(v != null);
      })
      .catch(() => {
        if (alive) setSeen(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // seen === null = still loading (don't flash); seen === true = dismissed
  // before; only show for users with existing chats.
  if (dismissed || seen !== false) return null;
  if (chatSessions.length === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    void setSetting("worktrees.nudgeSeen", "1").catch(() => {
      /* best-effort: worst case the banner returns next launch */
    });
  };

  const activeSession = activeChatSessionId
    ? chatSessions.find((s) => s.id === activeChatSessionId)
    : undefined;
  const canIsolate = !!activeSession?.projectId;

  return (
    <div className="onboarding-banner">
      <button
        className="onboarding-banner-close"
        onClick={dismiss}
        title="Dismiss"
        aria-label="Dismiss notification"
      >
        ×
      </button>
      <strong>Chats now run in isolated worktrees</strong>
      <div className="hint">
        New chats get their own git worktree (branch <code>conduit/&lt;id&gt;</code>), so agents
        never collide in the same working tree. Existing chats can be moved with the 🪵/⛓ toggle
        in the sidebar or the ⛓ chip beside the composer's folder notch.
      </div>
      {canIsolate && (
        <div>
          <button
            onClick={() => {
              void toggleSessionWorktree(activeSession!.id);
              dismiss();
            }}
          >
            Isolate this chat
          </button>
        </div>
      )}
      <div>
        <button onClick={dismiss}>Got it</button>
      </div>
    </div>
  );
}
