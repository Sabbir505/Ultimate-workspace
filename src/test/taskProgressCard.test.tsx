// A finished background task's card must not sit in the chat forever. The
// store only ever appended task snapshots, so every download the agent ran
// left a frozen DOWNLOAD card behind for the life of the session. Completed
// tasks now fade out and remove themselves; failed ones stay (that's where
// the error is readable) but are click-to-dismiss.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useChatStore } from "../state/chat";
import { TaskProgressCard } from "../components/chat/TaskProgressCard";

const SID = "sess-1";

function seedTask(state: "running" | "completed" | "failed") {
  act(() => {
    useChatStore.getState().onTaskProgress({
      chatSessionId: SID,
      taskId: "t1",
      kind: "download",
      state,
      message: state === "failed" ? "connection reset" : "done",
      downloaded: 100,
      total: 100,
      speedBps: 0,
      destPath: "/tmp/model.gguf",
    });
  });
}

function tasks() {
  return useChatStore.getState().tasks[SID] ?? {};
}

beforeEach(() => {
  useChatStore.setState({ tasks: {} });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("removeTask", () => {
  it("drops one task without touching its siblings or other sessions", () => {
    act(() => {
      useChatStore.getState().onTaskProgress({
        chatSessionId: SID,
        taskId: "a",
        kind: "download",
        state: "completed",
        message: "",
        downloaded: 0,
        total: null,
        speedBps: 0,
        destPath: null,
      });
      useChatStore.getState().onTaskProgress({
        chatSessionId: SID,
        taskId: "b",
        kind: "shell",
        state: "running",
        message: "",
        downloaded: 0,
        total: null,
        speedBps: 0,
        destPath: null,
      });
      useChatStore.getState().onTaskProgress({
        chatSessionId: "other",
        taskId: "a",
        kind: "download",
        state: "running",
        message: "",
        downloaded: 0,
        total: null,
        speedBps: 0,
        destPath: null,
      });
    });
    act(() => useChatStore.getState().removeTask(SID, "a"));
    expect(Object.keys(tasks())).toEqual(["b"]);
    expect(Object.keys(useChatStore.getState().tasks["other"])).toEqual(["a"]);
  });

  it("is a no-op for an unknown task (no store churn)", () => {
    const before = useChatStore.getState().tasks;
    act(() => useChatStore.getState().removeTask(SID, "nope"));
    expect(useChatStore.getState().tasks).toBe(before);
  });
});

describe("TaskProgressCard dismissal", () => {
  it("fades out and removes a completed task", () => {
    seedTask("completed");
    const { container } = render(<TaskProgressCard task={tasks().t1} chatSessionId={SID} />);
    const card = () => container.querySelector(".task-card")!;
    expect(screen.getByText("completed")).toBeTruthy();

    // Dwells first (so the result is readable), then fades.
    act(() => void vi.advanceTimersByTime(2000));
    expect(tasks().t1).toBeDefined();
    act(() => void vi.advanceTimersByTime(300));
    expect(card().className).toContain("task-card-leaving");

    act(() => void vi.advanceTimersByTime(400));
    expect(tasks().t1).toBeUndefined();
  });

  it("keeps a failed task until clicked", () => {
    seedTask("failed");
    const { container } = render(<TaskProgressCard task={tasks().t1} chatSessionId={SID} />);
    expect(screen.getByText("connection reset")).toBeTruthy();

    // Well past the success dwell — a failure must not self-dismiss, or the
    // error vanishes before it is read.
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tasks().t1).toBeDefined();

    act(() => {
      container.querySelector(".task-card")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => void vi.advanceTimersByTime(400));
    expect(tasks().t1).toBeUndefined();
  });

  it("never arms a dismissal while the task is still running", () => {
    seedTask("running");
    render(<TaskProgressCard task={tasks().t1} chatSessionId={SID} />);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(tasks().t1).toBeDefined();
  });
});
