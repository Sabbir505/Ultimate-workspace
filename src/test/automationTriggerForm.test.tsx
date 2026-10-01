// Tests for the AutomationsView trigger-type UI: the Trigger selector in the
// create/edit form, the per-type conditional fields (file path, git repo,
// gmail label), the triggerType/triggerConfig payloads the form saves (the
// same camelCase shapes automation_triggers::validate_trigger parses), and
// the webhook trigger URL surfacing (form after create + detail pane).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Automation, AutomationInput } from "../lib/ipc";

// Top-level arrays/fns referenced from the vi.mock factories below are read
// lazily (inside selector calls / test bodies), so plain consts are safe.
const storeAutomations: Automation[] = [];

const mockNextFire = vi.fn();
const mockWebhookInfo = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock("../lib/ipc", () => ({
  automationNextFire: (...a: unknown[]) => mockNextFire(...a),
  automationWebhookInfo: (id: string) => mockWebhookInfo(id),
  isSubagentAutomation: (harness: string) => /^agent:[^\s]+/.test(harness),
  listAutomationTemplates: vi.fn().mockResolvedValue([]),
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
}));

vi.mock("../state/automations", () => ({
  useAutomationsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      loaded: true,
      automations: storeAutomations,
      runningNow: {},
      stoppingNow: {},
      load: vi.fn(),
      create: mockCreate,
      update: mockUpdate,
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
vi.mock("../state/ui", () => ({
  useUiStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ pendingArtifactFormData: null, setPendingArtifactFormData: vi.fn(), setActiveView: vi.fn() }),
}));
vi.mock("../state/chat", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({}),
}));

import { AutomationsView } from "../components/automations/AutomationsView";

const WEBHOOK_URL = "http://127.0.0.1:9/trigger/a1/s3cret";

function mkAutomation(partial: Partial<Automation>): Automation {
  return {
    id: "a1",
    name: "nightly",
    prompt: "p",
    harness: "claude_code",
    model: "",
    cwd: "",
    schedule: "",
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    chatSessionId: null,
    createdAt: 0,
    origin: "user",
    triggerType: "cron",
    triggerConfig: "{}",
    lastTriggerState: null,
    lastEventRunAt: null,
    ...partial,
  };
}

/** Renders the view and opens the blank create form (the empty state shows
 *  "Create your first automation" until the list has rows; afterwards the
 *  list pane's "New" button takes over). */
async function openNewForm() {
  render(<AutomationsView />);
  const createFirst = screen.queryByRole("button", { name: /Create your first automation/ });
  fireEvent.click(createFirst ?? (await screen.findByRole("button", { name: "New" })));
  await screen.findByText("New automation");
}

function fillNameAndPrompt() {
  fireEvent.change(screen.getByPlaceholderText("Nightly test fix"), {
    target: { value: "Triggered automation" },
  });
  fireEvent.change(screen.getByPlaceholderText(/Run the test suite/), {
    target: { value: "Do the thing." },
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeAutomations.length = 0;
  mockNextFire.mockResolvedValue({ at: null, label: "" });
  mockWebhookInfo.mockResolvedValue({ url: WEBHOOK_URL, secret: "s3cret" });
  mockCreate.mockResolvedValue(mkAutomation({ id: "new-1" }));
  mockUpdate.mockResolvedValue(undefined);
});

describe("AutomationForm trigger selector", () => {
  it("renders the Trigger selector with all five engines, cron default", async () => {
    await openNewForm();
    const select = screen.getByLabelText("Trigger type") as HTMLSelectElement;
    expect(select.value).toBe("cron");
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "cron", "webhook", "file", "git", "gmail",
    ]);
    // Cron (the default) shows the existing schedule builder.
    expect(screen.getByText("Schedule")).toBeTruthy();
  });

  it("switching to a file trigger shows the path field and hides the cron builder", async () => {
    await openNewForm();
    fireEvent.change(screen.getByLabelText("Trigger type"), { target: { value: "file" } });
    expect(screen.getByLabelText("Folder to watch")).toBeTruthy();
    expect(screen.queryByText("Schedule")).toBeNull();
    // Switching back restores the builder — other fields stay intact.
    fireEvent.change(screen.getByLabelText("Trigger type"), { target: { value: "cron" } });
    expect(screen.getByText("Schedule")).toBeTruthy();
  });

  it("saving a file trigger sends triggerType + the {path, minIntervalSecs} config", async () => {
    await openNewForm();
    fireEvent.change(screen.getByLabelText("Trigger type"), { target: { value: "file" } });
    fillNameAndPrompt();
    fireEvent.change(screen.getByLabelText("Folder to watch"), {
      target: { value: "D:/tmp/dist" },
    });
    fireEvent.change(screen.getByLabelText("Min re-fire seconds"), {
      target: { value: "30" },
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Create automation" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const input = mockCreate.mock.calls[0][0] as AutomationInput;
    expect(input.triggerType).toBe("file");
    expect(JSON.parse(input.triggerConfig ?? "{}")).toEqual({
      path: "D:/tmp/dist",
      minIntervalSecs: 30,
    });
  });

  it("a file trigger without a path stays unsavable", async () => {
    await openNewForm();
    fireEvent.change(screen.getByLabelText("Trigger type"), { target: { value: "file" } });
    fillNameAndPrompt();
    expect((screen.getByRole("button", { name: "Create automation" }) as HTMLButtonElement).disabled).toBe(true);
    // Typing the path enables it.
    fireEvent.change(screen.getByLabelText("Folder to watch"), { target: { value: "D:/tmp" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Create automation" }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("a gmail trigger defaults the label to inbox and saves it into the config", async () => {
    await openNewForm();
    fireEvent.change(screen.getByLabelText("Trigger type"), { target: { value: "gmail" } });
    expect(screen.getByText(/requires the Gmail connector/)).toBeTruthy();
    const label = screen.getByLabelText("Gmail label") as HTMLInputElement;
    expect(label.value).toBe("inbox");
    fillNameAndPrompt();
    fireEvent.change(label, { target: { value: "newsletters" } });
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const input = mockCreate.mock.calls[0][0] as AutomationInput;
    expect(input.triggerType).toBe("gmail");
    expect(JSON.parse(input.triggerConfig ?? "{}")).toEqual({ label: "newsletters" });
  });

  it("creating a webhook automation keeps the form open and surfaces the trigger URL", async () => {
    await openNewForm();
    fireEvent.change(screen.getByLabelText("Trigger type"), { target: { value: "webhook" } });
    fillNameAndPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    // The form stays open; the trigger URL (from the dedicated getter —
    // list/get redact the secret) is rendered with a copy hint.
    expect(await screen.findByText("Trigger URL")).toBeTruthy();
    expect(await screen.findByText(WEBHOOK_URL)).toBeTruthy();
    expect(mockWebhookInfo).toHaveBeenCalledWith("new-1");
    expect(screen.getByText("Works while Relay is running.")).toBeTruthy();
    // "Done" finishes: hands the id to the parent (selecting the new row).
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("editing loads the stored trigger type/config into the form", async () => {
    storeAutomations.push(
      mkAutomation({
        triggerType: "git",
        triggerConfig: JSON.stringify({ cwd: "D:/repo", branch: "main" }),
      }),
    );
    render(<AutomationsView />);
    fireEvent.click((await screen.findAllByText("nightly"))[0]);
    fireEvent.click(screen.getByTitle("Edit"));
    await screen.findByText("Edit automation");
    expect((screen.getByLabelText("Trigger type") as HTMLSelectElement).value).toBe("git");
    expect((screen.getByLabelText("Repository folder") as HTMLInputElement).value).toBe("D:/repo");
    expect((screen.getByLabelText("Git branch") as HTMLInputElement).value).toBe("main");
    // Save maps the form state back to the ipc input shapes.
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    const [id, input] = mockUpdate.mock.calls[0] as [string, AutomationInput];
    expect(id).toBe("a1");
    expect(input.triggerType).toBe("git");
    expect(JSON.parse(input.triggerConfig ?? "{}")).toEqual({ cwd: "D:/repo", branch: "main" });
  });
});

describe("AutomationDetail trigger surfaces", () => {
  it("a webhook row fetches automationWebhookInfo and shows the copyable URL", async () => {
    storeAutomations.push(mkAutomation({ triggerType: "webhook", triggerConfig: "{}" }));
    render(<AutomationsView />);
    await screen.findByText("Webhook URL");
    await screen.findByText(WEBHOOK_URL);
    expect(mockWebhookInfo).toHaveBeenCalledWith("a1");
  });

  it("an event row is badged by engine instead of the (empty) cron label", async () => {
    storeAutomations.push(mkAutomation({ triggerType: "gmail", triggerConfig: "{}" }));
    render(<AutomationsView />);
    await screen.findAllByText("nightly");
    expect(screen.getByText("email")).toBeTruthy();
    // Detail card describes the engine; the empty cron string renders nothing.
    expect(screen.getByText(/New email — inbox/)).toBeTruthy();
  });
});
