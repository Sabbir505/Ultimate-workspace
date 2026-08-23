// Approval rules engine (roadmap #8) — frontend wiring tests:
//  * ApprovalCard's "Always allow" checkbox persists a directory-anchored rule
//    (tool + glob) before resolving Allow; unticked Allow and Deny never write.
//  * PermissionRulesPanel lists persisted rules, adds a new one, removes one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getPermissionsRulesMock = vi.fn();
const setPermissionsRulesMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  getPermissionsRules: (...a: unknown[]) => getPermissionsRulesMock(...a),
  setPermissionsRules: (...a: unknown[]) => setPermissionsRulesMock(...a),
}));

import { ApprovalCard } from "../components/chat/ApprovalFlow";
import { PermissionRulesPanel } from "../components/settings/PermissionRulesPanel";
import type { ApprovalRule } from "../lib/ipc";
import type { PendingApproval } from "../state/chat";

const rule = (over: Partial<ApprovalRule> = {}): ApprovalRule => ({
  id: "r1",
  tool: "write_file",
  pattern: "/p/src/**",
  createdAt: 1_700_000_000,
  ...over,
});

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  pendingId: "p1",
  tool: "edit_file",
  summary: "Edit src/app.ts",
  args: { path: "C:/proj/src/app.ts", content: "x" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getPermissionsRulesMock.mockResolvedValue([]);
  setPermissionsRulesMock.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("ApprovalCard always-allow capture", () => {
  it("shows the checkbox only when a target path is extractable", () => {
    render(<ApprovalCard approval={approval()} onResolve={vi.fn()} />);
    expect(screen.getByText(/always allow edit_file/i)).toBeTruthy();
    cleanup();
    // A card whose args carry no path (e.g. run_shell w/o dest) hides it.
    render(
      <ApprovalCard
        approval={approval({ tool: "run_shell", args: { command: "ls" } })}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.queryByText(/always allow/i)).toBeNull();
  });

  it("persists a directory-anchored rule before resolving Allow when ticked", async () => {
    const onResolve = vi.fn();
    getPermissionsRulesMock.mockResolvedValue([rule()]);
    render(<ApprovalCard approval={approval()} onResolve={onResolve} />);

    fireEvent.click(screen.getByLabelText(/always allow edit_file/i));
    fireEvent.click(screen.getByText("Allow"));

    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(true));
    await waitFor(() => expect(setPermissionsRulesMock).toHaveBeenCalledTimes(1));
    const saved = setPermissionsRulesMock.mock.calls[0][0] as ApprovalRule[];
    // Appends to the existing rules; pattern anchors to the file's directory.
    expect(saved).toHaveLength(2);
    expect(saved[1].tool).toBe("edit_file");
    expect(saved[1].pattern).toBe("C:/proj/src/**");
  });

  it("does not duplicate an identical existing rule", async () => {
    const onResolve = vi.fn();
    // Pre-existing rule already covers this tool+pattern.
    getPermissionsRulesMock.mockResolvedValue([
      rule({ id: "existing", tool: "edit_file", pattern: "C:/proj/src/**" }),
    ]);
    render(<ApprovalCard approval={approval()} onResolve={onResolve} />);
    fireEvent.click(screen.getByLabelText(/always allow edit_file/i));
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(onResolve).toHaveBeenCalled());
    expect(setPermissionsRulesMock).not.toHaveBeenCalled();
  });

  it("never writes a rule when the checkbox is unticked", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard approval={approval()} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(true));
    expect(setPermissionsRulesMock).not.toHaveBeenCalled();
  });

  it("never writes a rule on Deny even when ticked", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard approval={approval()} onResolve={onResolve} />);
    fireEvent.click(screen.getByLabelText(/always allow edit_file/i));
    fireEvent.click(screen.getByText("Deny"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(false));
    expect(setPermissionsRulesMock).not.toHaveBeenCalled();
  });

  it("resolves Allow even when the rule save fails", async () => {
    const onResolve = vi.fn();
    setPermissionsRulesMock.mockRejectedValue(new Error("db locked"));
    render(<ApprovalCard approval={approval()} onResolve={onResolve} />);
    fireEvent.click(screen.getByLabelText(/always allow edit_file/i));
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(true));
  });

  it("uses the dest path for move/copy cards", async () => {
    render(
      <ApprovalCard
        approval={approval({ tool: "move_file", args: { src: "C:/a/x.ts", dest: "C:/b/y.ts" } })}
        onResolve={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText(/always allow move_file/i));
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(setPermissionsRulesMock).toHaveBeenCalled());
    const saved = setPermissionsRulesMock.mock.calls[0][0] as ApprovalRule[];
    expect(saved[0].pattern).toBe("C:/b/**");
  });
});

describe("PermissionRulesPanel", () => {
  it("lists persisted rules and removes one", async () => {
    getPermissionsRulesMock.mockResolvedValue([
      rule(),
      rule({ id: "r2", tool: "delete_file", pattern: "**/dist/**" }),
    ]);
    render(<PermissionRulesPanel />);
    await waitFor(() =>
      expect(screen.getByText("**/dist/**")).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByTitle("Remove rule")[0]);
    await waitFor(() => expect(setPermissionsRulesMock).toHaveBeenCalled());
    const saved = setPermissionsRulesMock.mock.calls[0][0] as ApprovalRule[];
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("r2");
  });

  it("adds a rule from the tool select + pattern input", async () => {
    getPermissionsRulesMock.mockResolvedValue([]);
    render(<PermissionRulesPanel />);
    await waitFor(() =>
      expect(screen.getByText(/no approval rules yet/i)).toBeTruthy(),
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "delete_file" } });
    fireEvent.change(screen.getByPlaceholderText(/path glob/i), {
      target: { value: "**/dist/**" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() => expect(setPermissionsRulesMock).toHaveBeenCalled());
    const saved = setPermissionsRulesMock.mock.calls[0][0] as ApprovalRule[];
    expect(saved).toHaveLength(1);
    expect(saved[0].tool).toBe("delete_file");
    expect(saved[0].pattern).toBe("**/dist/**");
  });

  it("rejects an empty pattern", async () => {
    getPermissionsRulesMock.mockResolvedValue([]);
    render(<PermissionRulesPanel />);
    await waitFor(() => expect(getPermissionsRulesMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() =>
      expect(screen.getByText(/enter a path pattern/i)).toBeTruthy(),
    );
    expect(setPermissionsRulesMock).not.toHaveBeenCalled();
  });
});
