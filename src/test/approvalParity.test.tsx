// Approval-parity UI (gap §4.5.4 / §5.24):
//   1. Every harness with a NATIVE per-call permission model has a catalog
//      entry in HARNESS_PERMISSION_MODES (kimi yolo/auto/plan, omp
//      always-ask/write/yolo, commandcode standard/plan/accept-edits/yolo/
//      dont-ask) — the composer menu renders it verbatim and the mode hint
//      names the pane-start application + the cards gap.
//   2. Harnesses WITHOUT one (pi, ACP) render the explicit "in-pane
//      approvals" gap note in the composer instead of a silently missing
//      menu.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { ChatComposer } from "../components/chat/ChatComposer";
import { PermissionModeMenu } from "../components/chat/PermissionModeMenu";
import { HARNESS_PERMISSION_MODES } from "../state/chat/moduleState";
import { paneCache, paneInFlight } from "../components/chat/agentPickerShared";

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    listHarnesses: vi.fn().mockResolvedValue([]),
    listAcpAgents: vi.fn().mockResolvedValue([]),
    listHarnessModels: vi.fn().mockResolvedValue(null),
    listChatModels: vi.fn().mockResolvedValue([]),
    scanLocalModels: vi.fn().mockResolvedValue([]),
    getChatConfig: vi.fn().mockResolvedValue(null),
  };
});

const TRIGGER = "Approval mode (files + connected accounts)";

beforeEach(() => {
  vi.clearAllMocks();
  paneCache.clear();
  paneInFlight.clear();
});
afterEach(cleanup);

describe("native permission catalogs", () => {
  it("covers every harness that ships a native per-call model", () => {
    // Values are the CLIs' own vocabulary — the adapters' permission_flags
    // (Rust, tested there) map them to spawn flags 1:1.
    const values = (id: string) => (HARNESS_PERMISSION_MODES[id] ?? []).map((m) => m.value);
    expect(values("claude_code")).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(values("opencode")).toEqual(["build", "plan"]);
    expect(values("kimi_code")).toEqual(["manual", "yolo", "auto", "plan"]);
    expect(values("omp")).toEqual(["always-ask", "write", "yolo"]);
    expect(values("commandcode")).toEqual(["standard", "plan", "accept-edits", "yolo", "dont-ask"]);
    // No native per-call model → deliberately NO entry (the composer flags
    // the gap instead of showing a menu).
    expect(HARNESS_PERMISSION_MODES["pi"]).toBeUndefined();
  });

  it("renders the omp catalog verbatim with the pane-start hint", () => {
    const { getByTitle, container } = render(
      <PermissionModeMenu mode="always-ask" onModeChange={() => {}} modes={HARNESS_PERMISSION_MODES.omp} />,
    );
    fireEvent.click(getByTitle(TRIGGER));
    const popup = container.querySelector(".permission-mode-popup") as HTMLElement;
    for (const label of ["Always ask", "Auto writes", "Yolo"]) {
      expect(popup.textContent).toContain(label);
    }
    expect(popup.textContent).toContain("applied when the pane starts");
    expect(popup.textContent).toContain("approval cards relay into built-in chat only");
  });

  it("renders the commandcode catalog with dont-ask", () => {
    const { getByTitle, container } = render(
      <PermissionModeMenu mode="standard" onModeChange={() => {}} modes={HARNESS_PERMISSION_MODES.commandcode} />,
    );
    fireEvent.click(getByTitle(TRIGGER));
    const popup = container.querySelector(".permission-mode-popup") as HTMLElement;
    for (const label of ["Standard", "Accept edits", "Don't ask"]) {
      expect(popup.textContent).toContain(label);
    }
  });
});

describe("composer gap note for harnesses without a native model", () => {
  const renderComposer = (props: Record<string, unknown>) =>
    render(
      <ChatComposer
        sessionId="s1"
        onSend={() => {}}
        streaming={false}
        onAgentModelPick={() => {}}
        {...props}
      />,
    );

  it("shows the in-pane approvals chip for pi sessions", async () => {
    const { container } = renderComposer({
      agent: "harness:pi",
      permissionMode: "manual",
      permissionModeSupported: false,
      permissionModeNote:
        "Pi has no per-call approval model Relay can drive — its only lever is the project-trust gate (--approve), and its print modes auto-approve tool calls. Approvals stay inside pi's own TUI; Relay approval cards don't relay into it.",
    });
    await waitFor(() => {
      expect(screen.getByTestId("permission-mode-gap-note")).toBeTruthy();
    });
    const note = screen.getByTestId("permission-mode-gap-note");
    expect(note.textContent).toContain("in-pane approvals");
    expect(note.getAttribute("title")).toContain("project-trust gate");
    // …and the mode menu itself stays hidden.
    expect(container.querySelector(".permission-mode-menu")).toBeNull();
  });

  it("shows the note for ACP sessions (no permission channel in v1)", async () => {
    renderComposer({
      agent: "acp:zed",
      permissionMode: "manual",
      permissionModeSupported: false,
      permissionModeNote: "ACP v1 has no permission channel.",
    });
    await waitFor(() => {
      expect(screen.getByTestId("permission-mode-gap-note")).toBeTruthy();
    });
  });

  it("renders no note when the harness has a catalog (menu instead)", () => {
    const { container, queryByTestId } = renderComposer({
      agent: "harness:commandcode",
      permissionMode: "standard",
      permissionModeSupported: true,
      onPermissionModeChange: () => {},
      modes: HARNESS_PERMISSION_MODES.commandcode,
    });
    expect(container.querySelector(".permission-mode-menu")).toBeTruthy();
    expect(queryByTestId("permission-mode-gap-note")).toBeNull();
  });
});
