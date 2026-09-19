// Dev-only visual harness: the harness QUESTION card under the REAL pane
// conditions — a size-container `.chat-pane` at a split-pane width, WITH a
// `.turn-rail` mounted (the rail clearance rule indents .chat-composer's
// left padding to 30px), dock static per split mode. Serve with `npx vite`
// and open http://localhost:1500/question-harness.html.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { QuestionCard } from "../components/chat/QuestionCard";
import { ThinkingBlock } from "../components/chat/ActivitySteps";

const QUESTION = {
  question: 'Is "ultimate workspace" a domain idea for Relay, or are you considering renaming the product itself?',
  options: [
    { label: "Just a domain idea" },
    { label: "Considering a rename" },
    { label: "It's a tagline" },
    { label: "Price the aftermarket instead" },
  ],
};

createRoot(document.getElementById("root")!).render(
  <div className="chat-grid-wrap split-active" style={{ height: "100vh", display: "flex" }}>
    <div className="chat-pane-grid" style={{ flex: 1 }}>
      <div className="chat-pane" id="pane" style={{ width: 560 }}>
        <div className="chat-view-wrap">
          {/* turn rail stand-in: the :has(.turn-rail) clearance rule keys off
              its EXISTENCE, not its contents */}
          <div className="turn-rail" data-session="harness" />
          <div className="chat-view">
            <div className="chat-messages">
              <div className="chat-bubble assistant">
                <div className="chat-bubble-inner">
                  <div className="chat-markdown">
                    <p>Before I go further — answer the question docked below.</p>
                  </div>
                  {/* thinking disclosure states: streaming-collapsed (tail
                      rides the row) and done-collapsed (head as summary) */}
                  <ThinkingBlock
                    thinking={"The user is asking about a domain idea vs a rename. Let me weigh both: a domain is cheap to change later, a rename touches every surface. The screenshot shows a split pane, so the card must stay aligned with the composer. I should check the rail clearance rule before answering."}
                    done={false}
                  />
                  <ThinkingBlock
                    thinking={"Domain idea first — rename later if the product outgrows it. The card misalignment came from the turn-rail clearance not reaching the docked notch."}
                    done
                  />
                </div>
              </div>
              <div className="chat-bubble user">
                <div className="chat-bubble-inner">
                  <div className="chat-markdown">
                    <p>User message for transcript context.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="chat-composer-dock" id="dock">
              <div className="plan-preview" id="plan-preview">
                <QuestionCard
                  question={{ pendingId: "q1", questions: [QUESTION] }}
                  onResolve={() => undefined}
                />
              </div>
              <div className="chat-composer" id="composer">
                <div className="chat-composer-card" id="composer-card">
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
        </div>
      </div>
    </div>
  </div>,
);
