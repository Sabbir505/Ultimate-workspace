// Git status polling (§7.11): refreshes branch/dirty/ahead/behind badges for
// the projects in the sidebar roughly every 8 seconds.
import { useEffect } from "react";
import { useProjectsStore } from "../state/projects";

const POLL_INTERVAL_MS = 8000;

export function useGitStatusPolling(): void {
  const projectCount = useProjectsStore((s) => s.projects.length);

  useEffect(() => {
    if (projectCount === 0) return;
    void useProjectsStore.getState().refreshGitStatus();
    const timer = window.setInterval(() => {
      void useProjectsStore.getState().refreshGitStatus();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [projectCount]);
}
