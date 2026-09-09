import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Central haptics vocabulary. Every tap that confirms a decision, every
 * destructive action, and every stream boundary gets exactly one pattern so
 * the phone learns a consistent physical language. All calls are no-ops on
 * platforms/devices without a haptics engine.
 */

export function tapLight() {
  try { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { /* no engine */ }
}

export function tapMedium() {
  try { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch { /* no engine */ }
}

/** Decisions: approve/deny, plan accept, send. */
export function notifySuccess() {
  try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch { /* no engine */ }
}

/** Errors and denies. */
export function notifyError() {
  try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch { /* no engine */ }
}

/** A turn finished / approval arrived while the user was elsewhere. */
export function notifyWarning() {
  try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch { /* no engine */ }
}
