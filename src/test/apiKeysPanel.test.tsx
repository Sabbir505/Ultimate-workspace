// API Keys panel: the rail lists every saved ENDPOINT (the instance
// registry — a kind can be added any number of times, each under its own
// name), the Add API form picks the protocol kind from a dropdown that
// always offers every kind, plus the original save-validation /
// model-fetch / accessibility coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsView } from "../components/settings/SettingsView";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

const getChatConfigMock = vi.fn();
const listInstancesMock = vi.fn();
const saveApiKeyMock = vi.fn();
const clearApiKeyMock = vi.fn();
const listChatModelsMock = vi.fn();
const setSettingMock = vi.fn();
const getSettingMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  getChatConfig: (...a: unknown[]) => getChatConfigMock(...a),
  listChatInstances: (...a: unknown[]) => listInstancesMock(...a),
  // Same rule as src/lib/providerKind.ts: "<kind>-<suffix>" → kind.
  providerKindOf: (id: string) => {
    const dash = id.indexOf("-");
    return dash > 0 ? id.slice(0, dash) : id;
  },
  saveApiKey: (...a: unknown[]) => saveApiKeyMock(...a),
  deleteChatApiKey: (...a: unknown[]) => clearApiKeyMock(...a),
  listChatModels: (...a: unknown[]) => listChatModelsMock(...a),
  setSelectedModels: vi.fn().mockResolvedValue(undefined),
  setChatDefaultModel: vi.fn().mockResolvedValue(undefined),
  setSetting: (...a: unknown[]) => setSettingMock(...a),
  getSetting: (...a: unknown[]) => getSettingMock(...a),
  // Sidebar art (rendered inside SettingsView's Appearance panel; inert here).
  importSidebarArt: vi.fn().mockResolvedValue(null),
  readSidebarArtData: vi.fn().mockResolvedValue(null),
  clearSidebarArt: vi.fn().mockResolvedValue(undefined),
  setSidebarArtPreset: vi.fn().mockResolvedValue(undefined),
  getSidebarArtPath: vi.fn().mockResolvedValue(null),
  SIDEBAR_ART_PRESETS: [],
  sidebarArtPresetUrl: (id: string) => `/sideart/${id}.png`,
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
  // Server builds card (rendered inside the speech + local-models panels).
  sttInstallServer: vi.fn().mockResolvedValue(undefined),
  sttInstallCuda: vi.fn().mockResolvedValue(undefined),
  llamaInstallCuda: vi.fn().mockResolvedValue(undefined),
  ttsInstallGpu: vi.fn().mockResolvedValue(undefined),
  onModelDownloadProgress: vi.fn().mockResolvedValue(() => {}),
  // imageGenStore subscribes to this at module scope; without it the
  // store import fails to evaluate under this mock.
  onImageGenUpdate: vi.fn().mockResolvedValue(() => {}),
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
    saveApiKey: async (provider: string, key: string, baseUrl?: string, model?: string, displayName?: string, kind?: string) => {
      await saveApiKeyMock(provider, key, baseUrl, model, displayName, kind);
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
      // Always reset the store's config on load — a null result means the
      // endpoint is unconfigured, and keeping the previous test's config
      // around would leak hasKey/placeholder state across tests.
      config = result
        ? { ...result, provider }
        : { provider, hasKey: false, baseUrl: "", model: "" };
      notify();
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

type InstanceLike = { id: string; kind: string; displayName?: string | null; baseUrl?: string | null; model?: string | null; hasKey?: boolean };

describe("API Keys Panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChatConfigMock.mockResolvedValue(null);
    listInstancesMock.mockResolvedValue([]);
    saveApiKeyMock.mockResolvedValue(undefined);
    clearApiKeyMock.mockResolvedValue(undefined);
    listChatModelsMock.mockResolvedValue([]);
    getSettingMock.mockResolvedValue("dark");
    setSettingMock.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  // Per-endpoint config map for getChatConfig(id) — what the store's
  // loadConfig (and thus the detail form) sees per endpoint.
  const mockConfigs = (map: Record<string, Record<string, unknown>>) => {
    getChatConfigMock.mockImplementation((provider?: string) => {
      if (!provider) return Promise.resolve(null);
      return Promise.resolve({ provider, hasKey: false, baseUrl: "", model: "", ...map[provider] });
    });
  };

  // The saved-endpoint registry the rail renders.
  const mockInstances = (list: InstanceLike[]) => {
    listInstancesMock.mockResolvedValue(
      list.map((i) => ({
        displayName: null,
        baseUrl: null,
        model: null,
        hasKey: false,
        ...i,
      })),
    );
  };

  const getKindSelect = () => screen.getAllByTestId("glass-select")[0] as HTMLSelectElement;

  const getSaveButton = (container: HTMLElement) => {
    const candidates = within(container).getAllByText(/^(Add API|Save changes)$/);
    const btn = candidates.find((el) => el.tagName === "BUTTON") as HTMLButtonElement;
    if (!btn) throw new Error("Save button not found");
    return btn;
  };

  it("shows an empty rail and every kind in the add-form dropdown when nothing is configured", async () => {
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());
    // The rail no longer pre-lists protocol kinds — it starts empty.
    await screen.findByText(/No APIs yet/);
    expect(screen.queryByLabelText("Select Anthropic")).toBeNull();
    // The Add API form's type dropdown lists every protocol kind — and it
    // keeps listing them all no matter how many endpoints exist.
    const kinds = Array.from(getKindSelect().options).map((o) => o.value);
    expect(kinds).toEqual(["anthropic", "openai", "openrouter", "anthropic_compatible", "openai_compatible"]);
  });

  it("lists added endpoints on the rail and locks the type while editing", async () => {
    mockInstances([
      { id: "anthropic_compatible", kind: "anthropic_compatible", baseUrl: "https://api.example.com/v1" },
    ]);
    mockConfigs({ anthropic_compatible: { hasKey: false, baseUrl: "https://api.example.com/v1" } });
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());
    // Added via base URL (no key yet) → it is on the rail…
    const railItem = await screen.findByLabelText("Select Anthropic Compatible");
    fireEvent.click(railItem);
    // …and its detail form shows the not-connected badge with the type locked.
    await waitFor(() => expect(screen.getByText("Not connected")).toBeTruthy());
    expect(getKindSelect().disabled).toBe(true);
  });

  it("lists a second endpoint of the same kind under its own name", async () => {
    mockInstances([
      { id: "openai_compatible", kind: "openai_compatible", hasKey: true },
      { id: "openai_compatible-x7f2", kind: "openai_compatible", displayName: "GLM via Z.ai", hasKey: true },
    ]);
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());
    // Two same-kind endpoints: the default shows the kind label, the named
    // one shows its own name — both on the rail at once.
    expect(await screen.findByLabelText("Select OpenAI Compatible")).toBeTruthy();
    expect(screen.getByLabelText("Select GLM via Z.ai")).toBeTruthy();
  });

  it("shows Connected badge and summary when provider has key", async () => {
    mockInstances([{ id: "anthropic", kind: "anthropic", hasKey: true, model: "claude-sonnet-5", baseUrl: "https://api.anthropic.com" }]);
    mockConfigs({ anthropic: { hasKey: true, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" } });
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    expect(screen.getByText("Endpoint")).toBeTruthy();
    expect(screen.getByText("Selected model")).toBeTruthy();
  });

  it("shows the custom endpoint name on the rail instead of the kind", async () => {
    mockInstances([{ id: "anthropic", kind: "anthropic", hasKey: true, displayName: "Work key" }]);
    mockConfigs({ anthropic: { hasKey: true } });
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());
    expect(screen.getByLabelText("Select Work key")).toBeTruthy();
    expect(screen.queryByLabelText("Select Anthropic")).toBeNull();
  });

  it("selecting a provider loads its config", async () => {
    mockInstances([
      { id: "anthropic", kind: "anthropic", hasKey: true },
      { id: "openai_compatible", kind: "openai_compatible", baseUrl: "https://api.example.com/v1" },
    ]);
    mockConfigs({
      anthropic: { hasKey: true, baseUrl: "", model: "" },
      openai_compatible: { hasKey: false, baseUrl: "https://api.example.com/v1" },
    });
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());
    // Click the rail select button for OpenAI Compatible (aria-label
    // disambiguates from nav)
    fireEvent.click(screen.getByLabelText("Select OpenAI Compatible"));
    await waitFor(() => expect(getChatConfigMock).toHaveBeenCalledWith("openai_compatible"));
    await waitFor(() => expect(screen.getByText("Not connected")).toBeTruthy());
  });

  it("native provider requires API key to save", async () => {
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await screen.findByText(/No APIs yet/);
    const saveButton = getSaveButton(container);
    expect(saveButton.disabled).toBe(true);
    fireEvent.change(within(container).getByPlaceholderText(/sk/), { target: { value: "sk-test-key" } });
    expect(getSaveButton(container).disabled).toBe(false);
  });

  it("existing key allows saving model/baseUrl without re-entering key", async () => {
    mockInstances([{ id: "anthropic", kind: "anthropic", hasKey: true }]);
    mockConfigs({ anthropic: { hasKey: true, baseUrl: "", model: "" } });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await waitFor(() => expect(getSaveButton(container)).toBeTruthy());
    const saveButton = getSaveButton(container);
    expect(saveButton.disabled).toBe(false);
  });

  it("compatible provider requires base URL to save", async () => {
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await screen.findByText(/No APIs yet/);
    // Pick the kind in the Add API form's dropdown…
    fireEvent.change(getKindSelect(), { target: { value: "anthropic_compatible" } });
    const urlInput = await screen.findByPlaceholderText(/https:\/\/api.example.com\/v1/) as HTMLInputElement;
    await waitFor(() => expect(getChatConfigMock).toHaveBeenCalledWith("anthropic_compatible"));
    expect(getSaveButton(container).disabled).toBe(true);
    // …then a base URL unlocks Save.
    fireEvent.change(urlInput, { target: { value: "https://api.example.com/v1" } });
    expect(urlInput.value).toBe("https://api.example.com/v1");
    await waitFor(() => expect(getSaveButton(container).disabled).toBe(false));
  });

  it("adding an endpoint sends the kind and the name from the form", async () => {
    render(<SettingsView />);
    await screen.findByText(/No APIs yet/);
    fireEvent.change(getKindSelect(), { target: { value: "openai_compatible" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "GLM via Z.ai" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com/v1" } });
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.click(getSaveButton(container));
    await waitFor(() =>
      expect(saveApiKeyMock).toHaveBeenCalledWith(
        "openai_compatible",
        "",
        "https://api.example.com/v1",
        undefined,
        "GLM via Z.ai",
        "openai_compatible",
      ),
    );
    // Key input is cleared after a successful save (security).
    await waitFor(() => expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(""));
  });

  it("a second endpoint of the same kind saves under a fresh suffixed id", async () => {
    mockInstances([{ id: "openai_compatible", kind: "openai_compatible", hasKey: true, baseUrl: "https://a.example.com/v1" }]);
    mockConfigs({ openai_compatible: { hasKey: true, baseUrl: "https://a.example.com/v1" } });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await screen.findByLabelText("Select OpenAI Compatible");
    // Add another OpenAI-compatible endpoint while the first is on the rail.
    fireEvent.click(screen.getByLabelText("Add a new provider"));
    // The add flow preselects the first kind (anthropic) — switch to
    // openai_compatible, which must stay selectable.
    fireEvent.change(getKindSelect(), { target: { value: "openai_compatible" } });
    fireEvent.change(within(container).getByLabelText("Base URL"), { target: { value: "https://b.example.com/v1" } });
    fireEvent.click(getSaveButton(container));
    await waitFor(() => expect(saveApiKeyMock).toHaveBeenCalled());
    const [id] = saveApiKeyMock.mock.calls[0];
    expect(id).toMatch(/^openai_compatible-[a-z2-9]{5}$/);
    expect(id).not.toBe("openai_compatible");
  });

  it("falls back to the kind label when no name is typed", async () => {
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await screen.findByText(/No APIs yet/);
    fireEvent.change(within(container).getByPlaceholderText(/sk/), { target: { value: "sk-new-key" } });
    fireEvent.click(getSaveButton(container));
    await waitFor(() => expect(saveApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-new-key", undefined, undefined, "Anthropic", "anthropic"));
  });

  it("fetches models for compatible provider when base URL and key present", async () => {
    mockInstances([{ id: "openai_compatible", kind: "openai_compatible", hasKey: true, baseUrl: "https://api.example.com/v1" }]);
    mockConfigs({ openai_compatible: { hasKey: true, baseUrl: "https://api.example.com/v1", model: "" } });
    listChatModelsMock.mockResolvedValue([{ id: "model-a", object: "model", created: 1, ownedBy: "test" }, { id: "model-b", object: "model", created: 2, ownedBy: "test" }]);
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.click(within(container).getByLabelText("Select OpenAI Compatible"));
    await waitFor(() => expect(listChatModelsMock).toHaveBeenCalled(), { timeout: 3000 });
    expect(await screen.findByText("2 available")).toBeTruthy();
  });

  it("shows fetch error and manual fallback button", async () => {
    mockInstances([{ id: "openai_compatible", kind: "openai_compatible", hasKey: true, baseUrl: "https://api.example.com/v1" }]);
    mockConfigs({ openai_compatible: { hasKey: true, baseUrl: "https://api.example.com/v1", model: "" } });
    listChatModelsMock.mockRejectedValue(new Error("Network error"));
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.click(within(container).getByLabelText("Select OpenAI Compatible"));
    await waitFor(() => expect(screen.getByText("Network error")).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText("Use manual input")).toBeTruthy();
  });

  it("manual fallback clears error and switches the add-model row to text input", async () => {
    mockInstances([{ id: "openai_compatible", kind: "openai_compatible", hasKey: true, baseUrl: "https://api.example.com/v1" }]);
    mockConfigs({ openai_compatible: { hasKey: true, baseUrl: "https://api.example.com/v1", model: "" } });
    listChatModelsMock.mockRejectedValue(new Error("Network error"));
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    fireEvent.click(within(container).getByLabelText("Select OpenAI Compatible"));
    await waitFor(() => expect(screen.getByText("Use manual input")).toBeTruthy(), { timeout: 2000 });
    fireEvent.click(screen.getByText("Use manual input"));
    expect(screen.queryByText("Network error")).toBeFalsy();
    // The standalone Model field is gone — manual entry lives in the
    // Model list's Add-model row, which falls back to a free-text id
    // input when the fetch failed (no fetched options to pick from).
    fireEvent.click(within(container).getByText("Add model"));
    expect(screen.getByPlaceholderText("model-id")).toBeTruthy();
  });

  it("clear removes key and flips the pane back to the add flow", async () => {
    mockInstances([{ id: "anthropic", kind: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" }]);
    mockConfigs({ anthropic: { hasKey: true, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" } });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await waitFor(() => expect(within(container).getByText("Clear")).toBeTruthy());
    // After clear, the endpoint is gone from the registry.
    mockInstances([]);
    fireEvent.click(within(container).getByText("Clear"));
    await waitFor(() => expect(clearApiKeyMock).toHaveBeenCalledWith("anthropic"));
    // The endpoint left the rail, so the add flow takes over the pane.
    await waitFor(() => expect(screen.getByText(/No APIs yet/)).toBeTruthy());
    expect(getSaveButton(container).textContent).toBe("Add API");
  });

  it("provider delete button calls clear and refreshes", async () => {
    mockInstances([{ id: "anthropic", kind: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com" }]);
    mockConfigs({ anthropic: { hasKey: true, baseUrl: "https://api.anthropic.com", model: "" } });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    // Rail delete + detail-head trash share the "Remove <name>" label.
    await waitFor(() => expect(within(container).getAllByLabelText("Remove Anthropic").length).toBeGreaterThan(0));
    fireEvent.click(within(container).getAllByLabelText("Remove Anthropic")[0]);
    await waitFor(() => expect(clearApiKeyMock).toHaveBeenCalledWith("anthropic"));
  });

  it("provider rail items have accessible labels and no nested interactive elements", async () => {
    mockInstances([{ id: "anthropic", kind: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com" }]);
    mockConfigs({ anthropic: { hasKey: true, baseUrl: "https://api.anthropic.com", model: "" } });
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await waitFor(() => expect(within(container).getByLabelText("Select Anthropic")).toBeTruthy());
    const anthropicSelect = within(container).getByLabelText("Select Anthropic");
    expect(anthropicSelect.tagName).toBe("BUTTON");
    // Delete button is a sibling, not nested inside the select button
    const deleteBtn = within(container).getAllByLabelText("Remove Anthropic")[0];
    expect(deleteBtn.tagName).toBe("BUTTON");
    expect(deleteBtn.closest("button")).toBe(deleteBtn); // self, not nested in select
  });

  it("show/hide key toggles input type", async () => {
    render(<SettingsView />);
    const panel = await screen.findByText("API providers");
    const container = panel.closest(".api-settings") as HTMLElement;
    await screen.findByText(/No APIs yet/);
    const keyInput = within(container).getByPlaceholderText(/sk/) as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.click(within(container).getByLabelText("Show API key"));
    expect((within(container).getByPlaceholderText(/sk/) as HTMLInputElement).type).toBe("text");
    fireEvent.click(within(container).getByLabelText("Hide API key"));
    expect((within(container).getByPlaceholderText(/sk/) as HTMLInputElement).type).toBe("password");
  });

  it("kind dropdown still lists every kind after one is added", async () => {
    mockInstances([{ id: "anthropic", kind: "anthropic", hasKey: true }]);
    mockConfigs({ anthropic: { hasKey: true } });
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByLabelText("Select Anthropic")).toBeTruthy());
    // Enter the add flow — every kind must remain addable.
    fireEvent.click(screen.getByLabelText("Add a new provider"));
    const kinds = Array.from(getKindSelect().options).map((o) => o.value);
    expect(kinds).toEqual(["anthropic", "openai", "openrouter", "anthropic_compatible", "openai_compatible"]);
  });
});
