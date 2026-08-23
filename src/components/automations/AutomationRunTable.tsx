// Past Runs table — one row per automation_runs entry. Click a row that has
// a chat session attached to open the run log in the chat view.
import {
  CheckCircle2,
  ExternalLink,
  Hourglass,
  Loader2,
  XCircle,
  Zap,
} from "lucide-react";
import type { AutomationRun } from "../../lib/ipc";
import { friendlyRunError, isFailureStatus } from "./shared";

function formatDuration(startSec: number, endSec: number | null): string {
  if (!endSec) return "—";
  const diff = endSec - startSec;
  // Failures can finish in well under a second; "0s" reads as broken.
  if (diff < 1) return "<1s";
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${Math.floor(diff % 60)}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

function formatStartedAt(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadge(status: string): {
  className: string;
  icon: JSX.Element;
  label: string;
} {
  if (status === "running") {
    return {
      className:
        "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300",
      icon: <Loader2 size={11} className="animate-spin" strokeWidth={2.5} />,
      label: "Running",
    };
  }
  if (status === "ok") {
    return {
      className:
        "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300",
      icon: <CheckCircle2 size={11} strokeWidth={2.5} />,
      label: "OK",
    };
  }
  if (status === "skipped") {
    return {
      className:
        "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300",
      icon: <Hourglass size={11} strokeWidth={2.5} />,
      label: "Skipped",
    };
  }
  return {
    className: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300",
    icon: <XCircle size={11} strokeWidth={2.5} />,
    label: "Error",
  };
}

export function AutomationRunTable({
  runs,
  loading,
  onOpenRunLog,
}: {
  runs: AutomationRun[];
  loading: boolean;
  onOpenRunLog: (chatSessionId: string) => void;
}) {
  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2
          size={20}
          className="animate-spin text-gray-400 dark:text-slate-500"
        />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 px-4">
        <Zap size={28} strokeWidth={1.5} className="text-gray-300 dark:text-slate-500" />
        <p className="text-sm text-gray-500 dark:text-slate-400">No runs yet</p>
        <p className="text-xs text-gray-400 dark:text-slate-500 text-center">
          The run log will appear here the next time this automation fires.
        </p>
      </div>
    );
  }

  return (
    <div className="px-6 py-4">
      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-slate-300 mb-3">
        Past runs
        <span className="ml-2 text-xs font-medium text-gray-400 dark:text-slate-500 normal-case tracking-normal">
          ({runs.length})
        </span>
      </h3>

      <div className="rounded-lg border border-gray-200 dark:border-white/20 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-white/5 text-gray-500 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Status
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Started
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Duration
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Source
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Summary
              </th>
              <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">
                Log
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-white/20">
            {runs.map((r) => {
              const badge = statusBadge(r.status);
              const failed = isFailureStatus(r.status);
              // Raw error text stays in the tooltip; the cell shows the
              // plain-language translation so users can act on it.
              const friendly = failed ? friendlyRunError(r.summary || r.status) : null;
              return (
                <tr
                  key={r.id}
                  className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                >
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge.className}`}
                    >
                      {badge.icon} {badge.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-slate-200 whitespace-nowrap">
                    {formatStartedAt(r.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-slate-200 whitespace-nowrap font-mono text-xs">
                    {formatDuration(r.startedAt, r.finishedAt)}
                  </td>
                  <td className="px-3 py-2 text-gray-500 dark:text-slate-400 text-xs">
                    {r.source === "manual" ? "Manual" : "Scheduled"}
                  </td>
                  <td
                    className="px-3 py-2 text-gray-700 dark:text-slate-200 text-xs max-w-[280px] truncate"
                    title={r.summary}
                  >
                    {friendly ? friendly.text : (r.summary || (r.status === "running" ? "In progress…" : "—"))}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.chatSessionId ? (
                      <button
                        onClick={() => onOpenRunLog(r.chatSessionId!)}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        title="Open run log"
                      >
                        Open <ExternalLink size={11} strokeWidth={1.8} />
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400 dark:text-slate-500">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
