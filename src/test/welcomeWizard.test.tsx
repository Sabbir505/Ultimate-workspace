// Welcome wizard (PRD §9): first-run gating, navigation, skip/finish flag
// write-through, model-step verify/save, harness rescan, and the Model
// Market deep-link exit.
//
// Module instances matter here: initOnboarding() is a singleton promise, so
// every test resets the module registry (vi.resetModules) and dynamically
// imports BOTH the store and the component — they then share one registry
// entry per test, keeping the store the component reads and the one the
// test asserts against identical.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  listChatModels: vi.fn(),
  setChatApiKey: vi.fn(),
  toastSuccess: vi.fn(),
  loadConfig: vi.fn(),
  refreshHarnesses: vi.fn(),
  addProjectAtPath: vi.fn(),
  setTheme: vi.fn(),
  setActiveView: vi.fn(),
  setSettingsCategory: vi.fn(),
  setLocalModelsOpenMarket: vi.fn(),
  setModalOpen: vi.fn(),
  dialogOpen: vi.fn(),
}));

// Mutable stand-in for the projects store — read via getState() by the
// onboarding store's gate and via selectors by the step components.
const projectsState = vi.hoisted(() => ({
  loaded: true,
  projects: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  harnesses: [] as Array<{ id: string; displayName: string; installed: boolean }>,
  refreshHarnesses: (...a: unknown[]) => mocks.refreshHarnesses(...a),
  addProjectAtPath: (...a: unknown[]) => mocks.addProjectAtPath(...a),
}));

vi.mock("../lib/ipc", () => ({
  getSetting: (...a: unknown[]) => mocks.getSetting(...a),
  setSetting: (...a: unknown[]) => mocks.setSetting(...a),
  listChatModels: (...a: unknown[]) => mocks.listChatModels(...a),
  setChatApiKey: (...a: unknown[]) => mocks.setChatApiKey(...a),
  toastSuccess: (...a: unknown[]) => mocks.toastSuccess(...a),
}));

vi.mock("../state/projects", () => ({
  useProjectsStore: Object.assign(
    (selector: (s: typeof projectsState) => unknown) => selector(projectsState),
    { getState: () => projectsState },
  ),
}));

vi.mock("../state/chat", () => ({
  useChatStore: { getState: () => ({ loadConfig: mocks.loadConfig }) },
}));

vi.mock("../state/settings", () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ theme: "dark", setTheme: mocks.setTheme }),
}));

vi.mock("../state/ui", () => ({
  useUiStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        setActiveView: mocks.setActiveView,
        setSettingsCategory: mocks.setSettingsCategory,
        setLocalModelsOpenMarket: mocks.setLocalModelsOpenMarket,
        setModalOpen: mocks.setModalOpen,
      }),
    { getState: () => ({ setActiveView: mocks.setActiveView, setSettingsCategory: mocks.setSettingsCategory, setLocalModelsOpenMarket: mocks.setLocalModelsOpenMarket, setModalOpen: mocks.setModalOpen }) },
  ),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => mocks.dialogOpen(...a),
}));

vi.mock("../components/common/GlassSelect", () => ({
  GlassSelect: (props: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; title?: string }) => (
    <select
      value={props.value}
      title={props.title}
      onChange={(e) => props.onChange(e.target.value)}
      data-testid="glass-select"
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  projectsState.projects = [];
  projectsState.sessions = [];
  projectsState.harnesses = [];
  mocks.getSetting.mockResolvedValue(null);
  mocks.setSetting.mockResolvedValue(undefined);
  mocks.listChatModels.mockResolvedValue([]);
  mocks.setChatApiKey.mockResolvedValue(undefined);
  mocks.loadConfig.mockResolvedValue(undefined);
  mocks.refreshHarnesses.mockResolvedValue(undefined);
  mocks.addProjectAtPath.mockResolvedValue(null);
});

afterEach(cleanup);

async function freshModules() {
  return await Promise.all([
    import("../components/onboarding/WelcomeWizard"),
    import("../state/onboarding"),
  ]);
}

describe("onboarding gating", () => {
  it("shows on a true first run (no flag, empty profile)", async () => {
    const [, store] = await freshModules();
    await store.initOnboarding();
    const s = store.useOnboardingStore.getState();
    expect(s.visible).toBe(true);
    expect(s.completed).toBe(false);
    expect(s.step).toBe(0);
  });

  it("stays hidden and marks completed when the flag is set", async () => {
    mocks.getSetting.mockResolvedValue("1");
    const [, store] = await freshModules();
    await store.initOnboarding();
    const s = store.useOnboardingStore.getState();
    expect(s.visible).toBe(false);
    expect(s.completed).toBe(true);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("auto-completes for upgrading installs (existing projects) without showing", async () => {
    projectsState.projects = [{ id: "p1", name: "Legacy" }];
    const [, store] = await freshModules();
    await store.initOnboarding();
    const s = store.useOnboardingStore.getState();
    expect(s.visible).toBe(false);
    expect(s.completed).toBe(true);
    expect(mocks.setSetting).toHaveBeenCalledWith("onboarding.completed", "1");
  });

  it("auto-completes for upgrading installs (existing sessions)", async () => {
    projectsState.sessions = [{ id: "s1" }];
    const [, store] = await freshModules();
    await store.initOnboarding();
    expect(store.useOnboardingStore.getState().visible).toBe(false);
    expect(mocks.setSetting).toHaveBeenCalledWith("onboarding.completed", "1");
  });
});

describe("welcome wizard flow", () => {
  async function mountWizard() {
    const [{ WelcomeWizard }, store] = await freshModules();
    store.useOnboardingStore.setState({ loaded: true, visible: true, step: 0, maxStep: 0, completed: false });
    render(<WelcomeWizard />);
    return store;
  }

  it("renders the welcome step with a live theme choice", async () => {
    await mountWizard();
    expect(screen.getByText("Welcome to Relay")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(mocks.setTheme).toHaveBeenCalledWith("light");
  });

  it("Continue advances to the chat-model step and Back returns", async () => {
    await mountWizard();
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Pick a chat model")).toBeTruthy();
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("Welcome to Relay")).toBeTruthy();
  });

  it("Skip persists the completed flag but not the local-model nudge at step 1", async () => {
    const store = await mountWizard();
    fireEvent.click(screen.getByText("Skip"));
    expect(store.useOnboardingStore.getState().visible).toBe(false);
    expect(mocks.setSetting).toHaveBeenCalledWith("onboarding.completed", "1");
    expect(mocks.setSetting).not.toHaveBeenCalledWith("localModels.onboarded", "1");
  });

  it("skipping after seeing the model step also suppresses the local-model nudge", async () => {
    const store = await mountWizard();
    fireEvent.click(screen.getByText("Continue")); // → model step
    fireEvent.click(screen.getByText("Skip"));
    expect(mocks.setSetting).toHaveBeenCalledWith("onboarding.completed", "1");
    expect(mocks.setSetting).toHaveBeenCalledWith("localModels.onboarded", "1");
  });

  it("Escape skips the wizard", async () => {
    const store = await mountWizard();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(store.useOnboardingStore.getState().visible).toBe(false);
  });

  it("native provider: saves the key directly without a live verify", async () => {
    await mountWizard();
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByText("Save key"));
    await waitFor(() => expect(mocks.setChatApiKey).toHaveBeenCalledWith("anthropic", "sk-test"));
    expect(mocks.listChatModels).not.toHaveBeenCalled();
    expect(await screen.findByText("Key saved to your OS keychain.")).toBeTruthy();
  });

  it("compatible provider: verifies via list_chat_models before saving", async () => {
    mocks.listChatModels.mockResolvedValue([{ id: "m1", ownedBy: "x", created: 1, object: "model" }]);
    await mountWizard();
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.change(screen.getByTestId("glass-select"), { target: { value: "openai_compatible" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k-1" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com/v1" } });
    fireEvent.click(screen.getByText("Verify & save"));
    await waitFor(() =>
      expect(mocks.setChatApiKey).toHaveBeenCalledWith("openai_compatible", "k-1", "https://api.example.com/v1"),
    );
    expect(mocks.listChatModels).toHaveBeenCalledWith("openai_compatible", "https://api.example.com/v1", "k-1");
  });

  it("failed verification shows the error and never saves the key", async () => {
    mocks.listChatModels.mockRejectedValue(new Error("401 unauthorized"));
    await mountWizard();
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.change(screen.getByTestId("glass-select"), { target: { value: "openrouter" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "bad" } });
    fireEvent.click(screen.getByText("Verify & save"));
    expect(await screen.findByText("401 unauthorized")).toBeTruthy();
    expect(mocks.setChatApiKey).not.toHaveBeenCalled();
  });

  it("Model Market deep-link finishes the wizard and links into Settings", async () => {
    await mountWizard();
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Local model")); // select the local option
    fireEvent.click(screen.getByText("Browse the Model Market"));
    expect(mocks.setSettingsCategory).toHaveBeenCalledWith("localmodels");
    expect(mocks.setLocalModelsOpenMarket).toHaveBeenCalledWith(true);
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings");
    expect(mocks.setSetting).toHaveBeenCalledWith("localModels.onboarded", "1");
    const store = (await import("../state/onboarding")).useOnboardingStore;
    expect(store.getState().visible).toBe(false);
  });

  it("harness step lists statuses and re-scans on demand", async () => {
    projectsState.harnesses = [
      { id: "claude_code", displayName: "Claude Code", installed: true },
      { id: "opencode", displayName: "OpenCode", installed: false },
    ];
    await mountWizard();
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Agent harnesses")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText("npm install -g opencode-ai")).toBeTruthy();
    fireEvent.click(screen.getByText("Re-scan"));
    await waitFor(() => expect(mocks.refreshHarnesses).toHaveBeenCalledWith(true));
  });

  it("finish step: adding a project closes the wizard", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/proj");
    await mountWizard();
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Add your first project"));
    await waitFor(() => expect(mocks.addProjectAtPath).toHaveBeenCalledWith("/tmp/proj"));
    const store = (await import("../state/onboarding")).useOnboardingStore;
    await waitFor(() => expect(store.getState().visible).toBe(false));
    expect(mocks.setSetting).toHaveBeenCalledWith("onboarding.completed", "1");
  });

  it("finish step: cancelling the folder picker keeps the wizard open", async () => {
    mocks.dialogOpen.mockResolvedValue(null);
    await mountWizard();
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Add your first project"));
    await waitFor(() => expect(mocks.dialogOpen).toHaveBeenCalled());
    expect(mocks.addProjectAtPath).not.toHaveBeenCalled();
    const store = (await import("../state/onboarding")).useOnboardingStore;
    expect(store.getState().visible).toBe(true);
  });

  it("replay entry (openOnboarding) resets to step 1 after completion", async () => {
    const [, store] = await freshModules();
    await store.initOnboarding();
    store.closeOnboarding();
    expect(store.useOnboardingStore.getState().visible).toBe(false);
    store.openOnboarding();
    const s = store.useOnboardingStore.getState();
    expect(s.visible).toBe(true);
    expect(s.step).toBe(0);
    expect(s.maxStep).toBe(0);
  });
});
