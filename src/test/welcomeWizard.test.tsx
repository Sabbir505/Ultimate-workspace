// Welcome wizard (PRD §9): first-run gating, 5-step navigation, skip/finish
// flag write-through, live harness detection, the Model Market deep-link
// exit, the defaults step's real settings writes (chat.defaultApproval KV +
// per-provider default model), and the first-task send.
//
// Module instances matter here: initOnboarding() is a singleton promise, so
// every test resets the module registry (vi.resetModules) and dynamically
// imports BOTH the store and the component — they then share one registry
// entry per test, keeping the store the component reads and the one the
// test asserts against identical.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getChatConfig: vi.fn(),
  setChatApiKey: vi.fn(),
  setChatDefaultModel: vi.fn(),
  toastSuccess: vi.fn(),
  newChat: vi.fn(),
  sendMessage: vi.fn(),
  refreshHarnesses: vi.fn(),
  addProjectAtPath: vi.fn(),
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
  getChatConfig: (...a: unknown[]) => mocks.getChatConfig(...a),
  setChatApiKey: (...a: unknown[]) => mocks.setChatApiKey(...a),
  setChatDefaultModel: (...a: unknown[]) => mocks.setChatDefaultModel(...a),
  toastSuccess: (...a: unknown[]) => mocks.toastSuccess(...a),
}));

vi.mock("../state/projects", () => ({
  useProjectsStore: Object.assign(
    (selector: (s: typeof projectsState) => unknown) => selector(projectsState),
    { getState: () => projectsState },
  ),
}));

vi.mock("../state/chat", () => ({
  useChatStore: {
    getState: () => ({
      newChat: mocks.newChat,
      sendMessage: mocks.sendMessage,
    }),
  },
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
    {
      getState: () => ({
        setActiveView: mocks.setActiveView,
        setSettingsCategory: mocks.setSettingsCategory,
        setLocalModelsOpenMarket: mocks.setLocalModelsOpenMarket,
        setModalOpen: mocks.setModalOpen,
      }),
    },
  ),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => mocks.dialogOpen(...a),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  projectsState.projects = [];
  projectsState.sessions = [];
  projectsState.harnesses = [];
  mocks.getSetting.mockResolvedValue(null);
  mocks.setSetting.mockResolvedValue(undefined);
  mocks.getChatConfig.mockResolvedValue({ provider: null, baseUrl: null, model: null, hasKey: false });
  mocks.setChatApiKey.mockResolvedValue(undefined);
  mocks.setChatDefaultModel.mockResolvedValue(undefined);
  mocks.newChat.mockResolvedValue({ id: "cs1" });
  mocks.sendMessage.mockResolvedValue(undefined);
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
    store.useOnboardingStore.setState({ loaded: true, visible: true, step: 0, maxStep: 0, completed: false, path: null });
    render(<WelcomeWizard />);
    return store;
  }

  /** Walk from the Meet step to step index `n` via the footer primaries.
   *  Role+name queries because the buttons carry an arrow glyph span. */
  async function advanceTo(n: number) {
    const names = [/^Get Started/, /^Next/, /^Next/, /^Continue/];
    for (let i = 0; i < n; i++) {
      fireEvent.click(screen.getByRole("button", { name: names[i] }));
    }
  }

  it("step 1 renders the Meet hero and advances to Choose your path", async () => {
    await mountWizard();
    expect(screen.getByText(/Meet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Get Started/ }));
    expect(screen.getByText("Choose your path")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByText(/Meet/)).toBeTruthy();
  });

  it("step 2 records the experience path in memory", async () => {
    const store = await mountWizard();
    await advanceTo(1);
    expect(screen.getByText("I'm new to AI coding agents")).toBeTruthy();
    expect(store.useOnboardingStore.getState().path).toBeNull();
    fireEvent.click(screen.getByText("I'm new to AI coding agents"));
    expect(store.useOnboardingStore.getState().path).toBe("newcomer");
  });

  it("Skip persists the completed flag but not the local-model nudge at step 1", async () => {
    const store = await mountWizard();
    fireEvent.click(screen.getByText("Skip"));
    expect(store.useOnboardingStore.getState().visible).toBe(false);
    expect(mocks.setSetting).toHaveBeenCalledWith("onboarding.completed", "1");
    expect(mocks.setSetting).not.toHaveBeenCalledWith("localModels.onboarded", "1");
  });

  it("skipping after reaching the agent step also suppresses the local-model nudge", async () => {
    const store = await mountWizard();
    await advanceTo(2); // → agent step (maxStep 2)
    fireEvent.click(screen.getByText("Skip"));
    expect(mocks.setSetting).toHaveBeenCalledWith("onboarding.completed", "1");
    expect(mocks.setSetting).toHaveBeenCalledWith("localModels.onboarded", "1");
  });

  it("Escape skips the wizard", async () => {
    const store = await mountWizard();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(store.useOnboardingStore.getState().visible).toBe(false);
  });

  it("agent step reveals statuses from the real probe and re-scans on demand", async () => {
    projectsState.harnesses = [
      { id: "claude_code", displayName: "Claude Code", installed: true },
      { id: "opencode", displayName: "OpenCode", installed: false },
    ];
    await mountWizard();
    await advanceTo(2);
    expect(screen.getByText("1 of 2 agents detected on this machine — connect one or skip ahead.")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Local Model")).toBeTruthy();
    fireEvent.click(screen.getByText("↻ Re-scan"));
    await waitFor(() => expect(mocks.refreshHarnesses).toHaveBeenCalledWith(true));
  });

  it("agent step shows the skeleton while the probe is pending", async () => {
    await mountWizard();
    await advanceTo(2);
    expect(screen.getByText("Scanning this machine for installed agents…")).toBeTruthy();
  });

  it("Local Model row deep-links into the Model Market and finishes the wizard", async () => {
    projectsState.harnesses = [{ id: "claude_code", displayName: "Claude Code", installed: true }];
    await mountWizard();
    await advanceTo(2);
    fireEvent.click(screen.getByText("Setup"));
    expect(mocks.setSettingsCategory).toHaveBeenCalledWith("localmodels");
    expect(mocks.setLocalModelsOpenMarket).toHaveBeenCalledWith(true);
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings");
    expect(mocks.setSetting).toHaveBeenCalledWith("localModels.onboarded", "1");
    const store = (await import("../state/onboarding")).useOnboardingStore;
    expect(store.getState().visible).toBe(false);
  });

  it("workspace step: picking a folder adds the project and previews the real git state", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/proj");
    projectsState.projects = [];
    mocks.addProjectAtPath.mockResolvedValue({ id: "p1", name: "proj", path: "/tmp/proj", isGitRepo: true });
    await mountWizard();
    await advanceTo(3);
    fireEvent.click(screen.getByText("Open a project"));
    await waitFor(() => expect(mocks.addProjectAtPath).toHaveBeenCalledWith("/tmp/proj"));
    expect(await screen.findByText("Git repository detected")).toBeTruthy();
    expect(screen.getByText("proj")).toBeTruthy();
  });

  it("workspace step: 'later' defers without opening the picker", async () => {
    await mountWizard();
    await advanceTo(3);
    fireEvent.click(screen.getByText("I'll do this later"));
    expect(mocks.dialogOpen).not.toHaveBeenCalled();
    expect(screen.getByText(/add a project/)).toBeTruthy();
  });

  it("defaults step: permission choice writes chat.defaultApproval immediately", async () => {
    await mountWizard();
    await advanceTo(4);
    fireEvent.click(screen.getByText("Ask first"));
    expect(mocks.setSetting).toHaveBeenCalledWith("chat.defaultApproval", "manual");
  });

  it("defaults step: a provider tile with a key sets the default model directly", async () => {
    mocks.getChatConfig.mockImplementation((provider: string) =>
      Promise.resolve({ provider, baseUrl: null, model: null, hasKey: provider === "anthropic" }),
    );
    await mountWizard();
    await advanceTo(4);
    // Let the hasKey probe (useEffect → getChatConfig) settle before clicking.
    await act(async () => {});
    fireEvent.click(screen.getByText("Claude Sonnet"));
    await waitFor(() =>
      expect(mocks.setChatDefaultModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5-20250929"),
    );
    expect(mocks.setChatApiKey).not.toHaveBeenCalled();
  });

  it("defaults step: a tile without a key expands the key form and saves it", async () => {
    await mountWizard();
    await advanceTo(4);
    fireEvent.click(screen.getByText("Claude Sonnet"));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByText("Save key"));
    await waitFor(() => expect(mocks.setChatApiKey).toHaveBeenCalledWith("anthropic", "sk-test"));
    await waitFor(() =>
      expect(mocks.setChatDefaultModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5-20250929"),
    );
  });

  it("defaults step: a suggestion genuinely starts the first chat", async () => {
    await mountWizard();
    await advanceTo(4);
    fireEvent.click(screen.getByText("Explain this project structure"));
    await waitFor(() => expect(mocks.newChat).toHaveBeenCalledWith("auto", "auto"));
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith("Explain this project structure"));
    const store = (await import("../state/onboarding")).useOnboardingStore;
    expect(store.getState().visible).toBe(false);
  });

  it("Finish persists the completed flag", async () => {
    const store = await mountWizard();
    await advanceTo(4);
    fireEvent.click(screen.getByRole("button", { name: /^Finish/ }));
    expect(store.useOnboardingStore.getState().visible).toBe(false);
    expect(mocks.setSetting).toHaveBeenCalledWith("onboarding.completed", "1");
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
