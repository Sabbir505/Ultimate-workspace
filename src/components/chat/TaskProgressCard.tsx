// Live progress card for background chat tasks (download_file / run_shell).
// Fed by `chat:task-progress` events from chat/tasks.rs; renders a compact
// card matching the approval-card style: a kind badge + the task message +
// (for downloads) a progress bar with percent/speed. Completed/failed/
// cancelled states collapse to a status line.
//
// A finished task's card used to sit in the chat for the rest of the session —
// the DOWNLOAD badge and its "Downloading…" label frozen at whatever the last
// progress event said, long after the file was on disk. Successes now fade
// themselves out and leave; failures stay put (they carry the error the user
// needs) but are click-to-dismiss.
import { useCallback, useEffect, useState } from "react";
import { useChatStore, type ChatTaskProgress } from "../../state/chat";

/** How long a finished card lingers before it starts fading, and how long the
 *  fade itself runs. Both must stay >= the CSS transition in settings.css. */
const DONE_DWELL_MS = 2200;
const FADE_MS = 320;

/** Short human bytes ("1.2 GB") — mirrors backend human_bytes. */
function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let unit = 0;
  while (v >= 1024 && unit < units.length - 1) {
    v /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[unit]}`;
}

/** "3.1 MB/s" from a bytes/sec figure. */
function humanSpeed(bps: number): string {
  if (bps <= 0) return "";
  return `${humanBytes(bps)}/s`;
}

function fileName(destPath: string | null): string {
  if (!destPath) return "";
  const parts = destPath.split(/[\\/]/);
  return parts[parts.length - 1] || destPath;
}

/** A compact progress card for one background task. Running downloads show a
 *  live bar; terminals show a status chip + one-line result. */
export function TaskProgressCard({
  task,
  chatSessionId,
}: {
  task: ChatTaskProgress;
  /** Owning session — the store keys tasks by it, and removal needs it. */
  chatSessionId: string;
}) {
  const percent = task.total ? Math.min(100, (task.downloaded / task.total) * 100) : null;
  const running = task.state === "running";
  const terminal = !running;
  // Only a clean finish auto-dismisses. `failed` / `cancelled` stay until the
  // user clicks them away — the card is where that error is readable.
  const autoDismiss = task.state === "completed";
  const badge = task.kind === "download" ? "DOWNLOAD" : "RUN";

  const removeTask = useChatStore((s) => s.removeTask);
  const [leaving, setLeaving] = useState(false);

  const dismiss = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => removeTask(chatSessionId, task.taskId), FADE_MS);
  }, [chatSessionId, removeTask, task.taskId]);

  // Keep a slow tick so the speed readout feels live even between events.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  // Success → dwell, then fade, then leave. A re-run of the same task id
  // resets `leaving` so the card comes back instead of vanishing mid-flight.
  useEffect(() => {
    if (!autoDismiss) return;
    const t = window.setTimeout(dismiss, DONE_DWELL_MS);
    return () => window.clearTimeout(t);
  }, [autoDismiss, dismiss]);
  useEffect(() => {
    if (running) setLeaving(false);
  }, [running]);

  return (
    <div
      className={`task-card task-card-${task.kind}${leaving ? " task-card-leaving" : ""}`}
      role="status"
      onClick={terminal ? dismiss : undefined}
      title={terminal ? "Dismiss" : undefined}
      style={terminal ? { cursor: "pointer" } : undefined}
    >
      <span className="task-card-badge">{badge}</span>
      <div className="task-card-body">
        <div className="task-card-title">
          {running
            ? fileName(task.destPath) || (task.kind === "shell" ? "Running command…" : "Downloading…")
            : task.state}
        </div>
        {running && task.kind === "download" && (
          <div className="task-card-bar">
            <div className="task-card-bar-fill" style={{ width: `${percent ?? 0}%` }} />
          </div>
        )}
        <div className="task-card-meta">
          {running && task.kind === "download" && percent !== null
            ? `${percent.toFixed(0)}% — ${humanBytes(task.downloaded)} of ${humanBytes(task.total ?? 0)}${humanSpeed(task.speedBps) ? ` · ${humanSpeed(task.speedBps)}` : ""}`
            : running && task.kind === "shell"
              ? "Streaming output…"
              : task.message}
        </div>
      </div>
    </div>
  );
}
