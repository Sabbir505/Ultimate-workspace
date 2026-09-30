// Session-id provenance indicator (pane header).
//
// A harness session id captured by the on-disk probe is a heuristic, and when
// two panes share a cwd the probe may have had to step over a newer session
// owned by another pane (see harness_adapters::session_claims). That case
// surfaces as `disk_probe_ambiguous`, and the pane header must say so — the
// user is about to resume or read costs from an id that is a best-effort pick,
// not a confirmed match.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  killPty: vi.fn(async () => undefined),
  getChangedFiles: vi.fn(async () => []),
  listenPtyOutput: vi.fn(async () => () => {}),
  listenPtyState: vi.fn(async () => () => {}),
  listenPtyCrashed: vi.fn(async () => () => {}),
  listenPtyExit: vi.fn(async () => () => {}),
  listenSessionHarnessId: vi.fn(async () => () => {}),
  tauriRuntimeAvailable: () => false,
}));

import { PaneFrame } from "../components/panes/PaneFrame";
import { usePanesStore, type Pane } from "../state/panes";
import { useProjectsStore } from "../state/projects";
import type { HarnessIdSource } from "../types";

const SESSION_ID = "relay-1";

function makePane(harness: "kimi_code" | null): Pane {
  return {
    paneId: "term-1",
    state: "idle",
    lastUsedAt: 1,
    lastInputAt: 0,
    activity: null,
    data: {
      kind: "terminal",
      sessionId: SESSION_ID,
      harness,
      label: "kimi",
      spawn: { type: "shell", cwd: "D:/proj/p1", command: "sh" },
      exited: false,
      exitCode: null,
      crashed: false,
    },
  } as unknown as Pane;
}

function sessionWith(source: HarnessIdSource | null) {
  return [
    {
      id: SESSION_ID,
      projectId: "p1",
      harness: "kimi_code",
      harnessSessionId: source ? "session_x" : null,
      harnessSessionIdSource: source,
      title: "kimi",
      worktreePath: null,
      createdAt: 1,
      lastActiveAt: 1,
      status: "idle",
    } as never,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  usePanesStore.setState({
    panes: [makePane("kimi_code")],
    focusedPaneId: "term-1",
  });
});

afterEach(() => cleanup());

describe("PaneFrame harness-id provenance badge", () => {
  it("warns when the id is an ambiguous disk-probe pick", () => {
    useProjectsStore.setState({ sessions: sessionWith("disk_probe_ambiguous") });
    const { container } = render(<PaneFrame pane={makePane("kimi_code")} index={0} focused />);
    const badge = container.querySelector(".harness-id-guess");
    expect(badge).not.toBeNull();
    // The warning must explain itself — "id?" alone tells the user nothing.
    expect(badge!.getAttribute("title")).toContain("another open pane");
  });

  it("stays quiet for a clean disk probe and for an output scrape", () => {
    for (const source of [null, "disk_probe", "output"] as HarnessIdSource[]) {
      useProjectsStore.setState({ sessions: sessionWith(source) });
      const { container, unmount } = render(
        <PaneFrame pane={makePane("kimi_code")} index={0} focused />,
      );
      expect(container.querySelector(".harness-id-guess")).toBeNull();
      unmount();
    }
  });

  it("never shows for a shell pane, which has no session at all", () => {
    useProjectsStore.setState({ sessions: sessionWith("disk_probe_ambiguous") });
    const shell = makePane("kimi_code");
    (shell.data as { sessionId: string | null }).sessionId = null;
    usePanesStore.setState({ panes: [shell] });
    const { container } = render(<PaneFrame pane={shell} index={0} focused />);
    expect(container.querySelector(".harness-id-guess")).toBeNull();
  });
});
