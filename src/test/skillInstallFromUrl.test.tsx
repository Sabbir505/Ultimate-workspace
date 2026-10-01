// Tests for the Skills Library install-from-URL row (§4.3.4): the toolbar
// toggle reveals the input, installing hands the URL to the backend, a
// success refreshes the list (the new skill appears), and a failure toasts
// without clearing the input.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listInstalledSkills = vi.fn();
const installSkillFromUrl = vi.fn();
const toastError = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    listInstalledSkills: (...a: unknown[]) => listInstalledSkills(...a),
    listInstalledLoops: vi.fn().mockResolvedValue([]),
    readInstalledSkill: vi.fn().mockResolvedValue("body"),
    saveInstalledSkill: vi.fn().mockResolvedValue(undefined),
    createInstalledSkill: vi.fn().mockResolvedValue(null),
    deleteInstalledSkill: vi.fn().mockResolvedValue(undefined),
    makeInstalledGlobal: vi.fn().mockResolvedValue(0),
    installSkillFromUrl: (...a: unknown[]) => installSkillFromUrl(...a),
    toastError: (...a: unknown[]) => toastError(...a),
    listChatSkills: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../state/projects", () => ({
  useProjectsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ projects: [], harnesses: [] }),
}));
vi.mock("../state/skills", () => ({
  useSkillsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ skills: [], create: vi.fn(), update: vi.fn(), remove: vi.fn() }),
}));
vi.mock("../state/chat", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({}),
}));
vi.mock("../state/ui", () => ({
  useUiStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ pendingArtifactFormData: null, setPendingArtifactFormData: vi.fn(), closeOverlay: vi.fn() }),
}));

import { SkillsLibrary } from "../components/skills-library/SkillsLibrary";

const EXISTING = [
  {
    slug: "pdf-master",
    name: "pdf-master",
    description: "Merge and split PDFs.",
    source: "both",
    claudePath: "/tmp/.claude/skills/pdf-master/SKILL.md",
    kimiPath: null,
    kind: "skill",
    version: "1.4.2",
    allowedTools: "read_file, generate_file",
  },
];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  listInstalledSkills.mockResolvedValue(EXISTING.map((s) => ({ ...s })));
  toastError.mockReturnValue(undefined);
});

async function openInstallRow() {
  render(<SkillsLibrary />);
  // The library renders the installed list once the scan resolves.
  await screen.findByText("/pdf-master");
  fireEvent.click(screen.getByTitle(/Install from a URL/));
  return screen.findByTestId("install-url-row");
}

describe("skills install-from-URL", () => {
  it("installs from a URL and refreshes the list", async () => {
    installSkillFromUrl.mockResolvedValue({
      slug: "meeting-notes",
      name: "meeting-notes",
      description: "Turn raw notes into action items.",
      version: "0.3.0",
      allowedTools: null,
      filesInstalled: 1,
      sourceUrl: "https://example.com/SKILL.md",
      claudeDir: "/tmp/.claude/skills/meeting-notes",
    });
    // After install the panel reloads; the refreshed scan returns both skills.
    listInstalledSkills.mockResolvedValueOnce(EXISTING.map((s) => ({ ...s })));
    listInstalledSkills.mockResolvedValueOnce([
      ...EXISTING.map((s) => ({ ...s })),
      {
        slug: "meeting-notes",
        name: "meeting-notes",
        description: "Turn raw notes into action items.",
        source: "both",
        claudePath: "/tmp/.claude/skills/meeting-notes/SKILL.md",
        kimiPath: "/tmp/.agents/skills/meeting-notes/SKILL.md",
        kind: "skill",
        version: "0.3.0",
        allowedTools: null,
      },
    ]);

    await openInstallRow();
    const input = screen.getByPlaceholderText(/github\.com/);
    fireEvent.change(input, { target: { value: "https://github.com/acme/skills/tree/main/notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(installSkillFromUrl).toHaveBeenCalledWith(
        "https://github.com/acme/skills/tree/main/notes",
        "skill"
      );
    });
    await screen.findByText("/meeting-notes");
    // The metadata layer surfaces without opening the body.
    expect(screen.getByText("v0.3.0")).toBeTruthy();
  });

  it("a failed install toasts and keeps the row for a retry", async () => {
    installSkillFromUrl.mockRejectedValue("No SKILL.md in that directory");
    await openInstallRow();
    const input = screen.getByPlaceholderText(/github\.com/);
    fireEvent.change(input, { target: { value: "https://github.com/acme/skills/tree/main/nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't install from that URL",
        "No SKILL.md in that directory"
      );
    });
    // The row stays open with the URL intact for a retry.
    expect((screen.getByPlaceholderText(/github\.com/) as HTMLInputElement).value).toBe(
      "https://github.com/acme/skills/tree/main/nope"
    );
    expect(screen.getByText("/pdf-master")).toBeTruthy();
  });
});
