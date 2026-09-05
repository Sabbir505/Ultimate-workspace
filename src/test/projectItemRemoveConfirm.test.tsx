// C1 (ISSUES.md): the project row context menu's "Remove Project" deleted the
// project (and cascaded every chat nested under it) with NO confirmation —
// unlike the sidebar's own remove action, which gates on window.confirm. The
// context-menu path must run the same guard: confirm=false ⇒ the store action
// never fires; confirm=true ⇒ it fires with the project id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createWorktree: vi.fn(async () => null),
  listQuickActions: vi.fn(async () => []),
}));
vi.mock("../lib/sessionLauncher", () => ({
  newSessionFlow: vi.fn(async () => undefined),
  runQuickAction: vi.fn(async () => undefined),
}));

import { ProjectItem } from "../components/sidebar/ProjectItem";
import { useProjectsStore } from "../state/projects";
import type { Project } from "../types";

const PROJECT: Project = {
  id: "p1",
  name: "Demo",
  path: "D:/code/demo",
  isGitRepo: true,
  createdAt: 1,
  lastOpenedAt: null,
} as Project;

describe("ProjectItem — Remove Project confirmation (C1)", () => {
  let removeProjectById: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    removeProjectById = vi.fn(async () => undefined);
    useProjectsStore.setState({
      projects: [PROJECT],
      selectedProjectId: "p1",
      sessions: [],
      harnesses: [],
      expanded: {},
      gitStatuses: {},
      removeProjectById,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useProjectsStore.setState({ projects: [], selectedProjectId: null });
  });

  function openContextMenuAndClickRemove() {
    const { container } = render(<ProjectItem project={PROJECT} />);
    fireEvent.contextMenu(container.querySelector(".project-row")!);
    fireEvent.click(screen.getByText("Remove Project"));
  }

  it("does not remove when the confirm dialog is dismissed", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    openContextMenuAndClickRemove();
    expect(confirm).toHaveBeenCalledWith(
      `Remove project "Demo"?\n\nThis also deletes all chats nested under it. This cannot be undone.`,
    );
    expect(removeProjectById).not.toHaveBeenCalled();
  });

  it("removes after the confirm dialog is accepted", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    openContextMenuAndClickRemove();
    expect(removeProjectById).toHaveBeenCalledWith("p1");
  });
});
