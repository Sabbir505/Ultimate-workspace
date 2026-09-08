// Dev-only visual harness: mounts the REAL ChatComposer (no Tauri backend)
// inside a chat-view-like dock so the command deck's portal anchoring can be
// measured in a real browser. Serve `npx vite`, open
// http://localhost:1500/composer-deck-harness.html, type "/" in the box.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { ChatComposer } from "../components/chat/ChatComposer";

createRoot(document.getElementById("root")!).render(
  <div className="chat-grid-wrap" style={{ height: "100vh" }}>
    <div className="chat-view" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="chat-messages">
        <div className="chat-welcome">
          <div className="chat-welcome-inner">
            <div className="chat-welcome-greeting">Good evening</div>
          </div>
        </div>
        <div style={{ height: 120, flexShrink: 0 }} />
      </div>
      <div className="chat-composer-dock">
        <ChatComposer
          sessionId="s1"
          onSend={() => undefined}
          onStop={() => undefined}
          streaming={false}
          agent="builtin"
          onAgentModelPick={() => undefined}
        />
      </div>
    </div>
  </div>,
);
