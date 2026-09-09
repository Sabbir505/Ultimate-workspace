/**
 * StatusBanner — a slim transient line shown above the composer while the
 * agent is working on a non-streaming step (compaction, file reads, etc.).
 *
 * The desktop emits `SessionChatStatus` with a `reason` (e.g. "compacting")
 * and a human-readable `message` (e.g. "Summarizing 412 messages…"). The
 * phone shows it as a quiet centered pill with a pulsing accent dot.
 *
 * Cleared on the next streaming token (handled in useSessionChat).
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { theme } from '../../theme';

export interface StatusBannerProps {
  message: string;
}

export default function StatusBanner({ message }: StatusBannerProps) {
  const pulse = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.outer}>
      <View
        style={[
          styles.pill,
          { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border },
        ]}
      >
        <Animated.View
          style={[styles.dot, { backgroundColor: theme.colors.accent, opacity: pulse }]}
        />
        <Text style={[styles.text, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: '92%',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  text: {
    ...theme.type.secondary,
    flexShrink: 1,
  },
});
