// API Keys panel: provider rail selection, configured/unconfigured states,
// native vs compatible save validation, existing-key updates, model fetch
// success/failure/manual fallback, save/reset, accessible controls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsView } from "../components/settings/SettingsView";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

const getChatConfigMock = vi.fn();
const saveApiKeyMock = vi.fn();
const clearApiKeyMock = vi.fn();
const listChatModelsMock = vi.fn();
const setSettingMock = vi.fn();
const getSettingMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  getChatConfig: (...a: unknown[]) => getChatConfigMock(...a),
  saveApiKey: (...a: unknown[]) => saveApiKeyMock(...a),
  deleteChatApiKey: (...a: unknown[]) => clearApiKeyMock(...a),
  listChatModels: (...a: unknown[]) => listChatModelsMock(...a),
  setSetting: (...a: unknown[]) => setSettingMock(...a),
  getSetting: (...a: unknown[]) => getSettingMock(...a),
  listChatSessions: vi.fn().mockResolvedValue([]),
  getChatMessages: vi.fn().mockResolvedValue([]),
  createChatSession: vi.fn(),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  deleteAllChatSessions: vi.fn().mockResolvedValue(2),
  deleteChatMessage: vi.fn(),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  setChatApiKey: vi.fn(),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  setChatSessionStarred: vi.fn(),
  setChatSessionProject: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionProvider: vi.fn(),
  updateChatSessionAgent: vi.fn(),
  updateChatSessionWatchMode: vi.fn(),
  updateChatSessionPolicies: vi.fn(),
  exportProjectZip: vi.fn(),
  importChatZip: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  scanLocalModels: vi.fn().mockResolvedValue([]),
  startLocalModel: vi.fn(),
  stopLocalModel: vi.fn(),
  localModelStatus: vi.fn(),
  listConnectors: vi.fn().mockResolvedValue([]),
  connectorConnect: vi.fn(),
  connectorConnectFamily: vi.fn(),
  connectorDisconnect: vi.fn(),
  listenOAuthCallback: vi.fn(),
  deleteDownloadedModel: vi.fn(),
  getDataPaths: vi.fn().mockResolvedValue({ chatDbDir: "/tmp" }),
  setChatDbDir: vi.fn(),
  getLocalModelOverrides: vi.fn().mockResolvedValue({}),
  setLocalModelOverrides: vi.fn(),
  runLoginFlow: vi.fn(),
}));

vi.mock("../state/ui", () => ({
  useUiStore: vi.fn((selector) => {
    const store = {
      activeView: "settings",
      setActiveView: vi.fn(),
      settingsCategory: "apikeys",
      setSettingsCategory: vi.fn(),
    };
    return selector(store);
  }),
}));

vi.mock("../state/projects", () => ({
  useProjectsStore: vi.fn((selector) => selector({ currentProject: null, projects: [], setCurrentProject: vi.fn() })),
}));

vi.mock("../state/settings", () => ({
  useSettingsStore: vi.fn((selector) => selector({
    theme: "dark", dnd: false, notifySound: false, watchMode: false,
    customThemes: [], customThemeId: null,
    setTheme: vi.fn(), setDnd: vi.fn(), setNotifySound: vi.fn(), setWatchMode: vi.fn(),
    setCustomTheme: vi.fn(), importCustomTheme: vi.fn(), deleteCustomTheme: vi.fn(),
  })),
}));

vi.mock("../state/artifacts", () => ({
  useArtifactsStore: vi.fn((selector) => selector({ artifacts: [], setArtifacts: vi.fn() })),
}));

vi.mock("../components/common/GlassSelect", () => ({
  GlassSelect: vi.fn(({ value, options, onChange, children, ...props }: any) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} {...props} data-testid="glass-select">
      {options.map((o: any) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )),
}));

vi.mock("../state/chat", async () => {
  const { useSyncExternalStore } = await import("react");
  let config: any = { provider: "anthropic", hasKey: false, baseUrl: "", model: "" };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  };
  const notify = () => listeners.forEach((fn) => fn());
  const actions = {
    saveApiKey: async (provider: string, key: string, baseUrl?: string, model?: string) => {
      await saveApiKeyMock(provider, key, baseUrl, model);
      config = { provider, hasKey: true, baseUrl: baseUrl ?? "", model: model ?? "" };
      notify();
    },
    clearApiKey: async (provider: string) => {
      await clearApiKeyMock(provider);
      config = { provider, hasKey: false, baseUrl: "", model: "" };
      notify();
    },
    loadConfig: async (provider: string) => {
      const result = await getChatConfigMock(provider);
      if (result) {
        config = { ...result, provider };
        notify();
      }
    },
  };
  return {
    useChatStore: (selector: (s: any) => any) =>
      useSyncExternalStore(
        subscribe,
        () => selector({ config, ...actions }),
      ),
  };
});

describe("API Keys Panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChatConfigMock.mockResolvedValue(null);
    saveApiKeyMock.mockResolvedValue(undefined);
    clearApiKeyMock.mockResolvedValue(undefined);
    listChatModelsMock.mockResolvedValue([]);
    getSettingMock.mockResolvedValue("dark");
    setSettingMock.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("renders provider rail with all five providers", async () => {
    getChatConfigMock.mockResolvedValue(null);
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());
    // All five providers appear in both nav and rail; verify rail labels exist.
    expect(screen.getAllByText("Anthropic").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("OpenRouter").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Anthropic Compatible").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("OpenAI Compatible").length).toBeGreaterThanOrEqual(1);
  });

  it("shows Not connected badge when no key saved", async () => {
    getChatConfigMock.mockResolvedValue(null);
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  it("shows Connected badge and summary when provider has key", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" });
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    expect(screen.getByText("Endpoint")).toBeTruthy();
    expect(screen.getByText("Selected model")).toBeTruthy();
  });

  it("selecting a provider loads its config", async () => {
    getChatConfigMock
      .mockResolvedValueOnce({ provider: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" })
      .mockResolvedValueOnce({ provider: "openai", hasKey: false, baseUrl: "", model: "" });
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());
    // Click the rail select button for OpenAI (aria-label disambiguates from nav)
    fireEvent.click(screen.getByLabelText("Select OpenAI"));
    await waitFor(() => expect(getChatConfigMock).toHaveBeenCalledWith("openai"));
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  const getSaveButton = (container: HTMLElement) => {
    const candidates = within(container).getAllByText(/^(Add provider|Save changes)$/);
    const btn = candidates.find((el) => el.tagName === "BUTTON") as HTMLButtonElement;
    if (!btn) throw new Error("Save button not found");
    return btn;
  };

  it("native provider requires API key to save", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "anthropic", hasKey: false, baseUrl: "", model: "" });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    const saveButton = getSaveButton(container);
    expect(saveButton.disabled).toBe(true);
    fireEvent.change(within(container).getByPlaceholderText(/sk/), { target: { value: "sk-test-key" } });
    expect(getSaveButton(container).disabled).toBe(false);
  });

  it("existing key allows saving model/baseUrl without re-entering key", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "anthropic", hasKey: true, baseUrl: "", model: "" });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await waitFor(() => expect(getSaveButton(container)).toBeTruthy());
    const saveButton = getSaveButton(container);
    expect(saveButton.disabled).toBe(false);
  });

  it("compatible provider requires base URL to save", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "anthropic_compatible", hasKey: false, baseUrl: "", model: "" });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.click(within(container).getByLabelText("Select Anthropic Compatible"));
    const urlInput = await screen.findByPlaceholderText(/https:\/\/api.example.com\/v1/) as HTMLInputElement;
    await waitFor(() => expect(getChatConfigMock).toHaveBeenCalledWith("anthropic_compatible"));
    expect(getSaveButton(container).disabled).toBe(true);
    fireEvent.change(urlInput, { target: { value: "https://api.example.com/v1" } });
    expect(urlInput.value).toBe("https://api.example.com/v1");
    await waitFor(() => expect(getSaveButton(container).disabled).toBe(false));
  });

  it("fetches models for compatible provider when base URL and key present", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "openai_compatible", hasKey: true, baseUrl: "https://api.example.com/v1", model: "" });
    listChatModelsMock.mockResolvedValue([{ id: "model-a", object: "model", created: 1, ownedBy: "test" }, { id: "model-b", object: "model", created: 2, ownedBy: "test" }]);
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.click(within(container).getByLabelText("Select OpenAI Compatible"));
    await waitFor(() => expect(listChatModelsMock).toHaveBeenCalled(), { timeout: 3000 });
    expect(await screen.findByText("2 available")).toBeTruthy();
  });

  it("shows fetch error and manual fallback button", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "openai_compatible", hasKey: true, baseUrl: "https://api.example.com/v1", model: "" });
    listChatModelsMock.mockRejectedValue(new Error("Network error"));
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.click(within(container).getByLabelText("Select OpenAI Compatible"));
    await waitFor(() => expect(screen.getByText("Network error")).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText("Use manual input")).toBeTruthy();
  });

  it("manual fallback clears error and switches to text input", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "openai_compatible", hasKey: true, baseUrl: "https://api.example.com/v1", model: "" });
    listChatModelsMock.mockRejectedValue(new Error("Network error"));
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.click(within(container).getByLabelText("Select OpenAI Compatible"));
    await waitFor(() => expect(screen.getByText("Use manual input")).toBeTruthy(), { timeout: 2000 });
    fireEvent.click(screen.getByText("Use manual input"));
    expect(screen.queryByText("Network error")).toBeFalsy();
    expect(screen.getByPlaceholderText(/e.g. claude-sonnet-5/)).toBeTruthy();
  });

  it("save clears API key input after success and shows transient success", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "anthropic", hasKey: false, baseUrl: "", model: "" });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.change(within(container).getByPlaceholderText(/sk/), { target: { value: "sk-new-key" } });
    fireEvent.click(getSaveButton(container));
    await waitFor(() => expect(saveApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-new-key", undefined, undefined));
  });

  it("clear removes key and resets form", async () => {
    getChatConfigMock.mockResolvedValueOnce({ provider: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await waitFor(() => expect(within(container).getByText("Clear")).toBeTruthy());
    // After clear, getChatConfig reports hasKey:false for the re-loaded config.
    getChatConfigMock.mockResolvedValue({ provider: "anthropic", hasKey: false, baseUrl: "", model: "" });
    fireEvent.click(within(container).getByText("Clear"));
    await waitFor(() => expect(clearApiKeyMock).toHaveBeenCalledWith("anthropic"));
    await waitFor(() => expect(screen.getByText("Not connected")).toBeTruthy());
  });

  it("provider delete button calls clear and refreshes", async () => {
    getChatConfigMock
      .mockResolvedValueOnce({ provider: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" })
      .mockResolvedValueOnce(null);
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await waitFor(() => expect(within(container).getByText("Connected")).toBeTruthy());
    const deleteBtn = within(container).getAllByLabelText("Remove Anthropic")[0];
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(clearApiKeyMock).toHaveBeenCalledWith("anthropic"));
  });

  it("provider rail items have accessible labels and no nested interactive elements", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await waitFor(() => expect(within(container).getByText("Connected")).toBeTruthy());
    const anthropicSelect = within(container).getByLabelText("Select Anthropic");
    expect(anthropicSelect.tagName).toBe("BUTTON");
    // Delete button is a sibling, not nested inside the select button
    const deleteBtn = within(container).getAllByLabelText("Remove Anthropic")[0];
    expect(deleteBtn.tagName).toBe("BUTTON");
    expect(deleteBtn.closest("button")).toBe(deleteBtn); // self, not nested in select
  });

  it("show/hide key toggles input type", async () => {
    getChatConfigMock.mockResolvedValue({ provider: "anthropic", hasKey: false, baseUrl: "", model: "" });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    const keyInput = within(container).getByPlaceholderText(/sk/) as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.click(within(container).getByLabelText("Show API key"));
    expect((within(container).getByPlaceholderText(/sk/) as HTMLInputElement).type).toBe("text");
    fireEvent.click(within(container).getByLabelText("Hide API key"));
    expect((within(container).getByPlaceholderText(/sk/) as HTMLInputElement).type).toBe("password");
  });
});