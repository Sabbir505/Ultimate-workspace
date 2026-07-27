import React from 'react';
import { View, StyleSheet } from 'react-native';
import { theme } from '../theme';

interface ConnectionIndicatorProps {
  connected: boolean;
  size?: number;
}

export default function ConnectionIndicator({ connected, size = 12 }: ConnectionIndicatorProps) {
  return (
    <View
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: connected ? theme.colors.green : theme.colors.error,
        },
      ]}
    >
      {connected && (
        <View style={[styles.pulse, { width: size * 1.5, height: size * 1.5, borderRadius: (size * 1.5) / 2 }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulse: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: theme.colors.green,
    opacity: 0.3,
  },
});
