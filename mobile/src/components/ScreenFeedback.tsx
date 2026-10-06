/**
 * ScreenFeedback — shared loading-state + animation primitives so every data
 * screen follows the same contract:
 *
 *   - first load with no cached data → centered `ScreenLoading` spinner;
 *   - a refresh with data already on screen → data stays put (the screen may
 *     show a small inline spinner), never a full-body spinner or a blank
 *     flash;
 *   - content appears with a short `FadeIn` instead of popping in.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { ActivityIndicator } from 'react-native';
import { theme } from '../theme';

/** Centered loading row for a screen's first load (no cached data yet). */
export function ScreenLoading({ label }: { label?: string }) {
  const c = theme.colors;
  return (
    <View style={styles.center}>
      <ActivityIndicator size="small" color={c.accent} />
      {label ? (
        <Text style={[styles.label, { color: c.textSecondary }]}>{label}</Text>
      ) : null}
    </View>
  );
}

/** Small inline spinner for an in-flight refresh that must not disturb the
 *  data already on screen (desktop-style: the refresh icon area, not the
 *  whole body). */
export function InlineRefreshSpinner() {
  const c = theme.colors;
  return <ActivityIndicator size="small" color={c.textSecondary} style={styles.inline} />;
}

/** Fades its children in on mount (160ms). Mount-scoped: re-renders of the
 *  children never re-run the animation, only the first appearance animates. */
export function FadeIn({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [opacity]);
  return (
    <Animated.View style={[style ?? styles.flex, { opacity }]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingVertical: 56,
  },
  label: { fontSize: 12 },
  inline: { marginVertical: 6 },
  flex: { flex: 1 },
});
