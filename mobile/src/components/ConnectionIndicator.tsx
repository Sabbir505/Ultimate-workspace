import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme, useTheme } from '../theme';
import { useRelay } from '../hooks/useRelay';

interface ConnectionIndicatorProps {
  /** Optional override — defaults to the live relay connection state. */
  connected?: boolean;
  /** Mid-flight handhake state (dot turns amber). */
  connecting?: boolean;
  size?: number;
  /** Show the state label ("Connected" / "Connecting…" / "Offline"). */
  showLabel?: boolean;
}

/**
 * Quiet dot (+ optional label) for the relay connection — three states:
 *   connected  filled green
 *   connecting filled amber
 *   offline    hollow gray
 */
export default function ConnectionIndicator({
  connected,
  connecting = false,
  size = 10,
  showLabel = false,
}: ConnectionIndicatorProps) {
  useTheme(); // subscribe so theme.colors is reactive
  const relayConnected = useRelay().connected;
  const isOn = connected ?? relayConnected;
  const c = theme.colors;

  const color = isOn ? c.success : connecting ? c.warning : c.gray;
  const label = isOn ? 'Connected' : connecting ? 'Connecting…' : 'Offline';

  return (
    <View style={styles.row}>
      <View
        style={[
          isOn || connecting
            ? { backgroundColor: color }
            : { borderColor: color, borderWidth: 1.5 },
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
      />
      {showLabel && (
        <Text style={[styles.label, { color: c.textSecondary }, theme.type.label]}>
          {label}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: { textTransform: 'none' },
});
