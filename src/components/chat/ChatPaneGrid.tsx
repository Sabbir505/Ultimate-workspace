// ChatPaneGrid: renders the split-chat pane tree recursively.
//
// A leaf is one full ChatView. Exactly one leaf is the MAIN pane (sessionId
// null — it follows the global active chat); every other leaf pins one
// concrete session. ALL panes — main included — carry a slim header (title +
// close ✕): closing the main pane promotes the first remaining pane to
// follower, so there is always exactly one main.
//
// A split node lays its two children out in a row (left/right) or column
// (top/bottom) with a draggable resizer between them — every internal node
// owns its ratio, so ALL gutters resize independently (up to 6 panes).
//
// Every pane is also a drop target: while a chat session is dragged from the
// sidebar, four edge zones (left/right/top/bottom) arm over the pane and the
// hovered edge previews the OUTCOME — a half-pane dashed overlay, equal to
// what the existing pane will shrink to. Dropping opens that session there.
import { useCallback, useRef, useState } from "react";
import { startPointerDrag } from "../../lib/pointerDrag";
import { useUiStore } from "../../state/ui";
import {
  draggedChatSessionId,
  endChatSessionDrag,
  useChatSessionDrag,
} from "../../lib/chatPaneDnd";
import { useChatStore } from "../../state/chat";
import {
  type ChatPaneEdge,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type ChatPaneSplit,
} from "../../state/chat/paneTree";
import { ChatView } from "./ChatView";

/** One pane: a full-fidelity chat view plus pane chrome (focus pin, floating
 *  close ✕, drag-and-drop edge zones). There is deliberately NO title bar —
 *  the top toolbar already shows the FOCUSED pane's chat title, so a bar per
 *  pane just duplicated it (in the single view it read as a double header). */
function PaneLeafView({ leaf }: { leaf: ChatPaneLeaf }) {
  // The follower is the leaf with NO pinned session — after a main close the
  // promoted leaf keeps its original pane id, so paneId is not the identity.
  const isMain = leaf.sessionId == null;
  const setFocusedPane = useChatStore((s) => s.setFocusedPane);
  const closeChatPane = useChatStore((s) => s.closeChatPane);
  const sessionId = useChatStore((s) =>
    isMain ? s.activeChatSessionId : (s.paneBuffers[leaf.paneId]?.sessionId ?? null),
  );
  const title = useChatStore((s) =>
    sessionId ? (s.sessions.find((x) => x.id === sessionId)?.title?.trim() || "New chat") : null,
  );

  return (
    <div
      className={`chat-pane${isMain ? " chat-pane-main" : ""}`}
      data-pane={leaf.paneId}
      onPointerDownCapture={() => setFocusedPane(isMain ? null : leaf.paneId)}
    >
      {/* Floating close — hovers in over the pane's top-right corner (the
          chat title lives in the top toolbar, focused-pane aware). Closing
          the main pane promotes the first remaining pane to follower. */}
      <button
        type="button"
        className="chat-pane-float-close"
        onClick={() => closeChatPane(leaf.paneId)}
        title={`Close “${title ?? "chat"}”`}
        aria-label={`Close pane: ${title ?? "chat"}`}
      >
        ✕
      </button>
      {isMain ? <ChatView /> : <ChatView paneId={leaf.paneId} />}
      <PaneDropZones paneId={leaf.paneId} />
    </div>
  );
}

/** The four edge drop zones of one pane, mounted only while a chat-session
 *  drag is live. The hovered edge shows the OUTCOME preview: a dashed
 *  overlay covering half the pane — exactly the share the existing pane
 *  will give up. Dropping dispatches the move. */
function PaneDropZones({ paneId }: { paneId: string }) {
  const dragging = useChatSessionDrag((s) => s.sessionId != null);
  const [hover, setHover] = useState<ChatPaneEdge | null>(null);
  if (!dragging) return null;
  return (
    <>
      {(["left", "right", "top", "bottom"] as ChatPaneEdge[]).map((edge) => (
        <DropZone key={edge} edge={edge} paneId={paneId} onHover={setHover} />
      ))}
      {/* Half-pane preview of where the new chat will land. Above the zones
          (z-order) but pointer-transparent so the zones keep the hit. */}
      {hover && <div className={`chat-pane-drop-preview ${hover}`} aria-hidden="true" />}
    </>
  );
}

const MIN_SPLIT_HALF_W = 320; // px — a left/right split halves the pane's width
const MIN_SPLIT_HALF_H = 240; // px — a top/bottom split halves its height

/** One edge hit zone (a strip along that edge). Stateless: hover reporting
 *  goes to the parent so exactly one preview renders. */
function DropZone({
  edge,
  paneId,
  onHover,
}: {
  edge: ChatPaneEdge;
  paneId: string;
  onHover: (edge: ChatPaneEdge | null) => void;
}) {
  const zoneRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={zoneRef}
      className={`chat-pane-dropzone ${edge}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        onHover(edge);
      }}
      onDragLeave={() => onHover(null)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onHover(null);
        const sessionId = draggedChatSessionId();
        endChatSessionDrag();
        if (!sessionId) return;
        // Refuse splits that would crush a pane below a usable size (the
        // split halves this pane along the drop axis). Zero-rect environments
        // (jsdom tests, hidden panes) skip the guard.
        const paneEl = zoneRef.current?.closest(".chat-pane");
        const rect = paneEl?.getBoundingClientRect();
        const half =
          edge === "left" || edge === "right" ? rect?.width ?? 0 : rect?.height ?? 0;
        const min = edge === "left" || edge === "right" ? MIN_SPLIT_HALF_W : MIN_SPLIT_HALF_H;
        if (rect && rect.width > 0 && rect.height > 0 && half / 2 < min) {
          useUiStore.getState().pushToast(
            "info",
            "Not enough room to split this pane — try a larger window",
          );
          return;
        }
        void useChatStore.getState().moveChatSessionToPane(sessionId, paneId, edge);
      }}
    />
  );
}

/** A split node: two subtrees in a row or column with a draggable gutter.
 *  The ratio lives on THIS node, so sibling gutters are independent. */
function SplitNodeView({ node }: { node: ChatPaneSplit }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setChatPaneRatio = useChatStore((s) => s.setChatPaneRatio);
  const [resizing, setResizing] = useState(false);

  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      setResizing(true);
      // PERF: same rAF-throttle as the old single-split resizer — pointermove
      // fires at input frequency and each ratio write re-renders the grid.
      let latestX = e.clientX;
      let latestY = e.clientY;
      let frame: number | null = null;
      const applyRatio = () => {
        frame = null;
        const rect = el.getBoundingClientRect();
        const ratio =
          node.dir === "row"
            ? (latestX - rect.left) / rect.width
            : (latestY - rect.top) / rect.height;
        setChatPaneRatio(node.id, ratio);
      };
      startPointerDrag(
        e,
        (x, y) => {
          latestX = x;
          latestY = y;
          if (frame === null) frame = requestAnimationFrame(applyRatio);
        },
        () => {
          if (frame !== null) cancelAnimationFrame(frame);
          setResizing(false);
        },
        { capture: true },
      );
    },
    [node.dir, node.id, setChatPaneRatio],
  );

  return (
    <div
      ref={containerRef}
      className={`chat-pane-split dir-${node.dir}${resizing ? " pane-resizing" : ""}`}
    >
      <div className="chat-pane-cell" style={{ flexGrow: node.ratio, flexBasis: 0 }}>
        <ChatPaneGrid node={node.a} />
      </div>
      <div
        className="chat-pane-resizer"
        data-dir={node.dir}
        role="separator"
        aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
        aria-label="Drag to resize the split chats"
        title="Drag to resize"
        onPointerDown={startResize}
      />
      <div className="chat-pane-cell" style={{ flexGrow: 1 - node.ratio, flexBasis: 0 }}>
        <ChatPaneGrid node={node.b} />
      </div>
    </div>
  );
}

/** Recursive tree renderer. Also used for the tree-less layout: App passes a
 *  bare main leaf so the single view gets the same chrome and drop targets. */
export function ChatPaneGrid({ node }: { node: ChatPaneNode }) {
  if (node.kind === "leaf") return <PaneLeafView leaf={node} />;
  return <SplitNodeView node={node} />;
}
