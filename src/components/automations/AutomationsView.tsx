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
  Download,
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
  Square,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import {
  automationNextFire,
  automationWebhookInfo,
  isSubagentAutomation,
  getRunWhileClosed,
  getSetting,
  installHarness,
  listAutomationRuns,
  listChatModels,
  scanLocalModels,
  listHarnessModels,
  setRunWhileClosed,
  setSetting,
  testAutomationWebhook,
  toastError,
  toastSuccess,
  listAutomationTemplates,
  type Automation,
  type AutomationInput,
  type AutomationTemplate,
  type AutomationNextFire,
  type AutomationRun,
  type HarnessModelConfig,
  type GgufModel,
} from "../../lib/ipc";
import { useAutomationsStore } from "../../state/automations";
import { ToolbarHeader } from "../common/ToolbarHeader";
import { useSubagentStore } from "../../state/subagents";
import { useProjectsStore } from "../../state/projects";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { useChatStore } from "../../state/chat";
import { AGENT_OPTIONS } from "../../lib/agents";
import type { HarnessId } from "../../types";
import {
  AUTOMATION_STATE_META,
  automationState,
  buildAutomationRunPrompt,
  friendlyRunError,
  harnessNeedsInstall,
  isFailureStatus,
  STOPPED_STATUS,
  type AutomationStateKey,
} from "./shared";

/** Packaged automation templates (§4.2.7): compact chips that prefill the
 *  standard form. Rendered in the empty state and behind a header toggle. */
function TemplatePicker({
  templates,
  onPick,
}: {
  templates: AutomationTemplate[];
  onPick: (t: AutomationTemplate) => void;
}) {
  if (templates.length === 0) return null;
  return (
    <div className="automation-templates" data-testid="automation-templates">
      <div className="automation-templates-head">
        <span className="automation-templates-label">Start from a template</span>
        <span className="automation-templates-hint">One click prefills the form — you pick the project and confirm.</span>
      </div>
      <div className="automation-templates-row">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            className="automation-template-chip"
            title={t.description}
            onClick={() => onPick(t)}
          >
            <strong>{t.name}</strong>
            <span>{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

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

// ---- Trigger engines (automation_triggers.rs; "cron" = the schedule) ----

type TriggerType = "cron" | "webhook" | "file" | "git" | "gmail";

const TRIGGER_OPTIONS: { value: TriggerType; label: string }[] = [
  { value: "cron", label: "Cron" },
  { value: "webhook", label: "Webhook" },
  { value: "file", label: "File change" },
  { value: "git", label: "Git change" },
  { value: "gmail", label: "New email" },
];

function isTriggerType(v: string): v is TriggerType {
  return TRIGGER_OPTIONS.some((t) => t.value === v);
}

/** Compact badge text for event triggers in list/detail ("cron" rows keep
 *  showing the schedule itself). */
function triggerBadge(triggerType: string): string | null {
  switch (triggerType) {
    case "webhook": return "webhook";
    case "file": return "file";
    case "git": return "git";
    case "gmail": return "email";
    default: return null;
  }
}

/** Parsed-on-demand trigger_config (never throws — a malformed stored payload
 *  degrades to empty fields, matching the backend's skip-on-parse-failure). */
function safeTriggerConfig(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One-line engine summary for the detail card. Cron rows keep the schedule
 *  label as today; event rows describe what actually fires them. */
function triggerSummary(a: Automation): string {
  const cfg = safeTriggerConfig(a.triggerConfig);
  switch (a.triggerType) {
    case "webhook":
      return "Webhook call";
    case "file":
      return `File change — ${typeof cfg.path === "string" && cfg.path ? cfg.path : "no path set"}`;
    case "git": {
      const where = typeof cfg.cwd === "string" && cfg.cwd ? cfg.cwd : "no repo set";
      const branch = typeof cfg.branch === "string" && cfg.branch ? ` (${cfg.branch})` : "";
      return `Git change — ${where}${branch}`;
    }
    case "gmail":
      return `New email — ${typeof cfg.label === "string" && cfg.label ? cfg.label : "inbox"}`;
    default:
      return scheduleLabel(a.schedule);
  }
}

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
  if (status === STOPPED_STATUS) return "var(--text-dim)";
  if (status) return "var(--red, #ff6b6b)";
  return "var(--text-dim)";
}

function statusLabel(status: string | null): string {
  if (status === "ok") return "OK";
  if (status === "skipped") return "Skipped";
  if (status === "running") return "Running";
  if (status === STOPPED_STATUS) return "Stopped";
  if (status) return "Error";
  return "—";
}

// ---- Main view ----

const EDIT_PREFIX = "__edit__:";

export function AutomationsView() {
  const automations = useAutomationsStore((s) => s.automations);
  const loaded = useAutomationsStore((s) => s.loaded);
  const loadError = useAutomationsStore((s) => s.error);
  const load = useAutomationsStore((s) => s.load);
  const runningNow = useAutomationsStore((s) => s.runningNow);
  const pendingArtifactFormData = useUiStore((s) => s.pendingArtifactFormData);
  const setPendingArtifactFormData = useUiStore((s) => s.setPendingArtifactFormData);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);

  // Packaged templates (§4.2.7): one click hands the template to the standard
  // form via the same pendingArtifactFormData channel the chat proposal cards
  // use — no separate write path, the user still confirms everything.
  useEffect(() => {
    let cancelled = false;
    void listAutomationTemplates()
      .then((t) => { if (!cancelled) setTemplates(t ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const applyTemplate = useCallback((t: AutomationTemplate) => {
    setPendingArtifactFormData({
      artifactType: "automation",
      spec: {
        name: t.name,
        prompt: t.prompt,
        harness: t.harness,
        model: t.model ?? undefined,
        trigger: { schedule: t.schedule },
      },
    });
  }, [setPendingArtifactFormData]);

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
      {/* Header — rides in the window title bar, not above the page, so the
          metrics sit beside the window controls instead of burning a second
          bar (see common/ToolbarHeader). The left group is a drag region like
          any other dead caption space; the right group's controls stay
          clickable. */}
      <ToolbarHeader>
        <div className="automations-header">
          <div className="automations-header-left" data-tauri-drag-region="">
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
              onClick={() => setShowTemplates((v) => !v)}
              title="Start from a packaged template (PR review bot, …)"
            >
              Templates
            </button>
            <button
              className="automations-btn ghost"
              onClick={() => { void load(); }}
              title="Refresh"
            >
              <RefreshCw size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
      </ToolbarHeader>

      {loadError && (
        <div className="automation-detail-error" style={{ margin: "8px 20px 0" }}>
          Couldn&apos;t load automations: {loadError}{" "}
          <button className="automations-btn ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {showTemplates && automations.length > 0 && (
        <div style={{ padding: "8px 20px 0" }}>
          <TemplatePicker templates={templates} onPick={applyTemplate} />
        </div>
      )}

      {/* Body */}
      {loaded && automations.length === 0 && !showNewForm ? (
        /* Empty state */
        <div className="automations-empty">
          <PlaySquare size={48} strokeWidth={1.5} />
          <h3>No automations scheduled yet</h3>
          <p>Schedule headless agent runs on a cron schedule — they fire while Relay is open, or anytime with "Run while closed".</p>
          <button
            onClick={() => setShowNewForm(true)}
            className="automations-btn primary"
          >
            <Plus size={16} strokeWidth={2} /> Create your first automation
          </button>
          <TemplatePicker templates={templates} onPick={applyTemplate} />
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
                      {a.origin === "agent" ? (
                        // Authored by the model (create_automation tool — which
                        // always required an explicit approval card). Kept
                        // visible so agent-scheduled prompts are never
                        // indistinguishable from the user's own.
                        <span
                          className="automations-list-agent-badge"
                          title="Created by an agent chat — runs unattended at full-auto"
                        >
                          Agent
                        </span>
                      ) : null}
                    </div>
                    <div className="automations-list-row-meta">
                      {triggerBadge(a.triggerType) ? (
                        // Event rows fire from their own engine, so their
                        // (usually empty) cron string says nothing — badge
                        // the engine instead.
                        <span className="automations-list-trigger-badge">
                          {triggerBadge(a.triggerType)}
                        </span>
                      ) : (
                        <span>{scheduleLabel(a.schedule)}</span>
                      )}
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

/** "Run while closed" — registers/unregisters the global `RelayAutomations`
 *  Task Scheduler entry that fires `relay-automation run-due` every minute.
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
          "Windows Task Scheduler fires every minute and due automations run headless at full permissions — even while Relay is closed. Turn it off any time to unregister the task.",
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
      title="Run automations while Relay is closed (Windows Task Scheduler)"
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
            While Relay is open, failed runs show an OS toast (follows Do Not Disturb)
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
            Relay is fully closed.
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
  const stopRun = useAutomationsStore((s) => s.stopRun);
  const runningNow = useAutomationsStore((s) => s.runningNow);
  const stoppingNow = useAutomationsStore((s) => s.stoppingNow);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const selectSession = useChatStore((s) => s.selectSession);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const harnesses = useProjectsStore((s) => s.harnesses);
  // Subagent-bound rows resolve their display name from the registry (a deleted
  // agent falls back to the raw `agent:<id>` value).
  const subagentAgents = useSubagentStore((s) => s.agents);
  const refreshHarnesses = useProjectsStore((s) => s.refreshHarnesses);

  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [nextFire, setNextFire] = useState<AutomationNextFire | null | undefined>(undefined);
  // One-time harness install (failure banner): the automation's harness CLI
  // isn't on this device, so "Run again" becomes "Install" until it lands.
  const [installing, setInstalling] = useState(false);

  // Webhook trigger URL — the secret is redacted from list/get, so the only
  // source is the dedicated getter. Fetched once per selection; null renders
  // as "listener not running" (the URL only exists while the app serves it).
  const [detailWebhookUrl, setDetailWebhookUrl] = useState<string | null>(null);
  const isWebhookTrigger = automation.triggerType === "webhook";
  useEffect(() => {
    if (!isWebhookTrigger) return;
    let cancelled = false;
    automationWebhookInfo(automation.id)
      .then((info) => { if (!cancelled) setDetailWebhookUrl(info.url); })
      .catch(() => { if (!cancelled) setDetailWebhookUrl(null); });
    return () => { cancelled = true; };
  }, [isWebhookTrigger, automation.id]);

  // True only when the automation runs a CLI harness that exists in the
  // registry but isn't installed — provider/local agents never match.
  const harnessMissing = harnessNeedsInstall(automation.harness, harnesses);
  const missingHarnessName = harnesses.find((h) => h.id === automation.harness)?.displayName;

  // Runs fetch ownership: switching automations while a fetch is in flight
  // must not let the old automation's rows land in the new detail view (same
  // open-request guard as the skills library editor).
  const runsOwnerRef = useRef<string | null>(null);

  const refreshRuns = useCallback(async (background = false) => {
    // Background polls (the 5s interval) must not flash the table spinner or
    // rebuild the rows when nothing changed — the detail view otherwise
    // re-renders fully every 5 s for the lifetime of the screen.
    runsOwnerRef.current = automation.id;
    const ownerId = automation.id;
    if (!background) setRunsLoading(true);
    setRunError(null);
    try {
      const r = await listAutomationRuns(automation.id, 100);
      if (runsOwnerRef.current !== ownerId) return; // the view moved to another automation
      const next = r ?? [];
      setRuns((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    } catch (e) {
      if (runsOwnerRef.current !== ownerId) return;
      setRunError(String(e));
    } finally {
      if (!background && runsOwnerRef.current === ownerId) setRunsLoading(false);
    }
  }, [automation.id]);

  useEffect(() => {
    void refreshRuns();
    const interval = window.setInterval(() => void refreshRuns(true), 5000);
    return () => window.clearInterval(interval);
  }, [refreshRuns]);

  useEffect(() => {
    if (runningNow[automation.id]) void refreshRuns();
  }, [runningNow, automation.id, refreshRuns]);

  // Next scheduled fire — same math the scheduler uses for due-ness, so the
  // display can't drift from what will actually run. Recomputed when the
  // schedule changes and every minute (the "Today/Tomorrow" framing ages).
  // Event triggers (webhook/file/git) come back with a human label instead
  // of a timestamp.
  useEffect(() => {
    if (!automation.enabled) { setNextFire(undefined); return; }
    let cancelled = false;
    const fetchNext = () => {
      void automationNextFire(automation.schedule, automation.triggerType, automation.triggerConfig)
        .then((v) => { if (!cancelled) setNextFire(v); })
        .catch(() => { if (!cancelled) setNextFire(null); });
    };
    fetchNext();
    const interval = window.setInterval(fetchNext, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [automation.enabled, automation.id, automation.schedule, automation.triggerType, automation.triggerConfig]);

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

  // A run is in flight when either signal says so: the automation-level
  // lastStatus, or an actual runs row (either can lag the other by a poll).
  const runInFlight =
    automation.lastStatus === "running" || runs.some((r) => r.status === "running");

  const handleRunNow = useCallback(async () => {
    setRunError(null);
    try {
      await runNow(automation.id);
      window.setTimeout(() => void refreshRuns(), 500);
    } catch (e) {
      setRunError(String(e));
    }
  }, [automation.id, runNow, refreshRuns]);

  const handleStopRun = useCallback(async () => {
    setRunError(null);
    try {
      await stopRun(automation.id);
      window.setTimeout(() => void refreshRuns(), 500);
    } catch (e) {
      setRunError(String(e));
    }
  }, [automation.id, stopRun, refreshRuns]);

  const handleInstallHarness = useCallback(async () => {
    setRunError(null);
    setInstalling(true);
    try {
      const msg = await installHarness(automation.harness as HarnessId);
      toastSuccess(msg || `${missingHarnessName ?? automation.harness} installed`);
    } catch (e) {
      toastError(`Couldn't install ${missingHarnessName ?? automation.harness}`, String(e));
    } finally {
      setInstalling(false);
      // Forced re-probe: the banner must flip back to "Run again" the moment
      // the CLI lands, regardless of the backend's 30s probe cache.
      void refreshHarnesses(true);
    }
  }, [automation.harness, missingHarnessName, refreshHarnesses]);

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
      try {
        await loadSessions();
        await selectSession(chatSessionId);
        // Only switch views once the session actually opened — a rejected
        // selectSession (DB lock) would otherwise land on an empty chat.
        setActiveView("chat");
      } catch (e) {
        setRunError(String(e));
      }
    },
    [loadSessions, selectSession, setActiveView],
  );

  const handleDelete = useCallback(() => {
    if (window.confirm("Delete this automation? Past run history is kept.")) {
      // remove hits the backend and can reject (IPC/DB) — toast like the
      // other actions instead of an unhandled rejection.
      void remove(automation.id)
        .then(onDeleted)
        .catch((e) => toastError("Couldn't delete the automation", e));
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
          <span>{isSubagentAutomation(automation.harness)
            ? (subagentAgents.find((c) => c.id === automation.harness.slice(6))?.name
              ?? automation.harness)
            : (AGENT_OPTIONS.find((a) => a.id === automation.harness)?.label ?? automation.harness)}</span>
          {automation.model && <><span>·</span><span>{automation.model}</span></>}
          {automation.cwd && <><span>·</span><span className="automation-detail-cwd" title={automation.cwd}>{automation.cwd.split(/[/\\]/).pop()}</span></>}
        </div>
      </div>

      {/* Controls */}
      <div className="automation-detail-controls">
        <button
          onClick={() => void handleToggleEnabled()}
          className={`automations-btn ${automation.enabled ? "secondary" : "success"}`}
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
        {runInFlight && (
          <button
            onClick={() => void handleStopRun()}
            disabled={stoppingNow[automation.id]}
            className="automations-btn secondary danger"
            title="Stop the in-flight run"
          >
            {stoppingNow[automation.id] ? (
              <><Loader2 size={13} strokeWidth={2} className="animate-spin" /> Stopping…</>
            ) : (
              <><Square size={11} strokeWidth={2.5} fill="currentColor" /> Stop</>
            )}
          </button>
        )}
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
          language with a suggested next step. When the automation's harness
          CLI isn't installed, "Run again" becomes a one-time "Install"
          (npm -g) that flips back once the re-probe sees the binary. */}
      {isFailureStatus(automation.lastStatus) && !runError && (() => {
        const friendly = friendlyRunError(automation.lastStatus!);
        const hint = harnessMissing
          ? `${missingHarnessName ?? automation.harness} isn't installed on this device — one-time install below, then Run again.`
          : friendly.hint;
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
                {hint ? ` ${hint}` : ""}
              </span>
            </div>
            {automation.enabled && (
              harnessMissing && !runningNow[automation.id] ? (
                <button
                  onClick={() => void handleInstallHarness()}
                  disabled={installing}
                  title={`Runs npm install -g to install ${missingHarnessName ?? automation.harness}`}
                  className="automations-btn automation-detail-banner-action"
                >
                  {installing ? (
                    <><Loader2 size={13} strokeWidth={2} className="animate-spin" /> Installing…</>
                  ) : (
                    <><Download size={13} strokeWidth={2} /> Install</>
                  )}
                </button>
              ) : (
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
              )
            )}
          </div>
        );
      })()}

      {/* Schedule card */}
      <div className="automation-detail-schedule">
        <div className="automation-detail-schedule-label">AUTOMATION</div>
        <div className="automation-detail-schedule-value">
          {triggerSummary(automation)}
          {automation.schedule && (
            <code className="automation-detail-schedule-cron">{automation.schedule}</code>
          )}
        </div>
        {isWebhookTrigger && (
          <div className="automation-detail-webhook-row">
            <span className="automation-detail-webhook-label">Webhook URL</span>
            {detailWebhookUrl ? (
              <>
                <code className="automation-detail-webhook-url" title={detailWebhookUrl}>
                  {detailWebhookUrl}
                </code>
                <button
                  className="automations-btn ghost"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(detailWebhookUrl)
                      .then(() => toastSuccess("Webhook URL copied"))
                  }
                >
                  Copy
                </button>
              </>
            ) : (
              <span className="automation-detail-webhook-missing">
                trigger listener not running
              </span>
            )}
          </div>
        )}
        <div className="automation-detail-schedule-info">
          {automation.enabled && nextFire != null && (nextFire.at != null || nextFire.label !== "") && (
            <>Next run: {nextFire.at != null ? formatNextFire(nextFire.at) : nextFire.label}<br /></>
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
            onStopRun={runInFlight ? () => void handleStopRun() : undefined}
            stopping={!!stoppingNow[automation.id]}
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
  // Subagents ride the same select as engines, as `agent:<id>` values —
  // one code path end to end (validation, routing, history all accept it).
  const subagentAgents = useSubagentStore((s) => s.agents);
  const subagentLoaded = useSubagentStore((s) => s.loaded);
  const loadSubagent = useSubagentStore((s) => s.load);
  useEffect(() => {
    if (!subagentLoaded) void loadSubagent();
  }, [subagentLoaded, loadSubagent]);
  const [model, setModel] = useState(automation?.model ?? "");
  const [cwd, setCwd] = useState(automation?.cwd ?? "");
  // Trigger engine + its per-type fields, loaded from the stored row on edit.
  // Switching type keeps every other field's value intact.
  const storedTriggerType = automation?.triggerType ?? "cron";
  const [triggerType, setTriggerType] = useState<TriggerType>(
    isTriggerType(storedTriggerType) ? storedTriggerType : "cron",
  );
  const storedCfg = safeTriggerConfig(automation?.triggerConfig ?? "{}");
  const [filePath, setFilePath] = useState(
    typeof storedCfg.path === "string" ? storedCfg.path : "",
  );
  const [fileMinSecs, setFileMinSecs] = useState(
    typeof storedCfg.minIntervalSecs === "number" ? String(storedCfg.minIntervalSecs) : "",
  );
  const [gitCwd, setGitCwd] = useState(
    typeof storedCfg.cwd === "string" ? storedCfg.cwd : "",
  );
  const [gitBranch, setGitBranch] = useState(
    typeof storedCfg.branch === "string" ? storedCfg.branch : "",
  );
  const [gmailLabel, setGmailLabel] = useState(
    typeof storedCfg.label === "string" && storedCfg.label.trim() !== "" ? storedCfg.label : "inbox",
  );
  // Webhook trigger URL (list/get redact the secret) — fetched while editing
  // a webhook row, or right after creating one.
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  // Set when a webhook automation was just created: the form stays open so
  // the trigger URL can be copied once; "Done" hands the id to the parent.
  const [createdId, setCreatedId] = useState<string | null>(null);
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
  // description, and trigger/schedule to pre-fill the form. The prompt is
  // compiled from the WHOLE spec (description + steps) — pre-filling with just
  // the description used to create automations whose runs had no actual
  // instructions to follow.
  const setAutomationFormData = useCallback((spec: any) => {
    // Accept the legacy { type, spec } wrapper some persisted proposals carry.
    const s = spec && typeof spec.spec === "object" ? { ...spec.spec, type: spec.type } : (spec ?? {});
    setName(s.name || "");
    // Templates (and any caller that already has the exact run text) win over
    // compilation — buildAutomationRunPrompt would wrap the packaged prompt
    // in a Goal/steps scaffold it was never written for.
    setPrompt(
      typeof s.prompt === "string" && s.prompt.trim()
        ? s.prompt
        : buildAutomationRunPrompt(s)
    );
    if (s.harness) setAgentId(s.harness);
    if (s.model) setModel(s.model);
    if (s.trigger?.schedule) {
      setScheduleChoice(s.trigger.schedule);
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
  // A subagent binding leaves the Model field to the definition (the backend
  // precedence is automation model > agent model), so no model fetch runs.
  const isSubagent = isSubagentAutomation(agentId);

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
  // Event triggers fire from their own engine, not the cron clock — the
  // schedule builder is hidden for them (their stored cron string may be
  // empty; switching back to cron restores whatever the builder holds).
  const eventTrigger = triggerType !== "cron";
  // Per-type required fields (file/git carry a required path/cwd; webhook and
  // gmail have none).
  const triggerValid =
    triggerType === "file" ? filePath.trim() !== "" :
    triggerType === "git" ? gitCwd.trim() !== "" :
    true;
  const canSave = useMemo(
    () => name.trim() !== "" && prompt.trim() !== "" && (eventTrigger ? triggerValid : schedule !== ""),
    [name, prompt, eventTrigger, triggerValid, schedule],
  );

  // The exact triggerConfig JSON each type stores — the same camelCase
  // shapes validate_trigger parses backend-side.
  const triggerConfigJson = useMemo(() => {
    switch (triggerType) {
      case "file": {
        const cfg: Record<string, unknown> = { path: filePath.trim() };
        const min = Number.parseInt(fileMinSecs, 10);
        if (!Number.isNaN(min)) cfg.minIntervalSecs = min;
        return JSON.stringify(cfg);
      }
      case "git": {
        const cfg: Record<string, unknown> = { cwd: gitCwd.trim() };
        if (gitBranch.trim() !== "") cfg.branch = gitBranch.trim();
        return JSON.stringify(cfg);
      }
      case "gmail": {
        const label = gmailLabel.trim();
        return JSON.stringify(label !== "" ? { label } : {});
      }
      default:
        return "{}"; // cron + webhook carry no user fields
    }
  }, [triggerType, filePath, fileMinSecs, gitCwd, gitBranch, gmailLabel]);

  // Live "next run" preview for the chosen trigger (debounced — recomputing
  // on every keystroke would otherwise spam the backend). Cron rows preview
  // from the schedule; event rows preview from the trigger type itself and
  // come back with a human label ("on file change") instead of a timestamp.
  const [previewFire, setPreviewFire] = useState<AutomationNextFire | null>(null);
  useEffect(() => {
    if (!eventTrigger && !schedule) { setPreviewFire(null); return; }
    let cancelled = false;
    setPreviewFire(null);
    const handle = window.setTimeout(() => {
      void automationNextFire(schedule, triggerType, triggerConfigJson)
        .then((v) => { if (!cancelled && (v.at != null || v.label !== "")) setPreviewFire(v); })
        .catch(() => {});
    }, 250);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [schedule, eventTrigger, triggerType, triggerConfigJson]);

  // The webhook URL only exists once the row does (the secret is generated
  // server-side), so it is fetched for an existing webhook row, or right
  // after create via createdId.
  const webhookInfoId = triggerType === "webhook" ? (automation?.id ?? createdId) : null;
  useEffect(() => {
    if (!webhookInfoId) { setWebhookUrl(null); return; }
    let cancelled = false;
    automationWebhookInfo(webhookInfoId)
      .then((info) => { if (!cancelled) setWebhookUrl(info.url); })
      .catch(() => { if (!cancelled) setWebhookUrl(null); });
    return () => { cancelled = true; };
  }, [webhookInfoId]);

  const save = async () => {
    // Per-type required fields — the button is disabled too, but this shows
    // the inline error for keyboard/programmatic paths.
    if (triggerType === "file" && filePath.trim() === "") {
      setError("A file-change trigger needs a folder path to watch.");
      return;
    }
    if (triggerType === "git" && gitCwd.trim() === "") {
      setError("A git-change trigger needs a repository folder.");
      return;
    }
    const input: AutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      harness: agentId,
      model: model || undefined,
      cwd: cwd || undefined,
      // Event triggers ignore the cron string; it rides along untouched so a
      // later switch back to cron restores it.
      schedule,
      enabled: automation?.enabled ?? true,
      triggerType,
      triggerConfig: triggerConfigJson,
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
        if (triggerType === "webhook") {
          // Keep the form open: the trigger URL (with its secret) must be
          // surfaced once, right where the user created it. The footer flips
          // to "Done", which selects the new row and closes.
          setCreatedId(created.id);
          return;
        }
        onCreated?.(created.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canSave && !saving && !createdId) {
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
              {subagentAgents.length > 0 && (
                <optgroup label="Subagent">
                  {subagentAgents.map((c) => (
                    <option key={c.id} value={`agent:${c.id}`}>
                      {c.name}{c.builtin ? "" : " (subagent)"}
                    </option>
                  ))}
                </optgroup>
              )}
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
            <label>Model <span className="automation-form-optional">{isSubagent ? "(from subagent)" : "(optional)"}</span></label>
            {isSubagent ? (
              <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
                placeholder="Subagent's model (leave empty to use it)" />
            ) : availableModels.length > 0 ? (
              // A stale saved model (no longer in the fetched list) must not
              // sit in state while the select shows the blank default — the
              // submit would then send a nonexistent model id.
              <select
                value={availableModels.some((m) => m.id === model) ? model : ""}
                onChange={(e) => setModel(e.target.value)}
              >
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
          <label>Trigger</label>
          <select
            aria-label="Trigger type"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as TriggerType)}
          >
            {TRIGGER_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {triggerType === "cron" && (
          <>
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
          </>
        )}

        {triggerType === "webhook" && (
          <p className="automation-form-hint">
            Fires whenever the trigger URL is called (GET or POST) — the URL
            appears here after you create the automation. No schedule needed.
          </p>
        )}

        {triggerType === "file" && (
          <>
            <div className="automation-form-row">
              <div className="automation-form-field">
                <label>Folder to watch</label>
                <input
                  aria-label="Folder to watch"
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  placeholder="D:\projects\site\dist"
                />
              </div>
              <div className="automation-form-field">
                <label>Min re-fire seconds <span className="automation-form-optional">(optional, default 60)</span></label>
                <input
                  aria-label="Min re-fire seconds"
                  type="number"
                  min={0}
                  value={fileMinSecs}
                  onChange={(e) => setFileMinSecs(e.target.value)}
                  placeholder="60"
                />
              </div>
            </div>
            <p className="automation-form-hint">
              Runs when anything in the folder is created, modified, or removed
              (debounced). The project folder above may stay empty for file
              triggers.
            </p>
          </>
        )}

        {triggerType === "git" && (
          <>
            <div className="automation-form-row">
              <div className="automation-form-field">
                <label>Repository folder</label>
                <input
                  aria-label="Repository folder"
                  value={gitCwd}
                  onChange={(e) => setGitCwd(e.target.value)}
                  placeholder="D:\projects\site"
                />
              </div>
              <div className="automation-form-field">
                <label>Branch <span className="automation-form-optional">(optional, default HEAD)</span></label>
                <input
                  aria-label="Git branch"
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.target.value)}
                  placeholder="main"
                />
              </div>
            </div>
            <p className="automation-form-hint">
              Runs when the branch's HEAD commit changes. Works while Relay is
              open — and while closed with "Run while closed" on.
            </p>
          </>
        )}

        {triggerType === "gmail" && (
          <>
            <div className="automation-form-field">
              <label>Gmail label <span className="automation-form-optional">(optional)</span></label>
              <input
                aria-label="Gmail label"
                value={gmailLabel}
                onChange={(e) => setGmailLabel(e.target.value)}
                placeholder="inbox"
              />
            </div>
            <p className="automation-form-hint">
              Fires when the connected Gmail account sees new activity
              (requires the Gmail connector). Works while Relay is running.
            </p>
          </>
        )}

        {triggerType === "webhook" && webhookUrl && (
          <div className="automation-form-field">
            <label>Trigger URL</label>
            <div className="automation-form-webhook-row">
              <code className="automation-form-webhook-url" title={webhookUrl}>
                {webhookUrl}
              </code>
              <button
                className="automations-btn ghost"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(webhookUrl)
                    .then(() => toastSuccess("Webhook URL copied"))
                }
              >
                Copy
              </button>
              <button
                className="automations-btn ghost"
                title="Copy a ready-to-run curl command"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(`curl -X POST "${webhookUrl}"`)
                    .then(() => toastSuccess("curl command copied"))
                }
              >
                Copy curl
              </button>
            </div>
            <p className="automation-form-hint">Works while Relay is running.</p>
          </div>
        )}

        {(schedule || eventTrigger) && (
          <p className="automation-form-schedule-preview">
            {previewFire != null && (previewFire.at != null || previewFire.label !== "") ? (
              <>
                {previewFire.at != null ? "Next run: " : "Fires "}
                <strong>{previewFire.at != null ? formatNextFire(previewFire.at) : previewFire.label}</strong>
              </>
            ) : eventTrigger ? (
              <>
                Fires on <strong>{TRIGGER_OPTIONS.find((t) => t.value === triggerType)?.label.toLowerCase() ?? triggerType}</strong>
              </>
            ) : (
              <>Runs: {scheduleLabel(schedule)}</>
            )}
            {scheduleChoice === "custom" && triggerType === "cron" && (
              <>
                {" "}<code className="automation-form-cron">{schedule}</code>
              </>
            )}
          </p>
        )}

        <p className="automation-form-hint warning">
          Automations run unattended with full-auto permissions. They fire while
          Relay is open — or anytime once "Run while closed" is on. Results
          land in a dedicated chat named after this automation.
        </p>
        {error && <p className="automation-form-error">{error}</p>}
      </div>

      <div className="automation-form-footer">
        <button onClick={onClose} className="automations-btn ghost">Cancel</button>
        <button
          onClick={() => {
            // Post-create webhook state: hand the new id to the parent (it
            // selects the row) and close.
            if (createdId) {
              onCreated?.(createdId);
              onClose();
              return;
            }
            void save();
          }}
          disabled={!createdId && (!canSave || saving)}
          className="automations-btn primary"
        >
          {saving ? (
            <><Loader2 size={14} strokeWidth={2} className="animate-spin" /> Saving…</>
          ) : createdId ? (
            "Done"
          ) : (
            automation ? "Save changes" : "Create automation"
          )}
        </button>
      </div>
    </div>
  );
}
