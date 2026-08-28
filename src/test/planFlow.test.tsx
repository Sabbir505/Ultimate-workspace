// Structured plan tracking (todo_write / enter_plan_mode / present_plan):
// proposal-card rendering, the store slices (authoritative todos, plan-mode
// flag, proposal lifecycle, approved-plan list).
// Note: the live step checklist lives ONLY in the git sidebar's Progress
// section (fed by planSteps) — there is deliberately no duplicate card under
// the chat stream, so there's no PlanChecklistCard to test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { useChatStore } from "../state/chat";
import { PlanProposalCard } from "../components/chat/PlanProposalCard";
import type { PlanTodo } from "../lib/ipc";

const TODOS: PlanTodo[] = [
  { content: "Read the config", status: "completed" },
  { content: "Write parser", status: "in_progress", activeForm: "Writing parser" },
  { content: "Wire up CLI", status: "pending" },
];

describe("PlanProposalCard", () => {
  afterEach(() => cleanup());

  it("approves directly", () => {
    const onResolve = vi.fn();
    render(<PlanProposalCard proposal={{ pendingId: "p1", title: "Auth refactor", plan: "## Approach\nSplit the module." }} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("Approve plan"));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it("requires a second click to reject, forwarding the feedback text", () => {
    const onResolve = vi.fn();
    render(<PlanProposalCard proposal={{ pendingId: "p1", title: "Auth refactor", plan: "## Approach\nSplit the module." }} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("Reject"));
    // First click opens the feedback box instead of resolving.
    expect(onResolve).not.toHaveBeenCalled();
    const box = screen.getByPlaceholderText(/What should change/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "too broad" } });
    fireEvent.click(screen.getByText("Send rejection"));
    expect(onResolve).toHaveBeenCalledWith(false, "too broad");
  });
});

describe("plan store slices", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessionTodos: {},
      planMode: {},
      pendingPlanProposals: {},
      sessionPlans: {},
      planSteps: {
        s1: [
          {
            stepId: "plan-s1-1-0",
            label: "old prose plan step",
            status: "pending",
            source: "parsed",
            planIndex: 1,
            stepIndex: 0,
          },
        ],
      },
      sessions: [
        {
          id: "s1",
          title: "t",
          provider: "openai",
          model: "m",
          createdAt: 0,
          lastActiveAt: 0,
          permissionMode: "auto_edit",
        } as never,
      ],
    });
  });

  it("onPlanUpdated replaces the todo list and mirrors into planSteps, keeping parsed steps", () => {
    useChatStore.getState().onPlanUpdated({ chatSessionId: "s1", todos: TODOS });
    const s = useChatStore.getState();
    expect(s.sessionTodos["s1"]).toEqual(TODOS);
    const steps = s.planSteps["s1"];
    // Parsed step survives; three todo_write steps are appended after it.
    expect(steps).toHaveLength(4);
    expect(steps[0].source).toBe("parsed");
    const mirrored = steps.slice(1);
    expect(mirrored.map((st) => st.source)).toEqual([
      "todo_write",
      "todo_write",
      "todo_write",
    ]);
    expect(mirrored.map((st) => st.status)).toEqual(["completed", "in_progress", "pending"]);
  });

  it("onPlanUpdated re-mirroring drops stale todo_write steps instead of stacking", () => {
    const store = useChatStore.getState();
    store.onPlanUpdated({ chatSessionId: "s1", todos: TODOS });
    useChatStore.getState().onPlanUpdated({
      chatSessionId: "s1",
      todos: [{ content: "Revised step", status: "in_progress" }],
    });
    const steps = useChatStore.getState().planSteps["s1"];
    expect(steps.map((st) => st.label)).toEqual(["old prose plan step", "Revised step"]);
  });

  it("onPlanMode flips the flag AND mirrors the persisted label onto the session", () => {
    // Model-initiated enter_plan_mode → label "plan" lands on the session.
    useChatStore
      .getState()
      .onPlanMode({ chatSessionId: "s1", active: true, reason: "model", label: "plan" });
    expect(useChatStore.getState().planMode["s1"]).toBe(true);
    expect(useChatStore.getState().sessions[0].permissionMode).toBe("plan");
    // Approval exit → the restored posture label replaces "plan".
    useChatStore
      .getState()
      .onPlanMode({ chatSessionId: "s1", active: false, reason: "plan approved", label: "auto_edit" });
    expect(useChatStore.getState().planMode["s1"]).toBe(false);
    expect(useChatStore.getState().sessions[0].permissionMode).toBe("auto_edit");
  });

  it("setSessionPlanMode flips the flag optimistically and persists", async () => {
    await useChatStore.getState().setSessionPlanMode("s1", true);
    expect(useChatStore.getState().planMode["s1"]).toBe(true);
    // Entry labels the session "plan" right away.
    expect(useChatStore.getState().sessions[0].permissionMode).toBe("plan");

    await useChatStore.getState().setSessionPlanMode("s1", false);
    expect(useChatStore.getState().planMode["s1"]).toBe(false);
  });

  it("setSessionPlanMode is idempotent when the flag already matches", async () => {
    useChatStore.setState({ planMode: { s1: true } });
    // No-op path must not throw or touch anything (safeInvoke no-ops anyway).
    await useChatStore.getState().setSessionPlanMode("s1", true);
    expect(useChatStore.getState().planMode["s1"]).toBe(true);
  });

  it("onPlanAccepted prepends approved plans newest-first", () => {
    const store = useChatStore.getState();
    store.onPlanAccepted({
      chatSessionId: "s1",
      plan: { id: "plan-1", title: "First", content: "c1", approvedAt: 1 },
    });
    store.onPlanAccepted({
      chatSessionId: "s1",
      plan: { id: "plan-2", title: "Second", content: "c2", approvedAt: 2 },
    });
    const plans = useChatStore.getState().sessionPlans["s1"];
    expect(plans.map((p) => p.title)).toEqual(["Second", "First"]);
    // Other sessions untouched.
    expect(useChatStore.getState().sessionPlans["s2"]).toBeUndefined();
  });

  it("proposal surfaces and resolves optimistically (card removed, not restored on success)", async () => {
    const store = useChatStore.getState();
    store.onPlanProposal({ chatSessionId: "s1", pendingId: "p1", title: "Auth refactor", plan: "## Approach" });
    expect(useChatStore.getState().pendingPlanProposals["s1"]?.pendingId).toBe("p1");

    // safeInvoke no-ops outside Tauri and resolves — the optimistic removal
    // stands (the restore-on-failure branch mirrors resolveApproval's M3 fix
    // and needs a failing IPC bridge to exercise, which jsdom can't produce).
    await useChatStore.getState().resolvePlanProposal("s1", true);
    expect(useChatStore.getState().pendingPlanProposals["s1"]).toBeUndefined();
  });

  it("deleteChat drops the plan slices for the deleted session only", async () => {
    const store = useChatStore.getState();
    store.onPlanUpdated({ chatSessionId: "s1", todos: TODOS });
    store.onPlanMode({ chatSessionId: "s1", active: true, reason: null, label: "plan" });
    store.onPlanProposal({ chatSessionId: "s1", pendingId: "p1", title: "T", plan: "P" });
    store.onPlanUpdated({
      chatSessionId: "s2",
      todos: [{ content: "x", status: "pending" }],
    });

    await useChatStore.getState().deleteChat("s1");

    const s = useChatStore.getState();
    expect(s.sessionTodos["s1"]).toBeUndefined();
    expect(s.planMode["s1"]).toBeUndefined();
    expect(s.pendingPlanProposals["s1"]).toBeUndefined();
    // Other sessions untouched.
    expect(s.sessionTodos["s2"]).toHaveLength(1);
  });
});
