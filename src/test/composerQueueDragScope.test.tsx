// B8 (ISSUES.md): the queue grip's drag-reorder hit-test queried rows with a
// DOCUMENT-GLOBAL selector. Split view mounts one composer per pane, and the
// other pane's rows (same viewport region) won the last-match-wins loop —
// the computed target index belonged to the foreign queue and the store's
// range guard silently no-op'd the reorder. The hit-test must be scoped to
// THIS pane's .composer-queue container.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatComposer } from "../components/chat/ChatComposer";
import { useChatStore } from "../state/chat";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
}));

// jsdom has no pointer capture — the grip calls it on pointerdown.
if (typeof Element !== "undefined" && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function () {};
}
if (typeof Element !== "undefined" && !Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = function () {};
}

/** jsdom 25 has no PointerEvent constructor, so fireEvent.pointerMove cannot
 *  carry clientY/pointerId. Dispatch a MouseEvent with the pointer fields
 *  attached — React's delegated pointermove listener treats it the same. */
function firePointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  opts: { pointerId?: number; clientY?: number } = {},
) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: opts.clientY ?? 0 });
  Object.defineProperty(e, "pointerId", { value: opts.pointerId ?? 1 });
  el.dispatchEvent(e);
}

beforeEach(() => {
  useChatStore.setState({
    messageQueue: {
      sA: [
        { id: 1, content: "alpha one" },
        { id: 2, content: "alpha two" },
      ],
      sB: [
        { id: 3, content: "beta one" },
        { id: 4, content: "beta two" },
      ],
    },
  });
});

afterEach(() => {
  cleanup();
  useChatStore.setState({ messageQueue: {} });
});

/** Both panes' rows occupy the SAME viewport bands (0-40 / 40-80) — exactly
 *  the overlap that made the document-global scan pick the foreign pane's
 *  row index last. */
function bandRect(i: number) {
  return { top: i * 40, bottom: i * 40 + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: i * 40, toJSON: () => {} };
}

describe("queue drag-reorder is scoped to this pane", () => {
  it("dragging in pane A reorders ONLY pane A's queue", () => {
    render(
      <>
        <ChatComposer sessionId="sA" onSend={vi.fn()} streaming={false} onAgentModelPick={vi.fn()} />
        <ChatComposer sessionId="sB" onSend={vi.fn()} streaming={false} onAgentModelPick={vi.fn()} />
      </>,
    );

    const queues = Array.from(document.querySelectorAll<HTMLElement>(".composer-queue"));
    expect(queues).toHaveLength(2);
    const [queueA, queueB] = queues;
    const rowsA = Array.from(queueA.querySelectorAll<HTMLElement>(".composer-queue-row"));
    const rowsB = Array.from(queueB.querySelectorAll<HTMLElement>(".composer-queue-row"));
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(2);
    rowsA.forEach((el, i) => { el.getBoundingClientRect = () => bandRect(i) as DOMRect; });
    rowsB.forEach((el, i) => { el.getBoundingClientRect = () => bandRect(i) as DOMRect; });

    // Drag row 0 onto row 1's band INSIDE pane A. Both panes' rows cover
    // clientY=60, so the pointer lands on A[1] AND B[1].
    const grip = rowsA[0].querySelector<HTMLElement>(".composer-queue-grip")!;
    firePointer(grip, "pointerdown", { pointerId: 7, clientY: 5 });
    firePointer(grip, "pointermove", { pointerId: 7, clientY: 60 });

    const q = useChatStore.getState().messageQueue;
    // Pane A reordered (0 → 1). With the document-global selector the loop
    // landed on B's row index (1 within its own container = 3 globally) and
    // the out-of-range move was silently dropped.
    expect(q.sA.map((m) => m.id)).toEqual([2, 1]);
    // Pane B untouched.
    expect(q.sB.map((m) => m.id)).toEqual([3, 4]);
  });
});
