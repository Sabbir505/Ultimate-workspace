/**
 * useProjects — the shared project-list subscription (ListProjects +
 * onProjectList / onProjectUpserted / onProjectRemoved merge logic) used by
 * both the new-chat sheet and the ProjectManager. Subscribes only while
 * `visible` so a closed sheet stops holding server state updates.
 */
import { useEffect, useState } from 'react';
import {
  useRelay,
  onProjectList,
  onProjectUpserted,
  onProjectRemoved,
  type ProjectInfo,
} from './useRelay';

export function useProjects(visible: boolean): ProjectInfo[] {
  const { listProjects } = useRelay();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  useEffect(() => {
    if (!visible) return;
    listProjects();
    const offList = onProjectList.on(({ projects: list }) => setProjects(list));
    const offUpsert = onProjectUpserted.on(({ project }) =>
      setProjects((prev) => {
        const idx = prev.findIndex((p) => p.id === project.id);
        if (idx < 0) return [...prev, project];
        const next = [...prev];
        next[idx] = project;
        return next;
      }),
    );
    const offRemoved = onProjectRemoved.on(({ projectId }) =>
      setProjects((prev) => prev.filter((p) => p.id !== projectId)),
    );
    return () => { offList(); offUpsert(); offRemoved(); };
  }, [visible, listProjects]);

  return projects;
}
