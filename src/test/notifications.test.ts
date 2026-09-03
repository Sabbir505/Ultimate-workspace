// Notification center (state/notifications.ts) + the relayNotify funnel
// (lib/notifyCenter.ts): the durable bell record, its unseen badge semantics,
// and the DND/focus gating of OS toasts + chimes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const osNotifyMock = vi.fn();
const completionChimeMock = vi.fn();
const notifyChimeMock = vi.fn();
const toastErrorMock = vi.fn();
const toastInfoMock = vi.fn();
const toastSuccessMock = vi.fn();
let appFocused = true;

vi.mock("../lib/notify", () => ({ osNotify: (...a: unknown[]) => osNotifyMock(...a) }));
vi.mock("../lib/sound", () => ({
  playCompletionChime: () => completionChimeMock(),
  playNotifyChime: () => notifyChimeMock(),
}));
vi.mock("../lib/ipc", () => ({
  toastError: (...a: unknown[]) => toastErrorMock(...a),
  toastInfo: (...a: unknown[]) => toastInfoMock(...a),
  toastSuccess: (...a: unknown[]) => toastSuccessMock(...a),
  // settings store imports these but the test never triggers them
  getSetting: () => Promise.resolve(null),
  setSetting: () => Promise.resolve(undefined),
}));
vi.mock("../lib/appFocus", () => ({
  isAppFocused: () => appFocused,
  initAppFocusTracking: () => {},
}));

async function fresh() {
  vi.resetModules();
  return {
    notifications: await import("../state/notifications"),
    notifyCenter: await import("../lib/notifyCenter"),
    settings: await import("../state/settings"),
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  appFocused = true;
});

describe("notifications store", () => {
  it("pushes newest-first, unseen by default, and persists to localStorage", async () => {
    const { notifications } = await fresh();
    const store = notifications.useNotificationsStore.getState();
    store.push({ kind: "completed", title: "A finished", body: "done" });
    store.push({ kind: "error", title: "B failed", body: "boom" });
    const items = notifications.useNotificationsStore.getState().items;
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("B failed");
    expect(items[0].unseen).toBe(true);
    expect(items[0].id).not.toBe(items[1].id);

    const raw = JSON.parse(localStorage.getItem("relay.notifications.v1") ?? "[]");
    expect(raw).toHaveLength(2);
    expect(raw[0].title).toBe("B failed");
  });

  it("keeps the unseen count across a reload (badge survives restarts)", async () => {
    let { notifications } = await fresh();
    notifications.useNotificationsStore.getState().push({
      kind: "completed",
      title: "finished",
      body: "x",
    });
    // Simulate an app restart: fresh module registry re-reads localStorage.
    ({ notifications } = await fresh());
    const items = notifications.useNotificationsStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].unseen).toBe(true);
    expect(notifications.unseenCount(items)).toBe(1);
  });

  it("markAllSeen clears every unseen flag and the derived count", async () => {
    const { notifications } = await fresh();
    const store = notifications.useNotificationsStore.getState();
    store.push({ kind: "error", title: "one", body: "1" });
    store.push({ kind: "completed", title: "two", body: "2" });
    expect(notifications.unseenCount(notifications.useNotificationsStore.getState().items)).toBe(2);
    notifications.useNotificationsStore.getState().markAllSeen();
    const after = notifications.useNotificationsStore.getState().items;
    expect(notifications.unseenCount(after)).toBe(0);
  });

  it("caps the history and supports remove/clear", async () => {
    const { notifications } = await fresh();
    const store = notifications.useNotificationsStore.getState();
    for (let i = 0; i < 105; i++) {
      store.push({ kind: "info" as never, title: `n${i}`, body: "x" });
    }
    const items = notifications.useNotificationsStore.getState().items;
    expect(items).toHaveLength(100);
    expect(items[0].title).toBe("n104"); // newest kept
    expect(items[99].title).toBe("n5"); // oldest dropped

    notifications.useNotificationsStore.getState().remove(items[0].id);
    expect(notifications.useNotificationsStore.getState().items).toHaveLength(99);
    notifications.useNotificationsStore.getState().clear();
    expect(notifications.useNotificationsStore.getState().items).toHaveLength(0);
    expect(localStorage.getItem("relay.notifications.v1")).toBe("[]");
  });
});

describe("relayNotify gating", () => {
  it("always records in the center, even under DND", async () => {
    const { notifications, notifyCenter, settings } = await fresh();
    settings.useSettingsStore.setState({ dnd: true, notifySound: true });
    notifyCenter.relayNotify({
      kind: "completed",
      title: "t finished",
      body: "b",
      osToast: true,
      sound: "completion",
    });
    expect(notifications.useNotificationsStore.getState().items).toHaveLength(1);
    expect(osNotifyMock).not.toHaveBeenCalled();
    expect(completionChimeMock).not.toHaveBeenCalled();
  });

  it("completion chime only fires when Relay is NOT focused", async () => {
    const { notifyCenter, settings } = await fresh();
    settings.useSettingsStore.setState({ dnd: false, notifySound: true });

    appFocused = true;
    notifyCenter.relayNotify({
      kind: "completed",
      title: "t",
      body: "b",
      sound: "completion",
    });
    expect(completionChimeMock).not.toHaveBeenCalled();

    appFocused = false;
    notifyCenter.relayNotify({
      kind: "completed",
      title: "t",
      body: "b",
      osToast: true,
      sound: "completion",
    });
    expect(completionChimeMock).toHaveBeenCalledTimes(1);
    expect(osNotifyMock).toHaveBeenCalledTimes(1);
  });

  it("alert sounds ignore focus; notifySound=off silences everything", async () => {
    const { notifyCenter, settings } = await fresh();
    settings.useSettingsStore.setState({ dnd: false, notifySound: true });
    appFocused = true;
    notifyCenter.relayNotify({ kind: "error", title: "t", body: "b", sound: "alert", soundOnlyUnfocused: false });
    expect(notifyChimeMock).toHaveBeenCalledTimes(1);

    settings.useSettingsStore.setState({ notifySound: false });
    notifyCenter.relayNotify({ kind: "error", title: "t", body: "b", sound: "alert", soundOnlyUnfocused: false });
    expect(notifyChimeMock).toHaveBeenCalledTimes(1);
  });

  it("routes in-app toasts by kind", async () => {
    const { notifyCenter, settings } = await fresh();
    settings.useSettingsStore.setState({ dnd: false });
    notifyCenter.relayNotify({ kind: "error", title: "t", body: "b", inAppToast: true });
    expect(toastErrorMock).toHaveBeenCalledWith("t", "b");
    notifyCenter.relayNotify({ kind: "completed", title: "t", body: "b", inAppToast: true });
    expect(toastSuccessMock).toHaveBeenCalledWith("t", "b");
    notifyCenter.relayNotify({ kind: "automation", title: "t", body: "b", inAppToast: true });
    expect(toastInfoMock).toHaveBeenCalledWith("t — b");
  });
});
