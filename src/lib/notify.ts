// Shared OS-toast helper. Wraps @tauri-apps/plugin-notification with lazy
// permission request and a hard catch so callers in dev browsers (where the
// plugin is unavailable) don't crash — badges/in-app surfaces still update.
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export async function osNotify(title: string, body: string): Promise<void> {
  try {
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
