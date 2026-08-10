// Automations view: master-detail layout for scheduled headless agent runs.
// Left: automation list with status badges + "New automation" button.
// Right: detail view with controls (pause/resume, run now, edit, delete),
// schedule display, and a "Past Runs" table.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
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
  listAutomationRuns,
  listChatModels,
  scanLocalModels,
  listHarnessModels,
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
  const setActiveView = useUiStore((s) => s.setActiveView);
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

  const selected = automations.find((a) => a.id === selectedId) ?? null;
  const editingId = selectedId?.startsWith(EDIT_PREFIX)
    ? selectedId.slice(EDIT_PREFIX.length)
    : null;
  const editingAutomation = editingId
    ? automations.find((a) => a.id === editingId) ?? null
    : null;

  const totalRuns = useMemo(
    () => automations.reduce((acc, a) => acc + (a.lastRunAt ? 1 : 0), 0),
    [automations],
  );
  const okCount = automations.filter((a) => a.lastStatus === "ok").length;
  const activeCount = automations.filter((a) => a.enabled).length;

  return (
    <div className="automations-view">
      {/* Header */}
      <div className="automations-header">
        <div className="automations-header-left">
          <CalendarClock size={20} strokeWidth={1.8} />
          <h1>Automations</h1>
          {loaded && (
            <span className="automations-header-badge">
              {activeCount}/{automations.length} active
            </span>
          )}
        </div>
        <div className="automations-header-right">
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

      {/* Stats bar */}
      {loaded && automations.length > 0 && (
        <div className="automations-stats">
          <div className="automations-stat">
            <span className="automations-stat-value">{automations.length}</span>
            <span className="automations-stat-label">Total</span>
          </div>
          <div className="automations-stat">
            <span className="automations-stat-value">{activeCount}</span>
            <span className="automations-stat-label">Active</span>
          </div>
          <div className="automations-stat">
            <span className="automations-stat-value" style={{ color: "var(--green, #4caf7d)" }}>
              {okCount}
            </span>
            <span className="automations-stat-label">Healthy</span>
          </div>
        </div>
      )}

      {/* Body */}
      {loaded && automations.length === 0 && !showNewForm ? (
        /* Empty state */
        <div className="automations-empty">
          <PlaySquare size={48} strokeWidth={1.5} />
          <h3>No automations scheduled yet</h3>
          <p>Schedule headless agent runs that fire on a cron schedule while Conduit is open.</p>
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
                return (
                  <button
                    key={a.id}
                    onClick={() => { setSelectedId(a.id); setShowNewForm(false); }}
                    className={`automations-list-row${isSelected ? " selected" : ""}`}
                  >
                    <div className="automations-list-row-top">
                      {a.enabled ? (
                        <PlayCircle size={14} strokeWidth={2} className="automations-list-status running" />
                      ) : (
                        <XCircle size={14} strokeWidth={2} className="automations-list-status paused" />
                      )}
                      <span className="automations-list-name">{a.name}</span>
                    </div>
                    <div className="automations-list-row-meta">
                      <span>{scheduleLabel(a.schedule)}</span>
                      <span>·</span>
                      <span>{relativeTime(a.lastRunAt)}</span>
                      {a.lastStatus && (
                        <span
                          className="automations-list-dot"
                          style={{ background: statusColor(a.lastStatus) }}
                          title={statusLabel(a.lastStatus)}
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
          <span className={`automation-status-pill ${automation.enabled ? "enabled" : "paused"}`}>
            {automation.enabled ? (
              <><Power size={11} strokeWidth={2.5} /> Active</>
            ) : (
              <><Pause size={11} strokeWidth={2.5} /> Paused</>
            )}
          </span>
        </div>
        <p className="automation-detail-prompt">{automation.prompt}</p>
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

      {/* Schedule card */}
      <div className="automation-detail-schedule">
        <div className="automation-detail-schedule-label">SCHEDULE</div>
        <div className="automation-detail-schedule-value">
          {scheduleLabel(automation.schedule)}
          <code className="automation-detail-schedule-cron">{automation.schedule}</code>
        </div>
        <div className="automation-detail-schedule-info">
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

  const [name, setName] = useState(automation?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [agentId, setAgentId] = useState(automation?.harness ?? "claude_code");
  const [model, setModel] = useState(automation?.model ?? "");
  const [cwd, setCwd] = useState(automation?.cwd ?? "");
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [scheduleChoice, setScheduleChoice] = useState<string>(
    automation
      ? (SCHEDULE_PRESETS.find((p) => p.cron === automation.schedule)?.cron ?? "custom")
      : SCHEDULE_PRESETS[3].cron,
  );
  const parsedCustom = automation ? parseSimpleCron(automation.schedule) : null;
  const [freq, setFreq] = useState<Freq>(parsedCustom?.freq ?? "weekdays");
  const [weekday, setWeekday] = useState(parsedCustom?.weekday ?? "1");
  const [time, setTime] = useState(parsedCustom?.time ?? "09:00");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

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
            // Auto-select default if none picked
            if (!model && cfg.defaultModel) setModel(cfg.defaultModel);
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
                <option value="">{isHarness ? "Harness default" : isLocal ? "Auto-detect" : "Select a model"}</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            ) : (
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={modelsLoading ? "Loading models…" : isHarness ? "Harness default" : "Enter model name"}
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
            {scheduleChoice === "custom" ? "→ " : ""}
            Runs: {scheduleLabel(schedule)}
          </p>
        )}

        <p className="automation-form-hint">
          Automations run unattended with full-auto permissions while Conduit is open.
          Results land in a dedicated chat named after this automation.
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
