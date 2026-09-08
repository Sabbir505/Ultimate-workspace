// Dev-only visual harness: renders the plan surfaces with the REAL components
// and the REAL global CSS cascade, no Tauri backend required. Serve with
// `npx vite` and open http://localhost:1500/plan-preview.html.
//
// Shows the present_plan approval card (PlanProposalCard) docked as a NOTCH
// fused onto the composer — its only render site since the heuristic
// PlanPreview was retired. The composer card below the notch is mocked with
// the same class names (.chat-composer > .chat-composer-card) so the seam
// renders faithfully.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { PlanProposalCard } from "../components/chat/PlanProposalCard";

const PLAN = `## Plan: Trending Sub-9B Models X Post (with Verification)

Here's a plan in the Relay workspace style, written for you to approve before I execute.

1. Research the top trending sub-9B models this week and collect receipts.
2. Draft the X post with the hook, the receipts, and a follow-up CTA.
3. Verify every claim against the linked sources, then render the final card.
4. Ship the post and archive the thread in the documents library.`;

createRoot(document.getElementById("root")!).render(
  <div className="chat-grid-wrap" style={{ height: "100vh" }}>
    <div className="chat-view">
      <div className="chat-messages">
        {/* fake user bubble for transcript context */}
        <div className="chat-bubble user">
          <div className="chat-bubble-inner">
            <div className="chat-markdown">
              <p>Draw an X post about the trending sub-9B models. Plan it first.</p>
            </div>
          </div>
        </div>
        {/* fake assistant reply */}
        <div className="chat-bubble assistant">
          <div className="chat-bubble-inner">
            <div className="chat-markdown">
              <p>Before I touch anything, here's the approach I'll follow — approve it and I'll start.</p>
            </div>
          </div>
        </div>
        {/* spacer standing in for the dock reservation */}
        <div style={{ height: 300, flexShrink: 0 }} />
      </div>

      <div className="chat-composer-dock">
        {/* present_plan proposal, docked notch — same mount + wrapper ChatView uses */}
        <div className="plan-preview">
          <PlanProposalCard
            proposal={{
              pendingId: "p1",
              title: "Plan: Trending Sub-9B Models X Post",
              plan: PLAN,
            }}
            onResolve={() => undefined}
          />
        </div>
        <div className="chat-composer">
          <div className="chat-composer-card">
            <div className="composer-slash-wrap">
              <textarea
                className="chat-composer-textarea"
                placeholder="Write a message…  / for skills · @ for apps"
                rows={1}
                readOnly
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>,
);
