// Automations view (master-detail): left pane lists automations with schedule
// + last-run status badge; right pane shows the selected automation's controls
// (pause/resume, run now, edit, delete) and a "Past runs" table.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Edit3,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  PlaySquare,
  Plus,
  Power,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import {
  listAutomationRuns,
  type Automation,
  type AutomationInput,
  type AutomationRun,
} from "../../lib/ipc";
import { useAutomationsStore } from "../../state/automations";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import { useChatStore } from "../../state/chat";

const AutomationRunTable = lazy(() =>
  import("./AutomationRunTable").then((m) => ({ default: m.AutomationRunTable }))
);

/** Preset schedules shown in the form; everything else is "Custom". */
const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Hourly", cron: "7 * * * *" },
  { label: "Daily at 9:00 AM", cron: "2 9 * * *" },
  { label: "Weekdays at 9:00 AM", cron: "2 9 * * 1-5" },
  { label: "Nightly at 2:00 AM", cron: "1 2 * * *" },
];

const HARNESSES: { id: string; label: string }[] = [
  { id: "claude_code", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
];

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

function statusBadgeClass(status: string | null): string {
  if (status === "ok") return "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300";
  if (status === "skipped") return "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300";
  if (status === "running") return "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300";
  if (status) return "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300";
  return "";
}

function relativeTime(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

/** selectedId sentinel prefix for "edit automation <id>" (see AutomationsView). */
const EDIT_PREFIX = "__edit__:";

export function AutomationsView() {
  const automations = useAutomationsStore((s) => s.automations);
  const loaded = useAutomationsStore((s) => s.loaded);
  const load = useAutomationsStore((s) => s.load);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Default the selection to the most recent automation once loaded.
  useEffect(() => {
    if (loaded && !selectedId && automations.length > 0) {
      setSelectedId(automations[0].id);
    }
  }, [loaded, automations, selectedId]);

  const selected = automations.find((a) => a.id === selectedId) ?? null;

  // Edit mode rides on the same selectedId slot as a sentinel ("__edit__:<id>")
  // so selection stays single-source. It mounts AutomationForm WITH the
  // automation (its update branch) — previously Edit mounted the create form
  // (automation=null) and Save duplicated the automation instead of updating.
  const editingId = selectedId?.startsWith(EDIT_PREFIX)
    ? selectedId.slice(EDIT_PREFIX.length)
    : null;
  const editingAutomation = editingId
    ? automations.find((a) => a.id === editingId) ?? null
    : null;

  return (
    <div className="h-full flex flex-col bg-white/95 dark:bg-[#141414]">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 dark:border-white/20 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <CalendarClock size={20} strokeWidth={1.8} className="text-gray-600 dark:text-slate-300" />
          <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Automations</h1>
        </div>
        <button
          onClick={() => setActiveView("chat")}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
          title="Back to chat"
        >
          ← Back to chat
        </button>
      </div>

      {/* Empty state — only shown until the user explicitly opens the create
          form. Once they click "Create your first automation" we flip into
          the same master/detail layout that the populated state uses, with
          the create form mounted in the right pane. This avoids the trap
          where the empty-state and the master-detail are sibling branches
          and a state flip from one can't reach the other. */}
      {loaded && automations.length === 0 && selectedId !== "__new__" ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8">
          <PlaySquare size={48} strokeWidth={1.5} className="text-gray-300 dark:text-slate-400" />
          <div className="text-center">
            <p className="text-gray-700 dark:text-slate-200 mb-2 font-medium">
              No automations scheduled yet
            </p>
            <p className="text-xs text-gray-500 dark:text-slate-400 mb-4">
              Schedule headless agent runs that fire on a cron schedule while Conduit is open.
            </p>
            <button
              onClick={() => setSelectedId("__new__")}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-900 dark:bg-white/15 border border-gray-900 dark:border-white/30 text-white hover:bg-gray-800 dark:hover:bg-white/25 transition-all"
            >
              <Plus size={16} strokeWidth={2} /> Create your first automation
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Left pane: automation list — hidden when the empty-state was
              just dismissed and there are no automations yet, so the right
              pane gets full width for the create form. */}
          {automations.length > 0 ? (
            <div className="w-80 border-r border-gray-200 dark:border-white/20 flex flex-col flex-shrink-0">
              <div className="px-3 py-2 border-b border-gray-200 dark:border-white/20">
                <button
                  onClick={() => setSelectedId("__new__")}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-900 dark:bg-white/15 border border-gray-900 dark:border-white/30 text-white hover:bg-gray-800 dark:hover:bg-white/25 transition-all text-xs font-semibold"
                >
                  <Plus size={14} strokeWidth={2} /> New automation
                </button>
              </div>
              <div className="flex-1 overflow-y-auto sidebar-thin-scroll">
                {automations.map((a) => {
                  const isSelected = a.id === selectedId;
                  return (
                    <button
                      key={a.id}
                      onClick={() => setSelectedId(a.id)}
                      className={`w-full text-left px-4 py-3 border-b border-gray-200 dark:border-white/20 transition-colors ${
                        isSelected
                          ? "bg-gray-100 dark:bg-white/10"
                          : "hover:bg-gray-50 dark:hover:bg-white/5"
                      }`}
                    >
                      <div className="flex items-start gap-2 mb-1">
                        {a.enabled ? (
                          <PlayCircle
                            size={14}
                            strokeWidth={2}
                            className="flex-shrink-0 mt-0.5 text-green-500"
                          />
                        ) : (
                          <XCircle
                            size={14}
                            strokeWidth={2}
                            className="flex-shrink-0 mt-0.5 text-gray-400"
                          />
                        )}
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate flex-1">
                          {a.name}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-slate-400 mb-1.5 truncate">
                        {scheduleLabel(a.schedule)}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-400 dark:text-slate-500">
                          {relativeTime(a.lastRunAt)}
                        </span>
                        {a.lastStatus && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusBadgeClass(a.lastStatus)}`}
                          >
                            {a.lastStatus === "ok"
                              ? "ok"
                              : a.lastStatus === "skipped"
                              ? "skip"
                              : a.lastStatus === "running"
                              ? "running"
                              : "err"}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Right pane: detail / form */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedId === "__new__" ? (
              <AutomationForm
                automation={null}
                onClose={() => {
                  // If we're still empty, going back means back to the empty
                  // state — not to a stale "select an automation" placeholder.
                  setSelectedId(automations.length === 0 ? null : "");
                }}
                onCreated={(id) => setSelectedId(id)}
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
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  Select an automation to view its details.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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

  const refreshRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const r = await listAutomationRuns(automation.id, 100);
      setRuns(r ?? []);
    } finally {
      setRunsLoading(false);
    }
  }, [automation.id]);

  useEffect(() => {
    void refreshRuns();
    const interval = window.setInterval(() => void refreshRuns(), 5000);
    return () => window.clearInterval(interval);
  }, [refreshRuns]);

  // Refresh when run-now flips so the in-flight row shows up immediately
  // rather than waiting for the 5s poll.
  useEffect(() => {
    if (runningNow[automation.id]) void refreshRuns();
  }, [runningNow, automation.id, refreshRuns]);

  const handleRunNow = useCallback(async () => {
    await runNow(automation.id);
    window.setTimeout(() => void refreshRuns(), 300);
  }, [automation.id, runNow, refreshRuns]);

  const handleOpenRunLog = useCallback(
    async (chatSessionId: string) => {
      await loadSessions();
      await selectSession(chatSessionId);
      setActiveView("chat");
    },
    [loadSessions, selectSession, setActiveView],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 dark:border-white/20 flex items-start justify-between gap-4 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
              {automation.name}
            </h2>
            {automation.enabled ? (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-green-600 dark:text-green-400">
                <Power size={11} strokeWidth={2.5} /> Enabled
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-gray-400 dark:text-slate-500">
                <Pause size={11} strokeWidth={2.5} /> Paused
              </span>
            )}
          </div>
          <p className="text-sm text-gray-600 dark:text-slate-300 line-clamp-2">{automation.prompt}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onEdit}
            className="p-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
            title="Edit"
            aria-label="Edit automation"
          >
            <Edit3 size={14} strokeWidth={1.8} />
          </button>
          {automation.chatSessionId && (
            <button
              onClick={() => void handleOpenRunLog(automation.chatSessionId!)}
              className="p-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
              title="Open run log"
              aria-label="Open run log"
            >
              <ExternalLink size={14} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="px-6 py-3 border-b border-gray-200 dark:border-white/20 flex items-center gap-2 flex-shrink-0 flex-wrap">
        <button
          onClick={() => void setEnabled(automation.id, !automation.enabled)}
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium text-xs transition-colors ${
            automation.enabled
              ? "bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20"
              : "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/40"
          }`}
        >
          {automation.enabled ? (
            <>
              <Pause size={13} strokeWidth={2} /> Pause
            </>
          ) : (
            <>
              <Play size={13} strokeWidth={2} /> Resume
            </>
          )}
        </button>
        <button
          onClick={() => void handleRunNow()}
          disabled={!automation.enabled || !!runningNow[automation.id]}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-600 dark:bg-blue-500 text-white hover:bg-blue-700 dark:hover:bg-blue-600 font-medium text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play size={13} strokeWidth={2} />
          {runningNow[automation.id] ? "Running…" : "Run now"}
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-slate-400">
          <span>
            <span className="font-medium text-gray-700 dark:text-slate-200">
              {automation.harness === "claude_code" ? "Claude Code" : "OpenCode"}
            </span>
            {automation.model && <> · {automation.model}</>}
          </span>
          {automation.cwd && (
            <span className="truncate max-w-[200px]" title={automation.cwd}>
              📁 {automation.cwd}
            </span>
          )}
        </div>
        <button
          onClick={() => {
            if (window.confirm("Delete this automation? Its run history is kept.")) {
              void remove(automation.id).then(onDeleted);
            }
          }}
          className="p-2 rounded-lg bg-transparent text-gray-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400 transition-colors"
          title="Delete"
          aria-label="Delete automation"
        >
          <Trash2 size={14} strokeWidth={1.8} />
        </button>
      </div>

      {/* Schedule display */}
      <div className="px-6 py-2.5 border-b border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-white/5 flex-shrink-0">
        <div className="text-[10px] text-gray-500 dark:text-slate-400 uppercase tracking-wider font-bold mb-0.5">
          Schedule
        </div>
        <div className="text-sm text-gray-900 dark:text-white">
          {scheduleLabel(automation.schedule)}
          <span className="ml-2 text-xs text-gray-500 dark:text-slate-400 font-mono">
            ({automation.schedule})
          </span>
        </div>
      </div>

      {/* Past runs */}
      <div className="flex-1 overflow-y-auto sidebar-thin-scroll min-h-0">
        <Suspense
          fallback={
            <div className="p-6 text-center text-sm text-gray-500 dark:text-slate-400">
              <Loader2 size={16} className="inline animate-spin mr-1" /> Loading runs…
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

  const [name, setName] = useState(automation?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [harness, setHarness] = useState(automation?.harness ?? "claude_code");
  const [model, setModel] = useState(automation?.model ?? "");
  const [cwd, setCwd] = useState(automation?.cwd ?? "");
  const [scheduleChoice, setScheduleChoice] = useState<string>(
    automation
      ? SCHEDULE_PRESETS.find((p) => p.cron === automation.schedule)?.cron ?? "custom"
      : SCHEDULE_PRESETS[4].cron,
  );
  const parsedCustom = automation ? parseSimpleCron(automation.schedule) : null;
  const [freq, setFreq] = useState<Freq>(parsedCustom?.freq ?? "daily");
  const [weekday, setWeekday] = useState(parsedCustom?.weekday ?? "1");
  const [time, setTime] = useState(parsedCustom?.time ?? "09:00");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const schedule = scheduleChoice === "custom" ? buildCron(freq, weekday, time) : scheduleChoice;
  const canSave = useMemo(
    () => name.trim() !== "" && prompt.trim() !== "" && schedule !== "",
    [name, prompt, schedule],
  );

  const save = async () => {
    const input: AutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      harness,
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
        if (!created) throw new Error("create failed");
        onCreated?.(created.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-white/20 flex items-center justify-between flex-shrink-0">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          {automation ? "Edit automation" : "New automation"}
        </h3>
        <button
          onClick={onClose}
          className="p-2 rounded-lg text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
          title="Close"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto sidebar-thin-scroll px-6 py-4 space-y-4">
        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly test fix"
            className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 placeholder:text-gray-500 dark:placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
            Prompt
          </label>
          <textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Run the test suite, fix any failing test, and summarize what you changed."
            className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 placeholder:text-gray-500 dark:placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
              Agent
            </label>
            <select
              value={harness}
              onChange={(e) => setHarness(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {HARNESSES.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
              Model
            </label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Harness default"
              className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 placeholder:text-gray-500 dark:placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
            Project folder (working directory)
          </label>
          <select
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">None</option>
            {projects.map((p) => (
              <option key={p.id} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
            Schedule
          </label>
          <select
            value={scheduleChoice}
            onChange={(e) => setScheduleChoice(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.cron} value={p.cron}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </div>

        {scheduleChoice === "custom" && (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
                Frequency
              </label>
              <select
                value={freq}
                onChange={(e) => setFreq(e.target.value as Freq)}
                className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays (Mon–Fri)</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            {freq === "weekly" && (
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
                  Day
                </label>
                <select
                  value={weekday}
                  onChange={(e) => setWeekday(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {WEEKDAYS.map((w) => (
                    <option key={w.dow} value={w.dow}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
                Time
              </label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm text-gray-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        )}

        {scheduleChoice === "custom" && schedule && (
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Runs: {scheduleLabel(schedule)}
          </p>
        )}

        <p className="text-xs text-gray-500 dark:text-slate-400">
          Runs unattended with full-auto permissions, while Conduit is open. Results land in a
          dedicated chat named after this automation.
        </p>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="px-6 py-3 border-t border-gray-200 dark:border-white/20 flex items-center justify-end gap-3 flex-shrink-0">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={!canSave || saving}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
