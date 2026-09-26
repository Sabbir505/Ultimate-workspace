// "Fork chat to side-by-side panes" dialog. One chat becomes N new sessions —
// each a copy of the source's config and live history — pinned side by side
// so different directions (prompts, models, agents) can be explored in
// parallel. The store's forkChatToPanes does the work; this dialog only
// picks the count and resolves which chat to fork.
//
// Source resolution: an explicit session id (sidebar row menu) wins; null
// means the focused pane's chat (split view) or the active chat (single view).
import { useEffect, useState } from "react";
import { GitFork } from "lucide-react";
import { Modal } from "../common/Modal";
import { useChatStore } from "../../state/chat";
import { MAX_CHAT_PANES, countChatPanes } from "../../state/chat/paneTree";
import { useUiStore } from "../../state/ui";

/** Fork counts the dialog offers, smallest first. */
const FORK_OPTIONS = [2, 3, 4] as const;

export function ForkChatModal() {
  const open = useUiStore((s) => s.forkChatModalOpen);
  const sourceId = useUiStore((s) => s.forkChatModalSourceId);
  const close = useUiStore((s) => s.closeForkChatModal);
  const tree = useChatStore((s) => s.chatPaneTree);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const focusedPaneId = useChatStore((s) => s.focusedPaneId);
  const paneBuffers = useChatStore((s) => s.paneBuffers);
  const sessions = useChatStore((s) => s.sessions);
  const messages = useChatStore((s) => s.messages);
  const messagesSessionId = useChatStore((s) => s.messagesSessionId);

  const [count, setCount] = useState<number>(2);
  const [busy, setBusy] = useState(false);

  // Re-arm the picker each time the dialog opens.
  useEffect(() => {
    if (open) {
      setCount(2);
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  const resolvedId =
    sourceId ??
    (focusedPaneId ? paneBuffers[focusedPaneId]?.sessionId ?? null : null) ??
    activeChatSessionId;
  const source = resolvedId ? sessions.find((s) => s.id === resolvedId) ?? null : null;

  // Room under the pane cap: the main pane counts as one slot (it keeps
  // showing the original chat), every existing pinned pane consumes one.
  const room = Math.max(0, MAX_CHAT_PANES - countChatPanes(tree));
  const options: number[] = FORK_OPTIONS.filter((n) => n <= room);
  // Clamped pick: a stale count (pane layout changed while open) falls back
  // to the largest offer that still fits.
  const chosen = options.includes(count)
    ? count
    : options.length > 0
      ? Math.min(count, options[options.length - 1])
      : 0;

  // The active chat is only forkable when its buffer actually holds its rows
  // (same buffer-ownership shape the store guards apply) — an empty chat has
  // no history to copy, and its session would be swept on the next switch.
  const activeEmpty =
    resolvedId != null &&
    resolvedId === activeChatSessionId &&
    messagesSessionId === resolvedId &&
    messages.length === 0;

  const canFork = source != null && !activeEmpty && chosen > 0 && !busy;

  const confirm = async () => {
    if (!resolvedId || !canFork) return;
    setBusy(true);
    try {
      const n = await useChatStore.getState().forkChatToPanes(resolvedId, chosen);
      const ui = useUiStore.getState();
      if (n > 0) {
        ui.pushToast(
          "success",
          n === 1
            ? "Forked into 1 side-by-side chat"
            : `Forked into ${n} side-by-side chats`,
        );
        close();
      } else {
        // Nothing forked (no room / refused) — stay open, the store toasted why.
        setBusy(false);
      }
    } catch {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Fork chat"
      onClose={close}
      className="fork-chat-modal"
      actions={
        <>
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void confirm()} disabled={!canFork}>
            {busy
              ? "Forking…"
              : chosen > 0
                ? `Fork into ${chosen} ${chosen === 1 ? "pane" : "panes"}`
                : "Fork"}
          </button>
        </>
      }
    >
      {source ? (
        <p className="fork-chat-source">
          <GitFork size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="fork-chat-source-title">
            {source.title?.trim() || "New chat"}
          </span>
        </p>
      ) : (
        <p className="fork-chat-note">No chat is open to fork.</p>
      )}
      <p className="fork-chat-copy">
        Each fork copies this chat&apos;s full history and continues
        independently — try different prompts, models, or agents side by side.
      </p>
      {options.length > 0 ? (
        <div className="fork-count-row" role="radiogroup" aria-label="How many forks">
          {options.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={n === chosen}
              className={`fork-count-btn${n === chosen ? " selected" : ""}`}
              onClick={() => setCount(n)}
              disabled={busy}
            >
              <strong>{n}</strong>
              <span>pane{n > 1 ? "s" : ""}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="fork-chat-note">
          No room for more panes — close one and try again (up to{" "}
          {MAX_CHAT_PANES} chats can be open at once).
        </p>
      )}
      {activeEmpty && (
        <p className="fork-chat-note">Send a message first — there&apos;s nothing to fork yet.</p>
      )}
    </Modal>
  );
}
