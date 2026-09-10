// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke } from "../ipcCore";

// ---- Chat export / import (local-first backup, roadmap #7) ----

/** Export one chat session to a `.zip` at a user-chosen location. Returns
 *  true if saved, false if the user cancelled. */
export async function exportChatZip(
  sessionId: string,
  defaultName = `${Date.now()}-chat.zip`,
): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: defaultName,
    filters: [{ name: "Relay backup", extensions: ["zip"] }],
  });
  if (!dest) return false;
  await safeInvoke<void>("export_chat_zip", { sessionId, dest });
  return true;
}

/** Export every chat bound to a project to a `.zip` at a user-chosen location.
 *  Returns true if saved, false if the user cancelled. */
export async function exportProjectZip(
  projectId: string,
  defaultName = `${Date.now()}-project-backup.zip`,
): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: defaultName,
    filters: [{ name: "Relay backup", extensions: ["zip"] }],
  });
  if (!dest) return false;
  await safeInvoke<void>("export_project_zip", { projectId, dest });
  return true;
}

/** Import a chat-export `.zip` (single chat or whole project). Opens a picker
 *  and returns the `chat_session` ids it restored, or `null` if cancelled. */
export async function importChatZip(): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const src = await open({
    multiple: false,
    filters: [{ name: "Relay backup", extensions: ["zip"] }],
    title: "Select a Relay backup (.zip) to restore",
  });
  if (typeof src !== "string" || !src) return null;
  return safeInvoke<string[]>("import_chat_zip", { src });
}
