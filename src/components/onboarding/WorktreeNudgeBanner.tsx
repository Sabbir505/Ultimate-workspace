// Worktree-per-session migration nudge (roadmap P0 §3.1.1): a one-time
// MODAL shown to users who already have chats — NEW chats now get their own
// isolated git worktree, and existing chats can be moved with the per-chat
// toggle. Dismiss persists via the `worktrees.nudgeSeen` KV so it only
// appears once per install.
import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../../lib/ipc";
import { useChatStore } from "../../state/chat";
import { Modal } from "../common/Modal";

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
      /* best-effort: worst case the modal returns next launch */
    });
  };

  const activeSession = activeChatSessionId
    ? chatSessions.find((s) => s.id === activeChatSessionId)
    : undefined;
  const canIsolate = !!activeSession?.projectId;

  return (
    <Modal
      title="Chats now run in isolated worktrees"
      onClose={dismiss}
      actions={
        <>
          {canIsolate && (
            <button
              onClick={() => {
                void toggleSessionWorktree(activeSession!.id);
                dismiss();
              }}
            >
              Isolate this chat
            </button>
          )}
          <button onClick={dismiss}>Got it</button>
        </>
      }
    >
      <p>
        New chats get their own git worktree (branch <code>conduit/&lt;id&gt;</code>), so agents
        never collide in the same working tree. Existing chats can be moved with the 🪵/⛓ toggle
        in the sidebar or the ⛓ chip beside the composer's folder notch.
      </p>
    </Modal>
  );
}
