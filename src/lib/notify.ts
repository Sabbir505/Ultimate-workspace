// Shared OS-toast helper. Wraps @tauri-apps/plugin-notification with lazy
// permission request and a hard catch so callers in dev browsers (where the
// plugin is unavailable) don't crash — badges/in-app surfaces still update.
//
// Windows routes through the os_toast Rust command instead: the plugin only
// passes the app's AppUserModelID for installed builds, so dev-run toasts
// fell back to its PowerShell identity (wrong name + logo). See
// src-tauri/src/os_toast.rs.
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

const IS_WINDOWS =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

export async function osNotify(title: string, body: string): Promise<void> {
  try {
    if (IS_WINDOWS) {
      await invoke("os_toast", { title, body });
      return;
    }
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    if (granted) sendNotification({ title, body });
  } catch {
    // Notification plugin unavailable (e.g. dev browser) — ignore.
  }
}
