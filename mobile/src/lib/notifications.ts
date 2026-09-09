import { Platform } from 'react-native';

/**
 * Push notifications: the desktop relays approval requests / turn
 * completions / automation results to the phone via Expo's push service when
 * the relay socket is not connected. This module owns the phone side:
 * permission prompt, Android channel, token retrieval, and registration
 * with the desktop over the paired relay.
 *
 * IMPORTANT (Expo Go): remote push is unavailable in Expo Go (Android SDK 53+
 * ships Expo Go WITHOUT the expo-notifications native module), so merely
 * importing it throws and would take down every importer with it. The module
 * is therefore loaded lazily inside try/catch — every API here degrades to a
 * no-op and `isPushSupported()` reports false, letting Settings show an
 * honest caption. In a development/production build the real module loads
 * and everything works.
 */

type NotificationsModule = typeof import('expo-notifications');

// Lazy, guarded load — the ONLY safe way to touch expo-notifications in a
// binary that may not contain its native module (Expo Go).
function loadNotifications(): NotificationsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-notifications') as NotificationsModule;
    // Probing one native-backed call catches "native module missing" builds
    // whose JS import succeeds but every call would throw.
    void mod.AndroidImportance;
    return mod;
  } catch {
    return null;
  }
}

let _notifications: NotificationsModule | null | undefined;
function notifications(): NotificationsModule | null {
  if (_notifications === undefined) _notifications = loadNotifications();
  return _notifications;
}

/** False in Expo Go / builds without the notifications native module. */
export function isPushSupported(): boolean {
  return notifications() !== null;
}

// Foreground presentation is a JS-only config, but it still touches the
// module — guard it so Expo Go never sees the call.
try {
  notifications()?.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch { /* unavailable — pushes simply won't present in-app */ }

async function ensureAndroidChannel(mod: NotificationsModule): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await mod.setNotificationChannelAsync('default', {
      name: 'Relay alerts',
      description: 'Approvals, completions and budget alerts from your desktop',
      importance: mod.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: true,
    });
  } catch { /* channel exists or not supported */ }
}

export async function requestPushPermission(): Promise<boolean> {
  const mod = notifications();
  if (!mod) return false;
  try {
    await ensureAndroidChannel(mod);
    const settings = await mod.getPermissionsAsync();
    if (settings.granted) return true;
    if (settings.status === mod.PermissionStatus.DENIED) return false;
    const req = await mod.requestPermissionsAsync();
    return !!req.granted;
  } catch {
    return false;
  }
}

/**
 * Expo push token for this device/install, or null when unavailable
 * (permission denied, Expo Go, emulator without Play Services).
 */
export async function getPushTokenAsync(): Promise<string | null> {
  const mod = notifications();
  if (!mod) return null;
  try {
    const granted = await requestPushPermission();
    if (!granted) return null;
    const token = await mod.getExpoPushTokenAsync();
    return token.data ?? null;
  } catch {
    return null;
  }
}

/** The Expo push token is stable per device — cache the registration so we
 *  only send it to the desktop once per token value. */
const REGISTERED_KEY = 'push.registeredToken';

export async function isTokenRegistered(token: string): Promise<boolean> {
  try {
    const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
    return (await AsyncStorage.getItem(REGISTERED_KEY)) === token;
  } catch {
    return false;
  }
}

export async function markTokenRegistered(token: string): Promise<void> {
  try {
    const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
    await AsyncStorage.setItem(REGISTERED_KEY, token);
  } catch { /* non-fatal */ }
}

/** Fire when a push arrives while the app is open — the caller surfaces it
 *  as a toast instead of a duplicate OS banner. No-op when unsupported. */
export function onForegroundPush(handler: (title: string, body: string) => void): () => void {
  const mod = notifications();
  if (!mod) return () => {};
  try {
    const sub = mod.addNotificationReceivedListener((n) => {
      handler(n.request.content.title ?? 'Relay', n.request.content.body ?? '');
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}
