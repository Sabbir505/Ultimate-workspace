// Dev-only visual harness: mounts the REAL activity/tool-call rows, thinking
// blocks, and file-edit rows against the real chat.css so styling regressions
// (glass-rim borders, hover fills, label dimming) can be eyeballed or
// screenshot in isolation. Serve `npx vite`, open
// http://localhost:1500/steps-harness.html.
import "./tauriStub";
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { ActivityStepRow, EditFileRow, ThinkingBlock } from "../components/chat/ActivitySteps";
import type { ActivityStep } from "../components/chat/ActivitySteps";

const readStep: ActivityStep = {
  done: true,
  data: {
    kind: "file",
    title: "Reading file",
    detail: "D:\\artifect\\ml_lessons_history.md",
  },
};

const shellStep: ActivityStep = {
  done: true,
  data: {
    kind: "code",
    title: "Running command",
    code: "git status --short",
  },
};

const writeStep: ActivityStep = {
  done: true,
  data: {
    kind: "file",
    title: "Writing file",
    path: "D:\\artifect\\ml_lessons_history.md",
    edit: {
      mode: "append",
      append: "\n\n## Lesson 12 — attention sinks",
    },
  },
};

function App() {
  return (
    <div
      style={{
        width: 560,
        padding: "20px 24px",
        background: "#1a1c22",
        minHeight: "100vh",
        color: "var(--text)",
      }}
    >
      <h3 style={{ color: "#9aa1ad", font: "600 12px sans-serif" }}>done tool rows</h3>
      <div className="chat-activity-steps">
        <ActivityStepRow step={readStep} done={true} />
        <ActivityStepRow step={shellStep} done={true} />
      </div>

      <h3 style={{ color: "#9aa1ad", font: "600 12px sans-serif", marginTop: 24 }}>
        thinking done vs live
      </h3>
      <ThinkingBlock thinking="The user wants the lessons history loaded. Find the file, read it, then append the new lesson." done={true} />
      <ThinkingBlock thinking="Streaming reasoning tail so the live shine state stays comparable." done={false} />

      <h3 style={{ color: "#9aa1ad", font: "600 12px sans-serif", marginTop: 24 }}>
        file-edit row
      </h3>
      <EditFileRow step={writeStep} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
