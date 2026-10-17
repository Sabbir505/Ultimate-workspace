/**
 * TtsSpeakingPill — the global read-aloud transport (desktop TtsPlayerBar
 * parity, phone form).
 *
 * One small pill floating above the bottom edge while anything is being
 * read: what's playing, sentence progress, a rate stepper (the phone's
 * speaker rate, 0.5×–2×), and stop. It lives at the app shell so the read
 * keeps going (and stays stoppable) while the user navigates between
 * screens — the desktop keeps its player bar shell-level for the same
 * reason.
 */
import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { getTtsState, subscribeTts, nudgeRate, stopSpeaking, RATE_STEP, RATE_MIN, RATE_MAX, type TtsState } from '../lib/tts';
import { tapLight } from '../lib/haptics';

export default function TtsSpeakingPill() {
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const [s, setS] = useState<TtsState>(getTtsState);

  useEffect(() => subscribeTts(setS), []);

  if (s.phase !== 'speaking' || !s.key) return null;

  const atMax = s.rate >= RATE_MAX;
  const atMin = s.rate <= RATE_MIN;

  return (
    <View
      style={[styles.dock, { bottom: Math.max(insets.bottom, 8) + 8 }]}
      pointerEvents="box-none"
    >
      <View style={[styles.pill, { backgroundColor: c.elevated, borderColor: c.border }]}>
        <Ionicons name="play" size={16} color={c.accent} />
        <Text style={[styles.label, { color: c.text }]} numberOfLines={1}>
          {s.label ?? 'Reading aloud'}
        </Text>
        <Text style={[styles.progress, { color: c.textSecondary }]}>
          {s.chunkCount > 0 ? `${s.chunkIndex + 1}/${s.chunkCount}` : ''}
        </Text>
        <TouchableOpacity
          style={styles.rateBtn}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`Speech rate ${s.rate.toFixed(2)} times — tap to change`}
          onPress={() => { tapLight(); nudgeRate(atMax ? RATE_MIN - s.rate : RATE_STEP); }}
        >
          <Text style={[styles.rate, { color: c.text }]}>{s.rate.toFixed(2).replace(/0$/, '')}×</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.stopBtn, { backgroundColor: c.surface2 }]}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Stop reading aloud"
          onPress={() => { tapLight(); stopSpeaking(); }}
        >
          <Ionicons name="stop" size={13} color={c.text} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 40,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 12,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  label: { fontSize: 13, fontWeight: '600', maxWidth: 180 },
  progress: { fontSize: 11, fontVariant: ['tabular-nums'] },
  rateBtn: { paddingHorizontal: 2 },
  rate: { fontSize: 13, fontWeight: '700' },
  stopBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
