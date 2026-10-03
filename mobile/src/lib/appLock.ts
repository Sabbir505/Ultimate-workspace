import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

/**
 * App lock: require Face ID / fingerprint / device passcode before the app
 * becomes usable after backgrounding. The phone can approve shell commands
 * on the desktop, so an unlocked phone in someone else's hands is a remote
 * shell in their hands — the lock is the cheapest fix for that.
 *
 * The flag is stored in AsyncStorage (not a secure enclave) because the flag
 * itself grants nothing — the biometric check is the gate. Losing it just
 * means re-toggling the setting.
 */

const APP_LOCK_ENABLED_KEY = 'security.appLockEnabled';
/** When the app was last backgrounded — PERSISTED (audit H39). */
const APP_LOCK_AWAY_KEY = 'security.appLockAwayAt';
/** How long the app may be backgrounded before re-locking (ms). */
const RELOCK_GRACE_MS = 30_000;

export async function isAppLockEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(APP_LOCK_ENABLED_KEY)) === 'true';
  } catch {
    return false;
  }
}

export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(APP_LOCK_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch { /* storage unavailable — setting won't persist */ }
}

/** Does this device have *something* to authenticate with? */
export async function deviceCanAuthenticate(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return hasHardware && enrolled;
  } catch {
    return false;
  }
}

/** Run the biometric/passcode prompt. Resolves true only on success. */
export async function authenticate(reason: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      // Fall back to the device passcode when biometrics fail twice — the
      // user must never be locked out of their own desktop.
      fallbackLabel: 'Use passcode',
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}

// The away-stamp lives in module memory AND AsyncStorage (audit H39):
// module memory is wiped when the OS kills the backgrounded process, so a
// force-quit + relaunch never fired the gate — `shouldLockOnResume` saw
// `null` and returned false, and the lock could be bypassed by simply
// killing the app first.
let backgroundedAt: number | null = null;

/** Call from AppState 'background' — stamps when the app went away. */
export function markBackgrounded(): void {
  const now = Date.now();
  backgroundedAt = now;
  void AsyncStorage.setItem(APP_LOCK_AWAY_KEY, String(now)).catch(
    () => { /* storage unavailable — the in-memory stamp still covers a
               background→foreground cycle */ },
  );
}

/** Clear both away stamps (lock satisfied — the app is unlocked again). */
export function clearAwayStamp(): void {
  backgroundedAt = null;
  void AsyncStorage.removeItem(APP_LOCK_AWAY_KEY).catch(() => {});
}

/**
 * Call from AppState 'active'. Returns true when the lock gate should show
 * (app lock on + was away longer than the grace window). Reads the persisted
 * stamp too, so a force-quit while backgrounded (or an OS process kill)
 * still locks on relaunch — the exact bypass the memory-only stamp allowed.
 */
export async function shouldLockOnResume(): Promise<boolean> {
  if (!(await isAppLockEnabled())) return false;
  const now = Date.now();
  let away = backgroundedAt;
  if (away === null) {
    const stored = await AsyncStorage.getItem(APP_LOCK_AWAY_KEY).catch(() => null);
    away = stored ? Number(stored) : null;
  }
  backgroundedAt = null;
  await AsyncStorage.removeItem(APP_LOCK_AWAY_KEY).catch(() => {});
  if (away === null || Number.isNaN(away)) return false;
  return now - away > RELOCK_GRACE_MS;
}

export const appLockPlatformName = Platform.OS === 'ios' ? 'Face ID' : 'Biometrics';
