// Tests for the packaged automation templates (§4.2.7): the template chips
// render in the Automations empty state, picking one hands the template to
// the standard form via the pendingArtifactFormData channel, and the form
// honors the template's EXACT run prompt instead of compiling a Goal/steps
// scaffold over it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockTemplates = [
  {
    id: "pr-review-bot",
    name: "PR review bot",
    description: "Reviews open PRs on a schedule.",
    harness: "claude_code",
    model: null,
    schedule: "0 9 * * 1-5",
    prompt: "Review the open pull requests.\n\n1. Enumerate: gh pr list …\n[relay-review] marker rules.",
  },
  {
    id: "repo-morning-digest",
    name: "Repo morning digest",
    description: "Overnight repo activity, summarized.",
    harness: "claude_code",
    model: null,
    schedule: "0 8 * * 1-5",
    prompt: "Summarize the last 24 hours of activity in this repository.",
  },
];

const listAutomationTemplates = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    listAutomationTemplates: (...a: unknown[]) => listAutomationTemplates(...a),
    automationNextFire: vi.fn().mockResolvedValue({ at: null, label: "" }),
    automationWebhookInfo: vi.fn().mockResolvedValue({ url: "", secret: "" }),
    isSubagentAutomation: (harness: string) => /^agent:[^\s]+/.test(harness),
    listAutomationRuns: vi.fn().mockResolvedValue([]),
    listChatModels: vi.fn().mockResolvedValue([]),
    scanLocalModels: vi.fn().mockResolvedValue([]),
    listHarnessModels: vi.fn().mockResolvedValue({ models: [] }),
    installHarness: vi.fn(),
    getRunWhileClosed: vi.fn().mockResolvedValue(false),
    setRunWhileClosed: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn(),
    testAutomationWebhook: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    listenAutomationRunFinished: vi.fn().mockResolvedValue(() => {}),
    listenAutomationRunStarted: vi.fn().mockResolvedValue(() => {}),
  };
});

// The ui store mock carries a MUTABLE pendingArtifactFormData so a test can
// stage a template hand-off before render (the form consumes it on mount).
const uiState = {
  pendingArtifactFormData: null as
    | { artifactType: string; spec: unknown; chatSessionId?: string; proposalId?: string }
    | null,
  setPendingArtifactFormData: vi.fn(),
  setActiveView: vi.fn(),
};

vi.mock("../state/ui", () => ({
  useUiStore: (sel: (s: unknown) => unknown) => sel(uiState),
}));
vi.mock("../state/automations", () => ({
  useAutomationsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      loaded: true,
      automations: [],
      runningNow: {},
      stoppingNow: {},
      load: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      setEnabled: vi.fn(),
      runNow: vi.fn(),
      stopRun: vi.fn(),
    }),
}));
vi.mock("../state/projects", () => ({
  useProjectsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ projects: [], harnesses: [] }),
}));
vi.mock("../state/settings", () => ({
  useSettingsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ loaded: true }),
}));
vi.mock("../state/chat", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({}),
}));
vi.mock("../state/subagents", () => ({
  useSubagentStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ agents: [], loaded: true, load: vi.fn() }),
}));

import { AutomationsView } from "../components/automations/AutomationsView";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  uiState.pendingArtifactFormData = null;
  listAutomationTemplates.mockResolvedValue(mockTemplates);
});

describe("automation templates (PR review bot)", () => {
  it("renders the packaged template chips in the empty state", async () => {
    render(<AutomationsView />);
    const row = await screen.findByTestId("automation-templates");
    expect(row).toBeTruthy();
    expect(await screen.findByText("PR review bot")).toBeTruthy();
    expect(screen.getByText("Repo morning digest")).toBeTruthy();
  });

  it("hands the clicked template to the standard form channel", async () => {
    render(<AutomationsView />);
    fireEvent.click(await screen.findByText("PR review bot"));
    await waitFor(() => {
      expect(uiState.setPendingArtifactFormData).toHaveBeenCalledTimes(1);
    });
    const payload = uiState.setPendingArtifactFormData.mock.calls[0][0];
    expect(payload.artifactType).toBe("automation");
    expect(payload.spec).toMatchObject({
      name: "PR review bot",
      harness: "claude_code",
      trigger: { schedule: "0 9 * * 1-5" },
    });
    expect(String(payload.spec.prompt)).toContain("[relay-review]");
  });

  it("the form applies a template's EXACT prompt, not a compiled scaffold", async () => {
    uiState.pendingArtifactFormData = {
      artifactType: "automation",
      spec: {
        name: "PR review bot",
        prompt: mockTemplates[0].prompt,
        harness: "claude_code",
        trigger: { schedule: "0 9 * * 1-5" },
      },
    };
    render(<AutomationsView />);
    // The pending payload opens the form; the prompt textarea must carry the
    // packaged text verbatim — buildAutomationRunPrompt would have wrapped it
    // in "Goal: " + "Complete each step in order:".
    const promptBox = await screen.findByPlaceholderText(/Run the test suite/);
    expect((promptBox as HTMLTextAreaElement).value).toBe(mockTemplates[0].prompt);
    const nameBox = screen.getByPlaceholderText("Nightly test fix") as HTMLInputElement;
    expect(nameBox.value).toBe("PR review bot");
  });
});
