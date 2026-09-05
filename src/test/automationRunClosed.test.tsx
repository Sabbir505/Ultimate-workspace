// Tests for the "Run while closed" toggle, the automation notification
// settings popover, and the run-finished event listener (toast on failure
// only, store refresh on every event).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getRunWhileClosedMock = vi.fn();
const setRunWhileClosedMock = vi.fn();
const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const testWebhookMock = vi.fn();
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
let runFinishedHandler: ((p: {
  automationId: string;
  name: string;
  status: string;
  summary: string;
  chatSessionId: string;
  finishedAt: number;
}) => void) | null = null;

vi.mock("../lib/ipc", () => ({
  getRunWhileClosed: () => getRunWhileClosedMock(),
  setRunWhileClosed: (enabled: boolean) => setRunWhileClosedMock(enabled),
  getSetting: (key: string) => getSettingMock(key),
  setSetting: (key: string, value: string) => setSettingMock(key, value),
  testAutomationWebhook: () => testWebhookMock(),
  toastError: (...a: unknown[]) => toastErrorMock(...a),
  toastSuccess: (...a: unknown[]) => toastSuccessMock(...a),
  listenAutomationRunFinished: (handler: never) => {
    runFinishedHandler = handler;
    return Promise.resolve(() => {});
  },
  listenAutomationRunStarted: () => Promise.resolve(() => {}),
  // Imported by AutomationsView but not exercised here — stubs so the
  // module's named imports resolve against the mock.
  listAutomationRuns: vi.fn().mockResolvedValue([]),
  listChatModels: vi.fn().mockResolvedValue([]),
  scanLocalModels: vi.fn().mockResolvedValue([]),
  listHarnessModels: vi.fn().mockResolvedValue([]),
}));

const osNotifyMock = vi.fn();
vi.mock("../lib/notify", () => ({ osNotify: (...a: unknown[]) => osNotifyMock(...a) }));
const chimeMock = vi.fn();
vi.mock("../lib/sound", () => ({ playNotifyChime: () => chimeMock() }));

const loadMock = vi.fn();
vi.mock("../state/automations", () => ({
  useAutomationsStore: { getState: () => ({ loaded: true, load: loadMock }) },
}));
const settingsState = { dnd: false, notifySound: false };
vi.mock("../state/settings", () => ({
  useSettingsStore: { getState: () => settingsState },
}));

// AutomationsView imports lazily/heavily — we only exercise the two header
// controls it exports, but the module's other imports still need to resolve.
vi.mock("../state/projects", () => ({ useProjectsStore: (sel: (s: object) => unknown) => sel({}) }));
vi.mock("../state/ui", () => ({ useUiStore: (sel: (s: object) => unknown) => sel({}) }));
vi.mock("../state/chat", () => ({
  useChatStore: Object.assign((sel: (s: object) => unknown) => sel({}), {
    // The run-finished handler releases the run's streaming entry through
    // the real chat store; stub it here (this file tests notification UX).
    getState: () => ({
      beginRemoteTurn: () => {},
      endRemoteTurn: () => Promise.resolve(),
    }),
  }),
}));

import {
  NotifySettingsButton,
  RunWhileClosedToggle,
} from "../components/automations/AutomationsView";
import { useAutomationEvents } from "../hooks/useAutomationEvents";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  runFinishedHandler = null;
  settingsState.dnd = false;
  settingsState.notifySound = false;
  getRunWhileClosedMock.mockResolvedValue(false);
  setRunWhileClosedMock.mockResolvedValue(undefined);
  getSettingMock.mockResolvedValue(null);
  setSettingMock.mockResolvedValue(undefined);
  testWebhookMock.mockResolvedValue(undefined);
});

describe("RunWhileClosedToggle", () => {
  it("renders off, then registers the task when clicked", async () => {
    render(<RunWhileClosedToggle />);
    const box = await screen.findByLabelText("Run while closed");
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(setRunWhileClosedMock).toHaveBeenCalledWith(true));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
  });

  it("unregisters when clicked while on (no success toast)", async () => {
    getRunWhileClosedMock.mockResolvedValue(true);
    render(<RunWhileClosedToggle />);
    const box = await screen.findByLabelText("Run while closed");
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(setRunWhileClosedMock).toHaveBeenCalledWith(false));
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("surfaces backend errors as toasts and keeps the old state", async () => {
    setRunWhileClosedMock.mockRejectedValue(new Error("not supported on this platform yet"));
    render(<RunWhileClosedToggle />);
    const box = await screen.findByLabelText("Run while closed");
    fireEvent.click(box);
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect((box as HTMLInputElement).checked).toBe(false);
  });
});

describe("NotifySettingsButton", () => {
  it("loads + saves the webhook URL and the email toggle", async () => {
    getSettingMock.mockImplementation((key: string) =>
      Promise.resolve(key === "automations.webhookUrl" ? "https://hook.example/x" : "false"),
    );
    render(<NotifySettingsButton />);
    fireEvent.click(screen.getByLabelText("Automation notifications"));
    const input = await screen.findByPlaceholderText("https://hooks.slack.com/…");
    expect((input as HTMLInputElement).value).toBe("https://hook.example/x");

    fireEvent.change(input, { target: { value: "https://hook.example/y" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(setSettingMock).toHaveBeenCalledWith("automations.webhookUrl", "https://hook.example/y"),
    );

    const emailBox = screen.getByLabelText(/Email me on failure/);
    expect((emailBox as HTMLInputElement).checked).toBe(false); // "false" from settings
    fireEvent.click(emailBox);
    await waitFor(() =>
      expect(setSettingMock).toHaveBeenCalledWith("automations.emailOnFailure", "true"),
    );
  });

  it("test button calls the backend test hook", async () => {
    getSettingMock.mockImplementation((key: string) =>
      Promise.resolve(key === "automations.webhookUrl" ? "https://hook.example/x" : null),
    );
    render(<NotifySettingsButton />);
    fireEvent.click(screen.getByLabelText("Automation notifications"));
    const btn = await screen.findByText("Send test");
    fireEvent.click(btn);
    await waitFor(() => expect(testWebhookMock).toHaveBeenCalled());
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Test notification sent"));
  });

  it("test button is disabled without a webhook URL", async () => {
    render(<NotifySettingsButton />);
    fireEvent.click(screen.getByLabelText("Automation notifications"));
    const btn = await screen.findByText("Send test");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("useAutomationEvents", () => {
  function Probe() {
    useAutomationEvents();
    return null;
  }

  const payload = (status: string) => ({
    automationId: "a1",
    name: "nightly",
    status,
    summary: status === "ok" ? "Completed" : "provider exploded",
    chatSessionId: "c1",
    finishedAt: 123,
  });

  it("toasts on failure but not on success or skipped", async () => {
    render(<Probe />);
    await waitFor(() => expect(runFinishedHandler).not.toBeNull());
    runFinishedHandler!(payload("ok"));
    runFinishedHandler!(payload("skipped"));
    expect(osNotifyMock).not.toHaveBeenCalled();
    runFinishedHandler!(payload("provider exploded"));
    expect(osNotifyMock).toHaveBeenCalledWith(
      "Relay automation failed",
      "nightly: provider exploded",
    );
    // Every event refreshes the store.
    expect(loadMock).toHaveBeenCalledTimes(3);
  });

  it("respects Do Not Disturb for the toast but still refreshes", async () => {
    settingsState.dnd = true;
    render(<Probe />);
    await waitFor(() => expect(runFinishedHandler).not.toBeNull());
    runFinishedHandler!(payload("provider exploded"));
    expect(osNotifyMock).not.toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalled();
  });

  it("plays the chime on failure when notifySound is on", async () => {
    settingsState.notifySound = true;
    render(<Probe />);
    await waitFor(() => expect(runFinishedHandler).not.toBeNull());
    runFinishedHandler!(payload("provider exploded"));
    expect(chimeMock).toHaveBeenCalled();
  });
});
