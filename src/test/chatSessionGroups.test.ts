// Chat-list grouping + spawn-tree nesting (lib/chatSessionGroups): the pure
// rules behind the sidebar's Needs input / Working / Completed sections and
// the mesh/subagent nesting. Exercised directly so the sectioning, the
// parent-lifts-with-child behavior, and the paging cap stay pinned without
// rendering either sidebar.
import { describe, expect, it } from "vitest";
import {
  groupChatSessions,
  nestedParentId,
  sidechatSourceId,
  type SessionGroupInput,
} from "../lib/chatSessionGroups";

interface Row extends SessionGroupInput {
  title: string;
}

function row(
  id: string,
  over: Partial<Row> = {},
): Row {
  return { id, title: id, lastActiveAt: 1, starred: false, ...over };
}

const none = () => false;

describe("nestedParentId", () => {
  it("parses the spawn parent out of `spawned_by:`", () => {
    expect(nestedParentId("spawned_by:parent-1")).toBe("parent-1");
  });

  it("parses the source chat out of `side_of:` (a sidechat nests too)", () => {
    expect(nestedParentId("side_of:parent-1")).toBe("parent-1");
  });

  it("returns null for human chats, forks, and empty parents", () => {
    expect(nestedParentId(null)).toBeNull();
    expect(nestedParentId(undefined)).toBeNull();
    expect(nestedParentId("fork_of:abc")).toBeNull();
    expect(nestedParentId("spawned_by:")).toBeNull();
    expect(nestedParentId("side_of:")).toBeNull();
  });
});

describe("sidechatSourceId", () => {
  it("parses the source chat out of `side_of:`", () => {
    expect(sidechatSourceId("side_of:parent-1")).toBe("parent-1");
  });

  it("never matches spawns or forks — those are not sidechats", () => {
    expect(sidechatSourceId("spawned_by:parent-1")).toBeNull();
    expect(sidechatSourceId("fork_of:abc")).toBeNull();
  });

  it("returns null for human chats and empty/missing sources", () => {
    expect(sidechatSourceId(null)).toBeNull();
    expect(sidechatSourceId(undefined)).toBeNull();
    expect(sidechatSourceId("")).toBeNull();
    expect(sidechatSourceId("side_of:")).toBeNull();
    expect(sidechatSourceId("side_of:   ")).toBeNull();
  });
});

describe("groupChatSessions", () => {
  it("splits roots into Needs input / Working / Completed by own state", () => {
    const rows = [
      row("a", { lastActiveAt: 3 }),
      row("b", { lastActiveAt: 2 }),
      row("c", { lastActiveAt: 1 }),
    ];
    const groups = groupChatSessions(rows, {
      isWorking: (r) => r.id === "b",
      needsInput: (r) => r.id === "a",
    });
    expect(groups.sections.map((s) => s.key)).toEqual([
      "needsInput",
      "working",
      "completed",
    ]);
    expect(groups.sections[0].rows.map((r) => r.session.id)).toEqual(["a"]);
    expect(groups.sections[1].rows.map((r) => r.session.id)).toEqual(["b"]);
    expect(groups.sections[2].rows.map((r) => r.session.id)).toEqual(["c"]);
  });

  it("nests an agent-spawned child under its parent in the parent's section", () => {
    const rows = [
      row("parent", { lastActiveAt: 5 }),
      row("child", { parentId: "parent", lastActiveAt: 4 }),
    ];
    const groups = groupChatSessions(rows, {
      isWorking: (r) => r.id === "parent",
      needsInput: none,
    });
    // Parent works → its section is Working; the child rides along, indented.
    const working = groups.sections.find((s) => s.key === "working")!;
    expect(working.rows.map((r) => r.session.id)).toEqual(["parent", "child"]);
    expect(working.rows[0].nested).toBe(false);
    expect(working.rows[1].nested).toBe(true);
    // The child is done while the parent still works → nested + bold.
    expect(working.rows[1].completed).toBe(true);
    expect(working.rows[0].completed).toBe(false);
    expect(groups.totalRoots).toBe(1);
  });

  it("lifts a parent into Needs input when a child needs input", () => {
    const rows = [
      row("parent"),
      row("child", { parentId: "parent" }),
    ];
    const groups = groupChatSessions(rows, {
      isWorking: none,
      needsInput: (r) => r.id === "child",
    });
    expect(groups.sections[0].key).toBe("needsInput");
    expect(groups.sections[0].rows.map((r) => r.session.id)).toEqual([
      "parent",
      "child",
    ]);
    // Only the child itself carries the input mark.
    expect(groups.sections[0].rows[0].needsInput).toBe(false);
    expect(groups.sections[0].rows[1].needsInput).toBe(true);
  });

  it("keeps a child with its parent even when its own project differs", () => {
    // A missing parent leaves the child top-level (nothing to nest under).
    const rows = [row("orphan", { parentId: "gone" })];
    const groups = groupChatSessions(rows, { isWorking: none, needsInput: none });
    expect(groups.sections[0].rows[0].nested).toBe(false);
  });

  it("caps displayed roots (Show more) while keeping children attached", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row(`c-${i}`, { lastActiveAt: 100 - i }),
    );
    const groups = groupChatSessions(rows, {
      isWorking: none,
      needsInput: none,
      maxRoots: 5,
    });
    expect(groups.totalRoots).toBe(7);
    expect(groups.shownRoots).toBe(5);
    expect(groups.hasMore).toBe(true);
    const shown = groups.sections.flatMap((s) => s.rows);
    expect(shown).toHaveLength(5);
    expect(shown.map((r) => r.session.id)).toEqual([
      "c-0",
      "c-1",
      "c-2",
      "c-3",
      "c-4",
    ]);
  });

  it("floats starred roots within their section", () => {
    const rows = [
      row("old-pinned", { starred: true, lastActiveAt: 1 }),
      row("new", { lastActiveAt: 10 }),
    ];
    const groups = groupChatSessions(rows, { isWorking: none, needsInput: none });
    expect(groups.sections[0].rows.map((r) => r.session.id)).toEqual([
      "old-pinned",
      "new",
    ]);
  });
});
