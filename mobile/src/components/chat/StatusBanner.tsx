/**
 * StatusBanner — a slim transient line shown above the composer while the
 * agent is working on a non-streaming step (compaction, file reads, etc.).
 *
 * The desktop emits `SessionChatStatus` with a `reason` (e.g. "compacting")
 * and a human-readable `message` (e.g. "Summarizing 412 messages…"). The
 * phone shows the message in a small pill with a subtle pulsing dot.
 *
 * Cleared on the next streaming token (handled in useSessionChat).
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Loader } from 'lucide-react-native';
import { theme } from '../theme';

export interface StatusBannerProps {
  message: string;
}

export default function StatusBanner({ message }: StatusBannerProps) {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border },
      ]}
    >
      <Animated.View style={{ opacity: pulse }}>
        <Loader size={13} color={theme.colors.textSecondary} />
      </Animated.View>
      <Text style={[styles.text, { color: theme.colors.textSecondary }]} numberOfLines={1}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  text: { fontSize: 12, flex: 1 },
});
