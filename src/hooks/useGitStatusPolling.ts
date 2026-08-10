// Git status reactivity (§7.11): now event-driven, not polling.
//
// We used to poll `get_git_status` every 8 s for every project. The OS
// filesystem watcher in the backend (src-tauri/src/git_watcher.rs) now
// drives a `project:fs-changed` Tauri event whenever a file under a
// registered project or worktree path changes. We subscribe to that here
// and call `refreshGitStatus` only when something actually changed.
//
// A long heartbeat (60 s) is still kept as a safety net: catches a
// missed subscription, dropped watcher handle, or change that bypassed
// the watcher (rare on macOS / Windows for some rename patterns).
import { useEffect } from "react";
import { useProjectsStore } from "../state/projects";
import { safeListen } from "../lib/ipc";

const HEARTBEAT_MS = 60_000;

export function useGitStatusPolling(): void {
  const projectCount = useProjectsStore((s) => s.projects.length);

  useEffect(() => {
    if (projectCount === 0) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    // Per-project debounce timers: bursts of FS events for the same project
    // (e.g. Vite HMR writes) only trigger one refresh every 3 seconds.
    const projectDebouncers = new Map<string, ReturnType<typeof setTimeout>>();
    let fullDebounce: ReturnType<typeof setTimeout> | null = null;

    void useProjectsStore.getState().refreshGitStatus();

    const debouncedRefreshFor = (projectId: string) => {
      const existing = projectDebouncers.get(projectId);
      if (existing) clearTimeout(existing);
      projectDebouncers.set(projectId, setTimeout(() => {
        projectDebouncers.delete(projectId);
        if (!cancelled) {
          void useProjectsStore.getState().refreshGitStatusFor(projectId);
        }
      }, 3000));
    };

    const debouncedFullRefresh = () => {
      if (fullDebounce) clearTimeout(fullDebounce);
      fullDebounce = setTimeout(() => {
        if (!cancelled) {
          void useProjectsStore.getState().refreshGitStatus();
        }
      }, 3000);
    };

    const setup = async () => {
      const u = await safeListen<string>("project:fs-changed", (changedPath) => {
        if (cancelled) return;
        const ps = useProjectsStore.getState();
        const project = ps.projects.find(
          (p) =>
            p.path === changedPath ||
            changedPath.startsWith(p.path + "\\") ||
            changedPath.startsWith(p.path + "/"),
        );
        if (project) {
          debouncedRefreshFor(project.id);
        } else {
          debouncedFullRefresh();
        }
      });
      if (!cancelled) unlisten = u;
    };
    void setup();

    const heartbeat = window.setInterval(() => {
      void useProjectsStore.getState().refreshGitStatus();
    }, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      for (const t of projectDebouncers.values()) clearTimeout(t);
      if (fullDebounce) clearTimeout(fullDebounce);
      window.clearInterval(heartbeat);
    };
  }, [projectCount]);
}
