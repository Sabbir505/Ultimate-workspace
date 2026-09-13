// Session Mesh (SESSION_MESH_DESIGN_ARCHITECTURE.md) store + UI wiring:
// - onSessionMail indexes one mail record under BOTH parties so the Git
//   sidebar shows the exchange from either session, latest transition wins,
//   and the per-session history is capped.
// - onSessionSpawn appends children (id-deduped) under the parent.
// - GitToolsSidebar renders a Mesh section with click-through rows and a
//   mails+children badge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

/* ── Store-level tests (no component, no ipc mock needed) ────────────────── */

// The store module evaluates without a Tauri runtime as long as nothing
// calls ipc at import time — chat.ts only imports types/values it uses
// lazily. These tests import the store fresh; the UI describe below mounts
// GitToolsSidebar with the ipc surface mocked (same approach as
// gitSidebarSections.test.tsx).

const mail = (over: Partial<ImportMail>): ImportMail => ({
  mailId: "m1",
  fromSession: "a",
  fromTitle: "Asker",
  toSession: "b",
  toTitle: "Target",
  mode: "question",
  status: "queued",
  bodyExcerpt: "what did we decide?",
  answerExcerpt: null,
  depth: 0,
  ...over,
});
type ImportMail = {
  mailId: string;
  fromSession: string;
  fromTitle: string;
  toSession: string;
  toTitle: string;
  mode: string;
  status: string;
  bodyExcerpt: string;
  answerExcerpt: string | null;
  depth: number;
};

beforeEach(() => {
  useChatStore.setState({
    meshMail: {},
    meshMailBySession: {},
    meshChildren: {},
    activeChatSessionId: "a",
    streaming: {},
    chatStatus: {},
  });
  useUiStore.setState({ gitSectionMeshOpen: true });
});

afterEach(() => {
  cleanup();
});

describe("session mesh store", () => {
  it("indexes a mail under both parties", () => {
    useChatStore.getState().onSessionMail(mail({}));
    const s = useChatStore.getState();
    expect(s.meshMailBySession["a"]).toEqual(["m1"]);
    expect(s.meshMailBySession["b"]).toEqual(["m1"]);
    expect(s.meshMail["m1"]?.status).toBe("queued");
  });

  it("latest transition wins without duplicating the index entry", () => {
    useChatStore.getState().onSessionMail(mail({}));
    useChatStore.getState().onSessionMail(mail({ status: "delivered" }));
    useChatStore.getState().onSessionMail(mail({ status: "answered", answerExcerpt: "42" }));
    const s = useChatStore.getState();
    expect(s.meshMailBySession["a"]).toEqual(["m1"]);
    expect(s.meshMailBySession["b"]).toEqual(["m1"]);
    expect(s.meshMail["m1"]?.status).toBe("answered");
    expect(s.meshMail["m1"]?.answerExcerpt).toBe("42");
  });

  it("keeps separate mails in per-session insertion order", () => {
    useChatStore.getState().onSessionMail(mail({ mailId: "m1" }));
    useChatStore.getState().onSessionMail(mail({ mailId: "m2", toSession: "c", toTitle: "C" }));
    expect(useChatStore.getState().meshMailBySession["a"]).toEqual(["m1", "m2"]);
    expect(useChatStore.getState().meshMailBySession["c"]).toEqual(["m2"]);
  });

  it("caps per-session mail history with newest entries surviving", () => {
    for (let i = 0; i < 40; i++) {
      useChatStore
        .getState()
        .onSessionMail(mail({ mailId: `m${i}`, toSession: "b", toTitle: "T" }));
    }
    const list = useChatStore.getState().meshMailBySession["a"]!;
    expect(list.length).toBeLessThanOrEqual(30);
    expect(list.includes("m0")).toBe(false);
    expect(list.includes("m39")).toBe(true);
  });

  it("pre-creates the target's streaming entry when mail is delivered", () => {
    // onToken never CREATES a streaming entry — mesh turns start Rust-side,
    // so without this pre-creation every token from a mail-triggered turn
    // was dropped and the chat view showed nothing until done.
    useChatStore.getState().onSessionMail(mail({ status: "delivered" }));
    const s = useChatStore.getState();
    expect("b" in s.streaming).toBe(true);
    expect(s.streaming["b"]).toBe("");
    expect(s.chatStatus["b"]?.reason).toBe("thinking");
  });

  it("queued mail does not start streaming; a later delivered event does", () => {
    useChatStore.getState().onSessionMail(mail({ status: "queued" }));
    expect("b" in useChatStore.getState().streaming).toBe(false);
    useChatStore.getState().onSessionMail(mail({ status: "delivered" }));
    expect("b" in useChatStore.getState().streaming).toBe(true);
  });

  it("does not clobber an in-flight streaming entry on re-delivery", () => {
    useChatStore.setState({ streaming: { b: "partial tokens" } });
    useChatStore.getState().onSessionMail(mail({ status: "delivered" }));
    expect(useChatStore.getState().streaming["b"]).toBe("partial tokens");
  });

  it("pre-creates the spawned child's streaming entry", () => {
    useChatStore
      .getState()
      .onSessionSpawn({ parentSessionId: "a", childSessionId: "kid", title: "T", agent: "opencode" });
    const s = useChatStore.getState();
    expect("kid" in s.streaming).toBe(true);
    expect(s.chatStatus["kid"]?.reason).toBe("thinking");
  });

  it("records spawned children deduped under the parent", () => {
    const spawn = (over: Partial<ImportSpawn>): ImportSpawn => ({
      parentSessionId: "a",
      childSessionId: "kid",
      title: "Fix tests",
      agent: "harness:opencode",
      ...over,
    });
    type ImportSpawn = {
      parentSessionId: string;
      childSessionId: string;
      title: string;
      agent: string;
    };
    useChatStore.getState().onSessionSpawn(spawn({}));
    useChatStore.getState().onSessionSpawn(spawn({}));
    useChatStore.getState().onSessionSpawn(spawn({ childSessionId: "kid2", title: "Second" }));
    const children = useChatStore.getState().meshChildren["a"]!;
    expect(children.map((c) => c.childId)).toEqual(["kid", "kid2"]);
  });
});

/* ── Git-sidebar Mesh section ────────────────────────────────────────────── */

vi.mock("../lib/ipc", () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
  listGitBranches: vi.fn().mockResolvedValue([]),
  safeListen: vi.fn().mockResolvedValue(() => {}),
}));

import { GitToolsSidebar } from "../components/chat/GitToolsSidebar";

describe("git sidebar Mesh section", () => {
  beforeEach(() => {
    useChatStore.setState({
      meshMail: {},
      meshMailBySession: {},
      meshChildren: {},
      activeChatSessionId: "a",
      sessions: [],
      subagents: {},
      streaming: {},
    });
    useUiStore.setState({
      gitSidebarCollapsed: false,
      gitSectionAgentsOpen: true,
      gitSectionMeshOpen: true,
    });
  });

  it("shows the empty hint when nothing happened", () => {
    render(<GitToolsSidebar />);
    expect(screen.getByText("No mesh activity.")).toBeTruthy();
  });

  it("renders mail rows for both directions with peer name and status", () => {
    useChatStore
      .getState()
      .onSessionMail(mail({ status: "answered", answerExcerpt: "we chose sqlite" }));
    useChatStore
      .getState()
      .onSessionMail(
        mail({
          mailId: "m2",
          fromSession: "c",
          fromTitle: "Peer session",
          toSession: "a",
          mode: "notify",
          status: "delivered",
          bodyExcerpt: "heads up, I renamed the module",
        }),
      );
    render(<GitToolsSidebar />);
    expect(screen.getByText("To")).toBeTruthy();
    expect(screen.getByText("From")).toBeTruthy();
    // Peer names: outgoing mail to "b" shows its title; incoming from "c".
    expect(screen.getByText("Target")).toBeTruthy();
    expect(screen.getByText("Peer session")).toBeTruthy();
    expect(screen.getByText("answered")).toBeTruthy();
  });

  it("renders spawned children rows with their task title", () => {
    useChatStore
      .getState()
      .onSessionSpawn({
        parentSessionId: "a",
        childSessionId: "kid",
        title: "Fix tests",
        agent: "harness:opencode",
      });
    render(<GitToolsSidebar />);
    expect(screen.getByText("Spawned")).toBeTruthy();
    expect(screen.getByText("Fix tests")).toBeTruthy();
  });

  it("badge counts mails + spawned children", () => {
    useChatStore.getState().onSessionMail(mail({}));
    useChatStore
      .getState()
      .onSessionSpawn({ parentSessionId: "a", childSessionId: "kid", title: "Fix tests", agent: "opencode" });
    render(<GitToolsSidebar />);
    expect(screen.getByText("2")).toBeTruthy();
  });
});
