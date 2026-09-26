// Fork chat + hotkey overlay lab (dev-only, /fork-hotkey-harness.html): the
// REAL ForkChatModal and HotkeyOverlay mounted outside the Tauri shell with
// seeded store state, so both can be inspected/screenshotted in a plain
// browser. Not part of the production build.
//
// Drive from devtools/automation via window.__harness:
//   __harness.openFork()        — open the fork dialog for the seeded chat
//   __harness.openHotkeys()     — open the shortcuts overlay
//   __harness.pressShortcut()   — fire the REAL keybinding path (capture-phase
//                                 listener in useKeybindings) with Ctrl+/
import "./tauriStub";
import React from "react";
import { createRoot } from "react-dom/client";

import "../styles/tokens.css";
import "../styles/global.css";

import { ForkChatModal } from "../components/chat/ForkChatModal";
import { HotkeyOverlay } from "../components/hotkey-overlay/HotkeyOverlay";
import { MessageActions } from "../components/chat/ActivitySteps";
import { useKeybindings } from "../hooks/useKeybindings";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";
import { useProjectsStore } from "../state/projects";

useChatStore.setState({
  activeChatSessionId: "sess-fork-me",
  sessions: [
    {
      id: "sess-fork-me",
      title: "Migrate the exporter to streaming",
      provider: "openai",
      model: "gpt-5",
      createdAt: 1,
      lastActiveAt: 2,
    } as never,
  ],
  messages: [
    { id: 1, chatSessionId: "sess-fork-me", role: "user", content: "Plan the migration", createdAt: 1 } as never,
    { id: 2, chatSessionId: "sess-fork-me", role: "assistant", content: "Here is the plan…", createdAt: 2 } as never,
  ],
  messagesSessionId: "sess-fork-me",
});
useProjectsStore.setState({ projects: [], gitStatuses: {} });

// Mounts the real global keybinding listener so Ctrl+/ takes the exact
// path it takes in the app (capture-phase matchesAccelerator → toggle).
function KeybindingBoot() {
  useKeybindings();
  return null;
}

function Lab() {
  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <KeybindingBoot />
      {/* Minimal chrome: a fake toolbar strip (the app's real fork button
          lives only in the ⋮ menu / command palette). */}
      <div className="toolbar" style={{ position: "relative" }}>
        <span className="toolbar-chat-title">Migrate the exporter to streaming</span>
        <span className="spacer" />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          top: 48,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          padding: 8,
          boxSizing: "border-box",
        }}
        aria-hidden="true"
      >
        <div className="chat-pane chat-pane-main" style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
          <strong style={{ color: "var(--text)" }}>Migrate the exporter to streaming</strong>
          <p style={{ color: "var(--text-dim)", fontSize: 12 }}>main pane (the original chat stays here)</p>
        </div>
        <div className="chat-pane" style={{ border: "1px dashed var(--border)", borderRadius: 12, padding: 16 }}>
          <strong style={{ color: "var(--text-dim)" }}>fork panes land here →</strong>
          <p style={{ color: "var(--text-dim)", fontSize: 12 }}>each fork continues independently</p>
        </div>
      </div>
      <ForkChatModal />
      <HotkeyOverlay />
      {/* The REAL per-message action bar, pinned visible so the fork glyph
          can be judged in context (in the app it hover-reveals under the
          bubble — .chat-bubble:hover .chat-msg-actions). The style tag lifts
          the hover reveal; clicking the fork icon here drives the store
          action with a seeded message id (stub backend resolves null). */}
      <style>{`.harness-pinned .chat-msg-actions { opacity: 1 !important; }`}</style>
      <div className="harness-pinned" style={{ position: "fixed", left: 16, bottom: 16, zIndex: 30 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-dim)", marginBottom: 4 }}>
          MESSAGE BUBBLE ACTION BAR (hover state)
        </div>
        <MessageActions
          content="answer text"
          timestamp="09:07 AM"
          timestampTitle="Turn ended 09:07"
          speakKey="msg:sess-fork-me:2"
          speakLabel="Answer"
          onFork={() => void useChatStore.getState().forkChatToPanes("sess-fork-me", 1, 2)}
          onDelete={() => {}}
        />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Lab />);

(window as unknown as { __harness: Record<string, () => void> }).__harness = {
  openFork: () => useUiStore.getState().openForkChatModal(null),
  openHotkeys: () => useUiStore.getState().setHotkeyOverlayOpen(true),
  closeAll: () =>
    useUiStore.setState({ hotkeyOverlayOpen: false, forkChatModalOpen: false }),
  // Fires the real Ctrl+/ keydown through the app's capture-phase keybinding
  // listener — same wiring as the packaged app.
  pressShortcut: () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "/",
        code: "Slash",
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      }),
    );
  },
  toggleViaPalette: () => useUiStore.getState().toggleHotkeyOverlay(),
};
