// Automations view: master-detail layout for scheduled headless agent runs.
// Left: automation list with status badges + "New automation" button.
// Right: detail view with controls (pause/resume, run now, edit, delete),
// schedule display, and a "Past Runs" table.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Bell,
  CheckCircle2,
  Edit3,
  ExternalLink,
  Hourglass,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  PlaySquare,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import {
  automationNextFire,
  getRunWhileClosed,
  getSetting,
  listAutomationRuns,
  listChatModels,
  scanLocalModels,
  listHarnessModels,
  setRunWhileClosed,
  setSetting,
  testAutomationWebhook,
  toastError,
  toastSuccess,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type HarnessModelConfig,
  type GgufModel,
} from "../../lib/ipc";
import { useAutomationsStore } from "../../state/automations";
import { useProjectsStore } from "../../state/projects";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { useChatStore } from "../../state/chat";
import {
  AUTOMATION_STATE_META,
  automationState,
  friendlyRunError,
  isFailureStatus,
  type AutomationStateKey,
} from "./shared";

const AutomationRunTable = lazy(() =>
  import("./AutomationRunTable").then((m) => ({ default: m.AutomationRunTable }))
);

const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Hourly", cron: "7 * * * *" },
  { label: "Daily at 9:00 AM", cron: "2 9 * * *" },
  { label: "Weekdays at 9:00 AM", cron: "2 9 * * 1-5" },
  { label: "Nightly at 2:00 AM", cron: "1 2 * * *" },
];

/** Agent options: harnesses first, then API providers, then local. */
const AGENT_OPTIONS: { id: string; label: string; group: "harness" | "api" | "local" }[] = [
  // Harnesses
  { id: "claude_code", label: "Claude Code (harness)", group: "harness" },
  { id: "opencode", label: "OpenCode (harness)", group: "harness" },
  // API providers
  { id: "anthropic", label: "Anthropic API", group: "api" },
  { id: "openai", label: "OpenAI API", group: "api" },
  { id: "openrouter", label: "OpenRouter", group: "api" },
  { id: "anthropic_compatible", label: "Anthropic-compatible", group: "api" },
  { id: "openai_compatible", label: "OpenAI-compatible", group: "api" },
  // Local
  { id: "local_gguf", label: "Local GGUF", group: "local" },
];

function agentGroupLabel(group: string): string {
  if (group === "harness") return "CLI Agents";
  if (group === "api") return "Cloud APIs";
  return "Local";
}

const WEEKDAYS: { dow: string; label: string }[] = [
  { dow: "1", label: "Monday" },
  { dow: "2", label: "Tuesday" },
  { dow: "3", label: "Wednesday" },
  { dow: "4", label: "Thursday" },
  { dow: "5", label: "Friday" },
  { dow: "6", label: "Saturday" },
  { dow: "0", label: "Sunday" },
];

type Freq = "daily" | "weekdays" | "weekly";

// ---- Cron helpers ----

function parseSimpleCron(cron: string): { freq: Freq; weekday: string; time: string } | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/.exec(cron.trim());
  if (!m) return null;
  const [, min, hour, dow] = m;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dow === "*") return { freq: "daily", weekday: "1", time };
  if (dow === "1-5") return { freq: "weekdays", weekday: "1", time };
  return { freq: "weekly", weekday: dow === "7" ? "0" : dow, time };
}

function buildCron(freq: Freq, weekday: string, time: string): string {
  const [h, m] = time.split(":").map((s) => parseInt(s, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  const dow = freq === "daily" ? "*" : freq === "weekdays" ? "1-5" : weekday;
  return `${m} ${h} * * ${dow}`;
}

function formatTimeAmPm(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function scheduleLabel(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron)?.label;
  if (preset) return preset;
  const parsed = parseSimpleCron(cron);
  if (!parsed) return cron;
  const t = formatTimeAmPm(parsed.time);
  if (parsed.freq === "daily") return `Daily at ${t}`;
  if (parsed.freq === "weekdays") return `Weekdays at ${t}`;
  const day = WEEKDAYS.find((w) => w.dow === parsed.weekday)?.label ?? "";
  return `${day}s at ${t}`;
}

function relativeTime(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** "Today at 6:30 PM" / "Tomorrow at …" / "Friday at …" / "Aug 29 at …". */
function formatNextFire(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (date: Date) => date.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (day(d) === day(now)) return `Today at ${time}`;
  if (day(d) === day(tomorrow)) return `Tomorrow at ${time}`;
  const daysOut = Math.round((d.setHours(12, 0, 0, 0) - now.setHours(12, 0, 0, 0)) / 86400000);
  if (daysOut < 7) {
    const weekday = new Date(ts * 1000).toLocaleDateString(undefined, { weekday: "long" });
    return `${weekday} at ${time}`;
  }
  const date = new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date} at ${time}`;
}

function statusColor(status: string | null): string {
  if (status === "ok") return "var(--green, #4caf7d)";
  if (status === "skipped") return "var(--yellow, #f0ad4e)";
  if (status === "running") return "var(--blue, #2196f3)";
  if (status) return "var(--red, #ff6b6b)";
  return "var(--text-dim)";
}

function statusLabel(status: string | null): string {
  if (status === "ok") return "OK";
  if (status === "skipped") return "Skipped";
  if (status === "running") return "Running";
  if (status) return "Error";
  return "—";
}

// ---- Main view ----

const EDIT_PREFIX = "__edit__:";

export function AutomationsView() {
  const automations = useAutomationsStore((s) => s.automations);
  const loaded = useAutomationsStore((s) => s.loaded);
  const load = useAutomationsStore((s) => s.load);
  const runningNow = useAutomationsStore((s) => s.runningNow);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const pendingArtifactFormData = useUiStore((s) => s.pendingArtifactFormData);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (loaded && !selectedId && automations.length > 0 && !showNewForm) {
      setSelectedId(automations[0].id);
    }
  }, [loaded, automations, selectedId, showNewForm]);

  // The parent owns only visibility. AutomationForm consumes and clears the
  // payload after applying the fields, then resets the originating card.
  useEffect(() => {
    if (pendingArtifactFormData?.artifactType === "automation") {
      setShowNewForm(true);
      setSelectedId(null);
    }
  }, [pendingArtifactFormData]);

  const selected = automations.find((a) => a.id === selectedId) ?? null;
  const editingId = selectedId?.startsWith(EDIT_PREFIX)
    ? selectedId.slice(EDIT_PREFIX.length)
    : null;
  const editingAutomation = editingId
    ? automations.find((a) => a.id === editingId) ?? null
    : null;

  const stateOf = useCallback(
    (a: Automation) => automationState(a, !!runningNow[a.id]),
    [runningNow],
  );
  const activeCount = automations.filter((a) => a.enabled).length;
  const healthyCount = automations.filter((a) => stateOf(a) === "healthy").length;
  const failingCount = automations.filter((a) => stateOf(a) === "failing").length;

  return (
    <div className="automations-view">
      {/* Header */}
      <div className="automations-header">
        <div className="automations-header-left">
          <CalendarClock size={20} strokeWidth={1.8} />
          <h1>Automations</h1>
          {loaded && automations.length > 0 && (
            <span className="automations-header-metrics">
              <span className="automations-header-badge">
                <strong>{automations.length}</strong> total
              </span>
              <span className="automations-header-badge">
                <strong>{activeCount}</strong> active
              </span>
              <span className="automations-header-badge healthy">
                <strong>{healthyCount}</strong> healthy
              </span>
              {failingCount > 0 && (
                <span className="automations-header-badge failing">
                  <strong>{failingCount}</strong> failing
                </span>
              )}
            </span>
          )}
        </div>
        <div className="automations-header-right">
          <RunWhileClosedToggle />
          <NotifySettingsButton />
          <button
            className="automations-btn ghost"
            onClick={() => { void load(); }}
            title="Refresh"
          >
            <RefreshCw size={14} strokeWidth={2} />
          </button>
          <button
            onClick={() => setActiveView("chat")}
            className="automations-btn ghost"
            title="Back to chat"
          >
            ← Back to chat
          </button>
        </div>
      </div>

      {/* Body */}
      {loaded && automations.length === 0 && !showNewForm ? (
        /* Empty state */
        <div className="automations-empty">
          <PlaySquare size={48} strokeWidth={1.5} />
          <h3>No automations scheduled yet</h3>
          <p>Schedule headless agent runs on a cron schedule — they fire while Conduit is open, or anytime with "Run while closed".</p>
          <button
            onClick={() => setShowNewForm(true)}
            className="automations-btn primary"
          >
            <Plus size={16} strokeWidth={2} /> Create your first automation
          </button>
        </div>
      ) : (
        <div className="automations-body">
          {/* Left pane */}
          <div className="automations-list-pane">
            <div className="automations-list-header">
              <button
                onClick={() => { setShowNewForm(true); setSelectedId(null); }}
                className="automations-btn primary"
              >
                <Plus size={14} strokeWidth={2} /> New
              </button>
            </div>
            <div className="automations-list-scroll">
              {automations.map((a) => {
                const isSelected = a.id === selectedId && !showNewForm && !editingId;
                const state = stateOf(a);
                return (
                  <button
                    key={a.id}
                    onClick={() => { setSelectedId(a.id); setShowNewForm(false); }}
                    className={`automations-list-row${isSelected ? " selected" : ""}`}
                  >
                    <div className="automations-list-row-top">
                      {!a.enabled ? (
                        <XCircle size={14} strokeWidth={2} className="automations-list-status paused" />
                      ) : state === "failing" ? (
                        <AlertTriangle size={14} strokeWidth={2} className="automations-list-status failing" />
                      ) : (
                        <PlayCircle size={14} strokeWidth={2} className="automations-list-status running" />
                      )}
                      <span className="automations-list-name">{a.name}</span>
                    </div>
                    <div className="automations-list-row-meta">
                      <span>{scheduleLabel(a.schedule)}</span>
                      <span>·</span>
                      <span>{relativeTime(a.lastRunAt)}</span>
                      {state === "failing" ? (
                        // Label instead of the dot — a bare red dot plus the
                        // word "Failing" said the same thing twice.
                        <>
                          <span>·</span>
                          <span className="automations-list-failing">Failing</span>
                        </>
                      ) : (
                        <span
                          className="automations-list-dot"
                          style={{ background: AUTOMATION_STATE_META[state].color }}
                          title={AUTOMATION_STATE_META[state].label}
                        />
                      )}
                    </div>
                  </button>
                );
              })}
              {automations.length === 0 && (
                <div className="automations-list-empty">No automations yet</div>
              )}
            </div>
          </div>

          {/* Right pane */}
          <div className="automations-detail-pane">
            {showNewForm ? (
              <AutomationForm
                automation={null}
                onClose={() => setShowNewForm(false)}
                onCreated={(id) => { setSelectedId(id); setShowNewForm(false); }}
              />
            ) : editingAutomation ? (
              <AutomationForm
                automation={editingAutomation}
                onClose={() => setSelectedId(editingAutomation.id)}
              />
            ) : selected ? (
              <AutomationDetail
                automation={selected}
                onDeleted={() => setSelectedId(null)}
                onEdit={() => setSelectedId(`${EDIT_PREFIX}${selected.id}`)}
              />
            ) : (
              <div className="automations-detail-empty">
                <Zap size={32} strokeWidth={1.5} />
                <p>Select an automation or create a new one</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Header controls ----

/** "Run while closed" — registers/unregisters the global `ConduitAutomations`
 *  Task Scheduler entry that fires `conduit-automation run-due` every minute.
 *  One task covers every enabled automation; the registered state is read
 *  back from Task Scheduler itself so the UI can't drift from reality. */
export function RunWhileClosedToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getRunWhileClosed()
      .then(setOn)
      .catch(() => setOn(null));
  }, []);

  const toggle = async () => {
    if (on === null || busy) return;
    const next = !on;
    setBusy(true);
    try {
      await setRunWhileClosed(next);
      setOn(next);
      if (next) {
        toastSuccess(
          "Runs while closed: on",
          "Task Scheduler fires every minute — due automations run headless.",
        );
      }
    } catch (err) {
      toastError("Couldn't change run-while-closed", err);
    } finally {
      setBusy(false);
    }
  };

  if (on === null) return null; // still querying (or the query failed)
  return (
    <label
      className={`automations-rwc${on ? " on" : ""}`}
      title="Run automations while Conduit is closed (Windows Task Scheduler)"
    >
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={() => void toggle()}
        aria-label="Run while closed"
      />
      <Power size={13} strokeWidth={2} />
      <span>Run while closed</span>
    </label>
  );
}

/** Bell popover: notification settings for automation runs — the webhook URL
 *  (+ test button) and the email-on-failure toggle. Failure toasts while the
 *  app is open are always on and follow the global Do Not Disturb setting. */
export function NotifySettingsButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [webhook, setWebhook] = useState("");
  const [emailOn, setEmailOn] = useState(true);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    void getSetting("automations.webhookUrl")
      .then((v) => setWebhook(v ?? ""))
      .catch(() => {});
    void getSetting("automations.emailOnFailure")
      .then((v) => setEmailOn(v !== "false"))
      .catch(() => {});
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const saveWebhook = () => {
    void setSetting("automations.webhookUrl", webhook.trim()).catch((e) =>
      toastError("Couldn't save webhook URL", e),
    );
  };
  const toggleEmail = (next: boolean) => {
    setEmailOn(next);
    void setSetting("automations.emailOnFailure", String(next)).catch((e) =>
      toastError("Couldn't save setting", e),
    );
  };
  const test = async () => {
    setTesting(true);
    try {
      await testAutomationWebhook();
      toastSuccess("Test notification sent");
    } catch (err) {
      toastError("Webhook test failed", err);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="automations-notify-wrap" ref={wrapRef}>
      <button
        className="automations-btn ghost"
        onClick={() => setOpen((o) => !o)}
        title="Automation notifications"
        aria-label="Automation notifications"
        aria-expanded={open}
      >
        <Bell size={14} strokeWidth={2} />
      </button>
      {open && (
        <div className="automations-notify-panel">
          <div className="automations-notify-title">Notifications</div>
          <p className="automations-notify-hint">
            While Conduit is open, failed runs show an OS toast (follows Do Not Disturb)
            and a paired phone gets an alert.
          </p>
          <label className="automations-notify-field">
            <span>Webhook URL</span>
            <input
              type="text"
              value={webhook}
              placeholder="https://hooks.slack.com/…"
              onChange={(e) => setWebhook(e.target.value)}
              onBlur={saveWebhook}
            />
          </label>
          <p className="automations-notify-hint">
            POSTed on every completed run — the only channel that fires while
            Conduit is fully closed.
          </p>
          <div className="automations-notify-row">
            <button
              className="automations-btn ghost"
              onClick={() => void test()}
              disabled={testing || !webhook.trim()}
            >
              {testing ? "Sending…" : "Send test"}
            </button>
          </div>
          <label className="automations-notify-check">
            <input
              type="checkbox"
              checked={emailOn}
              onChange={(e) => toggleEmail(e.target.checked)}
            />
            <span>Email me on failure (Gmail connector)</span>
          </label>
        </div>
      )}
    </div>
  );
}

// ---- Detail view ----

function AutomationDetail({
  automation,
  onDeleted,
  onEdit,
}: {
  automation: Automation;
  onDeleted: () => void;
  onEdit: () => void;
}) {
  const remove = useAutomationsStore((s) => s.remove);
  const setEnabled = useAutomationsStore((s) => s.setEnabled);
  const runNow = useAutomationsStore((s) => s.runNow);
  const runningNow = useAutomationsStore((s) => s.runningNow);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const selectSession = useChatStore((s) => s.selectSession);
  const loadSessions = useChatStore((s) => s.loadSessions);

  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [nextRunAt, setNextRunAt] = useState<number | null | undefined>(undefined);

  const refreshRuns = useCallback(async () => {
    setRunsLoading(true);
    setRunError(null);
    try {
      const r = await listAutomationRuns(automation.id, 100);
      setRuns(r ?? []);
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunsLoading(false);
    }
  }, [automation.id]);

  useEffect(() => {
    void refreshRuns();
    const interval = window.setInterval(() => void refreshRuns(), 5000);
    return () => window.clearInterval(interval);
  }, [refreshRuns]);

  useEffect(() => {
    if (runningNow[automation.id]) void refreshRuns();
  }, [runningNow, automation.id, refreshRuns]);

  // Next scheduled fire — same math the scheduler uses for due-ness, so the
  // display can't drift from what will actually run. Recomputed when the
  // schedule changes and every minute (the "Today/Tomorrow" framing ages).
  useEffect(() => {
    if (!automation.enabled) { setNextRunAt(undefined); return; }
    let cancelled = false;
    const fetchNext = () => {
      void automationNextFire(automation.schedule)
        .then((t) => { if (!cancelled) setNextRunAt(t ?? null); })
        .catch(() => { if (!cancelled) setNextRunAt(null); });
    };
    fetchNext();
    const interval = window.setInterval(fetchNext, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [automation.enabled, automation.id, automation.schedule]);

  // How many most-recent runs failed with the exact same error — powers the
  // "failed N times in a row" banner copy.
  const consecutiveFailures = useMemo(() => {
    let n = 0;
    for (const r of runs) {
      if (r.status === automation.lastStatus) n++;
      else break;
    }
    return n;
  }, [runs, automation.lastStatus]);

  const handleRunNow = useCallback(async () => {
    setRunError(null);
    try {
      await runNow(automation.id);
      window.setTimeout(() => void refreshRuns(), 500);
    } catch (e) {
      setRunError(String(e));
    }
  }, [automation.id, runNow, refreshRuns]);

  const handleToggleEnabled = useCallback(async () => {
    setRunError(null);
    try {
      await setEnabled(automation.id, !automation.enabled);
    } catch (e) {
      setRunError(String(e));
    }
  }, [automation.id, automation.enabled, setEnabled]);

  const handleOpenRunLog = useCallback(
    async (chatSessionId: string) => {
      await loadSessions();
      await selectSession(chatSessionId);
      setActiveView("chat");
    },
    [loadSessions, selectSession, setActiveView],
  );

  const handleDelete = useCallback(() => {
    if (window.confirm("Delete this automation? Past run history is kept.")) {
      void remove(automation.id).then(onDeleted);
    }
  }, [automation.id, remove, onDeleted]);

  return (
    <div className="automation-detail">
      {/* Detail header */}
      <div className="automation-detail-header">
        <div className="automation-detail-title-row">
          <h2>{automation.name}</h2>
          {(() => {
            const state = automationState(automation, !!runningNow[automation.id]);
            const meta = AUTOMATION_STATE_META[state];
            const icon =
              state === "healthy" ? <CheckCircle2 size={11} strokeWidth={2.5} /> :
              state === "failing" ? <XCircle size={11} strokeWidth={2.5} /> :
              state === "running" ? <Loader2 size={11} strokeWidth={2.5} className="animate-spin" /> :
              state === "paused" ? <Pause size={11} strokeWidth={2.5} /> :
              <Hourglass size={11} strokeWidth={2.5} />;
            return (
              <span
                className={`automation-status-pill ${state}`}
                title={meta.label}
                style={state === "never" ? undefined : { color: meta.color }}
              >
                {icon} {meta.label}
              </span>
            );
          })()}
        </div>
        {(() => {
          // Long prompts are collapsed to 3 lines — the prompt is config,
          // not prose, and shouldn't push the schedule/runs below the fold.
          if (automation.prompt.length <= 220) {
            return <p className="automation-detail-prompt">{automation.prompt}</p>;
          }
          return (
            <>
              <p className={`automation-detail-prompt${promptExpanded ? "" : " collapsed"}`}>
                {automation.prompt}
              </p>
              <button
                className="automation-detail-prompt-toggle"
                onClick={() => setPromptExpanded((e) => !e)}
              >
                {promptExpanded ? "Show less" : "Show more"}
              </button>
            </>
          );
        })()}
        <div className="automation-detail-meta">
          <span>{AGENT_OPTIONS.find((a) => a.id === automation.harness)?.label ?? automation.harness}</span>
          {automation.model && <><span>·</span><span>{automation.model}</span></>}
          {automation.cwd && <><span>·</span><span className="automation-detail-cwd" title={automation.cwd}>{automation.cwd.split(/[/\\]/).pop()}</span></>}
        </div>
      </div>

      {/* Controls */}
      <div className="automation-detail-controls">
        <button
          onClick={() => void handleToggleEnabled()}
          className={`automations-btn ${automation.enabled ? "outline" : "success"}`}
        >
          {automation.enabled ? (
            <><Pause size={13} strokeWidth={2} /> Pause</>
          ) : (
            <><Play size={13} strokeWidth={2} /> Resume</>
          )}
        </button>
        <button
          onClick={() => void handleRunNow()}
          disabled={!automation.enabled || !!runningNow[automation.id]}
          className="automations-btn primary"
        >
          {runningNow[automation.id] ? (
            <><Loader2 size={13} strokeWidth={2} className="animate-spin" /> Running…</>
          ) : (
            <><Play size={13} strokeWidth={2} /> Run now</>
          )}
        </button>
        <button onClick={onEdit} className="automations-btn ghost" title="Edit">
          <Edit3 size={14} strokeWidth={1.8} />
        </button>
        {automation.chatSessionId && (
          <button
            onClick={() => void handleOpenRunLog(automation.chatSessionId!)}
            className="automations-btn ghost"
            title="Open run log"
          >
            <ExternalLink size={14} strokeWidth={1.8} />
          </button>
        )}
        <div className="automation-detail-spacer" />
        <button onClick={handleDelete} className="automations-btn ghost danger" title="Delete">
          <Trash2 size={14} strokeWidth={1.8} />
        </button>
      </div>

      {runError && (
        <div className="automation-detail-error">{runError}</div>
      )}

      {/* Failure banner — surfaces the last run's outcome without making the
          user scan the runs table; raw errors are translated to plain
          language with a suggested next step. */}
      {isFailureStatus(automation.lastStatus) && !runError && (() => {
        const friendly = friendlyRunError(automation.lastStatus!);
        return (
          <div className="automation-detail-banner">
            <AlertTriangle size={15} strokeWidth={2} className="automation-detail-banner-icon" />
            <div className="automation-detail-banner-text">
              <strong>
                Last run failed
                {consecutiveFailures > 1 ? ` — ${consecutiveFailures}× in a row` : ""}
              </strong>
              <span>
                {friendly.text}
                {friendly.hint ? ` ${friendly.hint}` : ""}
              </span>
            </div>
            {automation.enabled && (
              <button
                onClick={() => void handleRunNow()}
                disabled={!!runningNow[automation.id]}
                className="automations-btn automation-detail-banner-action"
              >
                {runningNow[automation.id] ? (
                  <><Loader2 size={13} strokeWidth={2} className="animate-spin" /> Running…</>
                ) : (
                  <><Play size={13} strokeWidth={2} /> Run again</>
                )}
              </button>
            )}
          </div>
        );
      })()}

      {/* Schedule card */}
      <div className="automation-detail-schedule">
        <div className="automation-detail-schedule-label">AUTOMATION</div>
        <div className="automation-detail-schedule-value">
          {scheduleLabel(automation.schedule)}
          <code className="automation-detail-schedule-cron">{automation.schedule}</code>
        </div>
        <div className="automation-detail-schedule-info">
          {automation.enabled && nextRunAt != null && (
            <>Next run: {formatNextFire(nextRunAt)}<br /></>
          )}
          Last run: {relativeTime(automation.lastRunAt)}
          {automation.lastStatus && (
            <span style={{ color: statusColor(automation.lastStatus), marginLeft: 8 }}>
              · {statusLabel(automation.lastStatus)}
            </span>
          )}
        </div>
      </div>

      {/* Past runs */}
      <div className="automation-detail-runs">
        <Suspense
          fallback={
            <div className="automations-loading">
              <Loader2 size={16} className="animate-spin" /> Loading runs…
            </div>
          }
        >
          <AutomationRunTable
            runs={runs}
            loading={runsLoading}
            onOpenRunLog={handleOpenRunLog}
          />
        </Suspense>
      </div>
    </div>
  );
}

// ---- Create / Edit form ----

function AutomationForm({
  automation,
  onClose,
  onCreated,
}: {
  automation: Automation | null;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const create = useAutomationsStore((s) => s.create);
  const update = useAutomationsStore((s) => s.update);
  const projects = useProjectsStore((s) => s.projects);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const pendingArtifactFormData = useUiStore((s) => s.pendingArtifactFormData);
  const setPendingArtifactFormData = useUiStore((s) => s.setPendingArtifactFormData);

  const [name, setName] = useState(automation?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [agentId, setAgentId] = useState(automation?.harness ?? "claude_code");
  const [model, setModel] = useState(automation?.model ?? "");
  const [cwd, setCwd] = useState(automation?.cwd ?? "");
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const parsedCustom = automation ? parseSimpleCron(automation.schedule) : null;
  // Is the stored cron representable by the preset list or the custom
  // (freq/weekday/time) builder? If NOT (e.g. `*/10 * * * *` or `0 9 * * 2-6`),
  // keep the original cron as its own selectable option — falling back to
  // "custom" would silently rewrite the schedule to the DEFAULT (weekdays
  // 09:00) on save, and unattended runs would fire at the wrong time.
  const keepOriginalCron =
    automation != null &&
    !SCHEDULE_PRESETS.some((p) => p.cron === automation.schedule) &&
    parsedCustom == null;
  const [scheduleChoice, setScheduleChoice] = useState<string>(
    automation
      ? (SCHEDULE_PRESETS.find((p) => p.cron === automation.schedule)?.cron ??
        (keepOriginalCron ? automation.schedule : "custom"))
      : SCHEDULE_PRESETS[3].cron,
  );
  const [freq, setFreq] = useState<Freq>(parsedCustom?.freq ?? "weekdays");
  const [weekday, setWeekday] = useState(parsedCustom?.weekday ?? "1");
  const [time, setTime] = useState(parsedCustom?.time ?? "09:00");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Set form data — called by conversational artifact creation when "Edit" is clicked
  // on an automation proposal card. The spec provides the artifact name,
  // description, and trigger/schedule to pre-fill the form.
  const setAutomationFormData = useCallback((spec: any) => {
    setName(spec.name || "");
    setPrompt(spec.description || "");
    if (spec.trigger?.schedule) {
      setScheduleChoice(spec.trigger.schedule);
    }
  }, []);

  // Consume pending form data from conversational artifact creation
  useEffect(() => {
    if (pendingArtifactFormData && pendingArtifactFormData.artifactType === "automation") {
      const { chatSessionId, proposalId } = pendingArtifactFormData;
      setAutomationFormData(pendingArtifactFormData.spec);
      setPendingArtifactFormData(null);
      if (chatSessionId && proposalId) {
        useChatStore.getState().updateArtifactProposal(chatSessionId, proposalId, { state: "ready" });
      }
    }
  }, [pendingArtifactFormData, setAutomationFormData, setPendingArtifactFormData]);

  const agent = AGENT_OPTIONS.find((a) => a.id === agentId);
  const isHarness = agent?.group === "harness";
  const isApi = agent?.group === "api";
  const isLocal = agent?.group === "local";

  // Fetch available models when the agent changes
  useEffect(() => {
    let cancelled = false;
    const fetchModels = async () => {
      setModelsLoading(true);
      setAvailableModels([]);
      try {
        if (isHarness) {
          const cfg = await listHarnessModels(agentId);
          if (!cancelled && cfg) {
            const list = cfg.models.map((m) => ({ id: m.id, label: m.label }));
            setAvailableModels(list);
            // No auto-select: Model is optional and empty means "harness
            // default". Pre-pinning a model made users unknowingly override
            // whatever the harness is configured with.
          }
        } else if (isApi) {
          const list = await listChatModels(agentId);
          if (!cancelled && list) {
            const deduped = [...new Set(list.map((m) => m.id))];
            setAvailableModels(deduped.map((id) => ({ id, label: id })));
          }
        } else if (isLocal) {
          const list = await scanLocalModels();
          if (!cancelled && list) {
            setAvailableModels(list.map((m) => ({ id: m.id, label: m.name || m.filename })));
          }
        }
      } catch {
        // model listing failed — keep the free-text input available
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };
    void fetchModels();
    return () => { cancelled = true; };
  }, [agentId, isHarness, isApi, isLocal]);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const schedule = scheduleChoice === "custom" ? buildCron(freq, weekday, time) : scheduleChoice;
  const canSave = useMemo(
    () => name.trim() !== "" && prompt.trim() !== "" && schedule !== "",
    [name, prompt, schedule],
  );

  // Live "next run" preview for the chosen schedule (debounced — recomputed
  // on every keystroke of a custom time would otherwise spam the backend).
  // Falls back to the static human-readable label if the query fails.
  const [previewNextAt, setPreviewNextAt] = useState<number | null>(null);
  useEffect(() => {
    if (!schedule) { setPreviewNextAt(null); return; }
    let cancelled = false;
    setPreviewNextAt(null);
    const handle = window.setTimeout(() => {
      void automationNextFire(schedule)
        .then((t) => { if (!cancelled && t) setPreviewNextAt(t); })
        .catch(() => {});
    }, 250);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [schedule]);

  const save = async () => {
    const input: AutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      harness: agentId,
      model: model || undefined,
      cwd: cwd || undefined,
      schedule,
      enabled: automation?.enabled ?? true,
    };
    setSaving(true);
    setError(null);
    try {
      if (automation) {
        await update(automation.id, input);
        onClose();
      } else {
        const created = await create(input);
        if (!created) throw new Error("Failed to create automation");
        onCreated?.(created.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canSave && !saving) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="automation-form" onKeyDown={handleKeyDown}>
      <div className="automation-form-header">
        <h3>{automation ? "Edit automation" : "New automation"}</h3>
        <button onClick={onClose} className="automations-btn ghost" title="Close">✕</button>
      </div>

      <div className="automation-form-body">
        <div className="automation-form-field">
          <label>Name</label>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly test fix"
          />
        </div>

        <div className="automation-form-field">
          <label>Prompt</label>
          <textarea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Run the test suite, fix any failing test, and summarize what you changed."
          />
        </div>

        <div className="automation-form-row">
          <div className="automation-form-field">
            <label>Agent</label>
            <select
              value={agentId}
              onChange={(e) => { setAgentId(e.target.value); setModel(""); }}
            >
              <optgroup label="CLI Agents">
                {AGENT_OPTIONS.filter((a) => a.group === "harness").map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </optgroup>
              <optgroup label="Cloud APIs">
                {AGENT_OPTIONS.filter((a) => a.group === "api").map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </optgroup>
              <optgroup label="Local">
                {AGENT_OPTIONS.filter((a) => a.group === "local").map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className="automation-form-field">
            <label>Model <span className="automation-form-optional">(optional)</span></label>
            {availableModels.length > 0 ? (
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">{isHarness ? "Harness default" : isLocal ? "Auto-detect" : "Provider default"}</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            ) : (
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={modelsLoading ? "Loading models…" : isHarness ? "Harness default" : "Provider default"}
                disabled={modelsLoading}
              />
            )}
          </div>
        </div>

        <div className="automation-form-field">
          <label>Project folder</label>
          <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
            <option value="">None (project-less)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.path}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="automation-form-field">
          <label>Schedule</label>
          <select value={scheduleChoice} onChange={(e) => setScheduleChoice(e.target.value)}>
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.cron} value={p.cron}>{p.label}</option>
            ))}
            {keepOriginalCron && (
              <option value={automation!.schedule}>Current: {automation!.schedule}</option>
            )}
            <option value="custom">Custom…</option>
          </select>
        </div>

        {scheduleChoice === "custom" && (
          <div className="automation-form-row automation-form-row-3">
            <div className="automation-form-field">
              <label>Frequency</label>
              <select value={freq} onChange={(e) => setFreq(e.target.value as Freq)}>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            {freq === "weekly" && (
              <div className="automation-form-field">
                <label>Day</label>
                <select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                  {WEEKDAYS.map((w) => (
                    <option key={w.dow} value={w.dow}>{w.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="automation-form-field">
              <label>Time</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
        )}

        {schedule && (
          <p className="automation-form-schedule-preview">
            {previewNextAt != null ? (
              <>Next run: <strong>{formatNextFire(previewNextAt)}</strong></>
            ) : (
              <>Runs: {scheduleLabel(schedule)}</>
            )}
            {scheduleChoice === "custom" && (
              <>
                {" "}<code className="automation-form-cron">{schedule}</code>
              </>
            )}
          </p>
        )}

        <p className="automation-form-hint warning">
          Automations run unattended with full-auto permissions. They fire while
          Conduit is open — or anytime once "Run while closed" is on. Results
          land in a dedicated chat named after this automation.
        </p>
        {error && <p className="automation-form-error">{error}</p>}
      </div>

      <div className="automation-form-footer">
        <button onClick={onClose} className="automations-btn ghost">Cancel</button>
        <button
          onClick={() => void save()}
          disabled={!canSave || saving}
          className="automations-btn primary"
        >
          {saving ? (
            <><Loader2 size={14} strokeWidth={2} className="animate-spin" /> Saving…</>
          ) : (
            automation ? "Save changes" : "Create automation"
          )}
        </button>
      </div>
    </div>
  );
}
