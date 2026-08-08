// Regression test for M20: a dismissed update banner must NOT resurface at
// the next periodic check. The old store recorded nothing on dismiss(), so
// check() re-set `update` 4h later despite the doc comment promising
// "not re-prompted for that same version until the app restarts".
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../lib/ipc";

const checkForUpdate = vi.fn<() => Promise<UpdateInfo | null>>();
vi.mock("../lib/ipc", () => ({
  checkForUpdate: () => checkForUpdate(),
  downloadAndInstallUpdate: vi.fn(),
  listenUpdaterInstalled: vi.fn(),
  listenUpdaterProgress: vi.fn(),
}));

import { useUpdaterStore } from "../state/updater";

const release = (version: string): UpdateInfo => ({
  updateAvailable: true,
  version,
  notes: null,
  pubDate: null,
});

describe("updater dismiss persistence", () => {
  beforeEach(() => {
    useUpdaterStore.getState().reset();
    useUpdaterStore.setState({ dismissedVersion: null });
    checkForUpdate.mockReset();
  });

  it("does not resurface a dismissed version at the next check", async () => {
    checkForUpdate.mockResolvedValue(release("1.2.3"));
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().update?.version).toBe("1.2.3");

    useUpdaterStore.getState().dismiss();
    expect(useUpdaterStore.getState().update).toBeNull();

    // The 4h periodic check fires again with the same version — the banner
    // must stay hidden (this was the M20 bug: it came back).
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().update).toBeNull();
  });

  it("surfaces a NEWER version even after dismissing an older one", async () => {
    checkForUpdate.mockResolvedValue(release("1.2.3"));
    await useUpdaterStore.getState().check();
    useUpdaterStore.getState().dismiss();

    checkForUpdate.mockResolvedValue(release("1.2.4"));
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().update?.version).toBe("1.2.4");
  });

  it("clears the banner when the app is current again", async () => {
    checkForUpdate.mockResolvedValue(release("1.2.3"));
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().update).not.toBeNull();

    checkForUpdate.mockResolvedValue({
      updateAvailable: false,
      version: null,
      notes: null,
      pubDate: null,
    });
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().update).toBeNull();
  });
});
