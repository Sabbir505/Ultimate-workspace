/**
 * Secure storage wrapper (SS5.22): the pairing token (embedded in the relay
 * URL fragment) is a bearer credential for the desktop, so it belongs in the
 * OS keychain via expo-secure-store — not AsyncStorage, which is plain
 * SQLite/defaults on both platforms.
 *
 * Migration is one-way and self-healing: every read of a secure key checks
 * AsyncStorage for a legacy copy, moves it into SecureStore, and deletes the
 * AsyncStorage original. Deletes remove BOTH copies so a "cleared" value
 * cannot resurrect from the legacy store.
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** SecureStore key for the paired desktop URL (contains the token fragment). */
export const SECURE_RELAY_URL_KEY = 'relay.secure.relayUrl';
/** The AsyncStorage key the pre-secure-store build stored that URL under. */
export const LEGACY_PLAIN_RELAY_URL_KEY = 'relay.relayUrl';

/** Read a secure value, migrating the legacy AsyncStorage copy if present. */
export async function getSecureRelayUrl(): Promise<string | null> {
  try {
    const stored = await SecureStore.getItemAsync(SECURE_RELAY_URL_KEY);
    if (stored) return stored;
  } catch {
    // Keychain unavailable (simulator quirk, device policy) — fall through to
    // the legacy copy so pairing still works, just unencrypted at rest.
  }
  try {
    const legacy = await AsyncStorage.getItem(LEGACY_PLAIN_RELAY_URL_KEY);
    if (legacy) {
      void setSecureRelayUrl(legacy);
      return legacy;
    }
  } catch {
    // AsyncStorage failure → treat as unset.
  }
  return null;
}

/** Persist the value in SecureStore and remove any legacy AsyncStorage copy. */
export async function setSecureRelayUrl(value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(SECURE_RELAY_URL_KEY, value);
    await AsyncStorage.removeItem(LEGACY_PLAIN_RELAY_URL_KEY).catch(() => {});
  } catch {
    // Keychain write failed — degrade to the legacy key rather than losing
    // the pairing (same failure tier as the old build).
    await AsyncStorage.setItem(LEGACY_PLAIN_RELAY_URL_KEY, value).catch(() => {});
  }
}

/** Remove the value from BOTH stores (no resurrection). */
export async function deleteSecureRelayUrl(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SECURE_RELAY_URL_KEY);
  } catch {
    // Absent/keychain unavailable — nothing to do.
  }
  await AsyncStorage.removeItem(LEGACY_PLAIN_RELAY_URL_KEY).catch(() => {});
}
