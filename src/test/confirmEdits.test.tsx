// Confirm-edits posture (§4.2.5) — frontend wiring:
//  * the mode menu lists "Confirm Edits" and the policy mappings round-trip;
//  * an approval card carrying `__relayEditPreview` renders per-occurrence
//    checkboxes and resolves with the SELECTED indexes (partial accept);
//  * "Apply all" resolves with no selection (accept everything).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  getPermissionsRules: vi.fn().mockResolvedValue([]),
  setPermissionsRules: vi.fn().mockResolvedValue(undefined),
}));

import { ApprovalCard } from "../components/chat/ApprovalFlow";
import { PERMISSION_MODES } from "../components/chat/PermissionModeMenu";
import {
  permissionModeToPolicies,
  policiesToPermissionMode,
} from "../state/chat/moduleState";
import type { PendingApproval } from "../state/chat";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("confirm-edits mode plumbing", () => {
  it("the mode menu lists Confirm Edits between Manual and Auto-Edit", () => {
    const values = PERMISSION_MODES.map((m) => m.value);
    expect(values).toContain("confirm_edits");
    expect(values.indexOf("manual")).toBeLessThan(values.indexOf("confirm_edits"));
    expect(values.indexOf("confirm_edits")).toBeLessThan(values.indexOf("auto_edit"));
  });

  it("policy mappings round-trip confirm_edits in both directions", () => {
    expect(permissionModeToPolicies("confirm_edits")).toEqual({
      sandbox: "workspace_write",
      approval: "confirm_edits",
    });
    expect(
      policiesToPermissionMode("workspace_write", "confirm_edits")
    ).toBe("confirm_edits");
    // Siblings unchanged.
    expect(policiesToPermissionMode("workspace_write", "on_request")).toBe("manual");
    expect(policiesToPermissionMode("workspace_write", "auto_edit")).toBe("auto_edit");
  });
});

const previewApproval = (): PendingApproval => ({
  pendingId: "p1",
  tool: "edit_file",
  summary: "Edit src/config.rs",
  args: {
    path: "C:/proj/src/config.rs",
    find: "TODO",
    replace: "done()",
    __relayEditPreview: {
      kind: "edit",
      path: "C:/proj/src/config.rs",
      findChars: 4,
      replaceChars: 6,
      totalOccurrences: 3,
      occurrences: [
        { index: 1, line: 2, context: "let x = TODO;" },
        { index: 2, line: 7, context: "let y = TODO; // footer" },
        { index: 3, line: 11, context: "let z = TODO;" },
      ],
    },
  },
});

describe("ApprovalCard occurrence review", () => {
  it("renders the occurrence checklist, all selected by default", () => {
    render(<ApprovalCard approval={previewApproval()} onResolve={vi.fn()} />);
    expect(screen.getByTestId("edit-preview")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox");
    // 3 occurrence checkboxes (the always-allow row is hidden for previews).
    expect(boxes.length).toBe(3);
    for (const box of boxes) {
      expect((box as HTMLInputElement).checked).toBe(true);
    }
  });

  it("Apply selected resolves with ONLY the kept occurrence indexes", () => {
    const onResolve = vi.fn();
    render(<ApprovalCard approval={previewApproval()} onResolve={onResolve} />);
    // Untick occurrence 2 (line 7).
    const row = screen.getByText(/footer/).closest("label")!;
    fireEvent.click(row.querySelector("input")!);
    fireEvent.click(screen.getByRole("button", { name: /Apply selected \(2\)/ }));
    expect(onResolve).toHaveBeenCalledWith(true, [1, 3]);
  });

  it("with everything selected, plain Allow accepts all (no selection payload)", () => {
    const onResolve = vi.fn();
    render(<ApprovalCard approval={previewApproval()} onResolve={onResolve} />);
    // All occurrences ticked → the partial buttons hide; Allow = apply all.
    expect(screen.queryByRole("button", { name: "Apply all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it("unticking one exposes Apply all, which resolves with no selection", () => {
    const onResolve = vi.fn();
    render(<ApprovalCard approval={previewApproval()} onResolve={onResolve} />);
    const row = screen.getByText(/footer/).closest("label")!;
    fireEvent.click(row.querySelector("input")!);
    fireEvent.click(screen.getByRole("button", { name: "Apply all" }));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it("unticking everything falls back to a plain Allow (or Deny)", () => {
    const onResolve = vi.fn();
    render(<ApprovalCard approval={previewApproval()} onResolve={onResolve} />);
    for (const box of screen.getAllByRole("checkbox")) {
      fireEvent.click(box);
    }
    // No partial button when nothing is selected; plain Allow remains.
    expect(screen.queryByRole("button", { name: /Apply selected/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it("a plain (non-preview) card keeps the classic Allow/Deny UI", () => {
    const onResolve = vi.fn();
    render(
      <ApprovalCard
        approval={{
          pendingId: "p2",
          tool: "write_file",
          summary: "Write report.md",
          args: { path: "C:/proj/report.md", content: "x" },
        }}
        onResolve={onResolve}
      />,
    );
    expect(screen.queryByTestId("edit-preview")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  it("a write preview shows the overwrite summary and bounded content", () => {
    render(
      <ApprovalCard
        approval={{
          pendingId: "p3",
          tool: "write_file",
          summary: "Write notes.md",
          args: {
            path: "C:/proj/notes.md",
            content: "l1\nl2",
            __relayEditPreview: {
              kind: "write",
              path: "C:/proj/notes.md",
              exists: true,
              lines: 2,
              chars: 5,
              preview: "l1\nl2",
            },
          },
        }}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText(/Overwrites/)).toBeTruthy();
    expect(screen.getByText(/2 lines · 5 chars/)).toBeTruthy();
  });
});
