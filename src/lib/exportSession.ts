// Session export (§7.14): dump the focused terminal pane's transcript as
// markdown via the backend's stripped transcript buffer, then save through
// the native save dialog + fs plugin.
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportSessionMarkdown } from "../lib/ipc";
import { sessionDisplayTitle } from "../lib/sessionTitle";
import { usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";

/** Local-date "YYYY-MM-DD" for export filenames. toISOString() is UTC —
 *  between local midnight and UTC midnight it stamped YESTERDAY's date. */
export function formatLocalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultFileName(sessionId: string): string {
  const store = useProjectsStore.getState();
  const session = store.sessions.find((s) => s.id === sessionId);
  const project = store.projectById(session?.projectId ?? null);
  const date = formatLocalDate(new Date());
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  return `${slug(project?.name ?? "project")}-${slug(sessionDisplayTitle(session?.title ?? null))}-${date}.md`;
}

/** Export the focused pane's session to a .md file. Returns true on success. */
export async function exportFocusedSession(): Promise<boolean> {
  const { focusedPaneId, panes } = usePanesStore.getState();
  const pane = panes.find((p) => p.paneId === focusedPaneId);
  if (!pane || pane.data.kind !== "terminal" || !pane.data.sessionId) return false;

  try {
    const markdown = await exportSessionMarkdown(pane.paneId);
    if (!markdown) return false;
    const path = await save({
      defaultPath: defaultFileName(pane.data.sessionId),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return false;
    await writeTextFile(path, markdown);
    return true;
  } catch (err) {
    console.warn("session export failed", err);
    return false;
  }
}
