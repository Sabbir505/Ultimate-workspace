/**
 * TtsSettingsCard — the read-aloud settings surface (desktop Settings →
 * Local Models → Speech → Text-to-speech parity, phone form).
 *
 * Two controls, both applied by the shared player in lib/tts and persisted:
 *   - Speaking rate (0.5×–2×, ∈0.25 steps) — a running read switches rate
 *     mid-sentence, so this is worth trying immediately.
 *   - Voice — the phone's own installed TTS voices (the same list the OS
 *     settings show), with "System default" restoring the OS choice.
 * A preview button speaks a sample line with the current settings.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Text, View, StyleSheet, TouchableOpacity, ScrollView, Modal } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import {
  getTtsState, subscribeTts, setRate, setVoice, speak, stopSpeaking,
  RATE_MIN, RATE_MAX, RATE_STEP, type TtsState,
} from '../lib/tts';
import { tapLight } from '../lib/haptics';

const PREVIEW_TEXT = 'This is how Relay reads answers aloud — rates and voices change the sound, not the words.';

interface VoiceInfo {
  identifier: string;
  name: string;
  language: string;
  quality?: string;
}

/** Android's voice ids are `en-us-x-sfg#female_1`, `en-us-x-sfg#female_2`, …
 *  and expo-speech reports `identifier === name` (VoiceRecord.kt), so what
 *  looks like one voice appears once per SERVICE SLOT: the trailing `_N`
 *  (1 = local, 2+ = network) is the SAME voice a second time. Picking either
 *  is indistinguishable — and a network-only slot can even be refused by the
 *  engine (`firstOrNull { it.name == voiceName }` misses, so the default
 *  voice silently plays), which is "I chose a different voice and heard the
 *  same one". Collapse those slots into a single row per real voice, always
 *  keeping the LOCAL slot (it is guaranteed to resolve) and Enhanced quality. */
function dedupeVoices(list: VoiceInfo[], preferredId?: string | null): VoiceInfo[] {
  // `en-us-x-sfg#female_1` -> `en-us-x-sfg#female`
  const baseKey = (v: VoiceInfo) => `${v.name.replace(/_\d+$/, '')}::${v.language}`;
  // Local slot (no `_N` suffix, or `_1`) always resolves; Enhanced beats
  // Default; the saved selection wins outright.
  const rank = (v: VoiceInfo) =>
    (v.identifier === preferredId ? 100 : 0) +
    (v.quality === 'Enhanced' ? 10 : 0) +
    (/_(\d{2,})$/.test(v.name) ? 0 : 1);
  const best = new Map<string, VoiceInfo>();
  for (const v of list) {
    const key = baseKey(v);
    const cur = best.get(key);
    if (!cur || rank(v) > rank(cur)) best.set(key, v);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

export default function TtsSettingsCard() {
  const c = theme.colors;
  const [s, setS] = useState<TtsState>(getTtsState);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  // Attempt the OS voice query AT MOST once per mount. The old effect
  // depended on [pickerOpen, voices.length, voicesLoading]: a phone that
  // reports ZERO voices (common on Android / Expo Go) flipped
  // voicesLoading true→false with voices.length still 0, so the effect
  // re-ran, called setVoicesLoading(true) again, and React's
  // "Maximum update depth exceeded" guard killed the app. A ref breaks
  // the cycle regardless of what the effect deps do.
  const voicesFetched = useRef(false);

  useEffect(() => subscribeTts(setS), []);

  // Lazy-load the voice list the first time the picker opens.
  useEffect(() => {
    if (!pickerOpen || voicesFetched.current || voicesLoading) return;
    voicesFetched.current = true;
    setVoicesLoading(true);
    void (async () => {
      try {
        const { getAvailableVoicesAsync } = await import('expo-speech');
        const list = await getAvailableVoicesAsync();
        setVoices(
          dedupeVoices(
            list.map((v) => ({
              identifier: v.identifier,
              name: v.name,
              language: v.language,
              quality: v.quality,
            })),
            // Pass the active selection through the dedupe (read at call time,
            // not captured) so the chosen variant survives the collapse.
            getTtsState().voice,
          ),
        );
      } catch {
        setVoices([]);
      } finally {
        setVoicesLoading(false);
      }
    })();
  }, [pickerOpen, voicesLoading]);

  const activeVoice = voices.find((v) => v.identifier === s.voice) ?? null;
  const atMin = s.rate <= RATE_MIN;
  const atMax = s.rate >= RATE_MAX;

  return (
    <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
      {/* Rate */}
      <View style={styles.row}>
        <Ionicons name="speedometer-outline" size={18} color={c.textSecondary} />
        <Text style={[styles.label, { color: c.text }]}>Speaking rate</Text>
        <View style={styles.stepper}>
          <TouchableOpacity
            style={[styles.stepBtn, atMin && { opacity: 0.4 }]}
            disabled={atMin}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Slower"
            onPress={() => { tapLight(); void setRate(s.rate - RATE_STEP); }}
          >
            <Text style={[styles.stepText, { color: c.text }]}>−</Text>
          </TouchableOpacity>
          <Text style={[styles.rateValue, { color: c.text }]}>{s.rate.toFixed(2)}×</Text>
          <TouchableOpacity
            style={[styles.stepBtn, atMax && { opacity: 0.4 }]}
            disabled={atMax}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Faster"
            onPress={() => { tapLight(); void setRate(s.rate + RATE_STEP); }}
          >
            <Text style={[styles.stepText, { color: c.text }]}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.divider, { backgroundColor: c.border }]} />

      {/* Voice */}
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Choose read-aloud voice"
        onPress={() => { tapLight(); setPickerOpen(true); }}
      >
        <Ionicons name="person-outline" size={18} color={c.textSecondary} />
        <Text style={[styles.label, { color: c.text }]}>Voice</Text>
        <Text style={[styles.value, { color: c.textSecondary }]} numberOfLines={1}>
          {activeVoice ? `${activeVoice.name} (${activeVoice.language})` : 'System default'}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={c.textSecondary} />
      </TouchableOpacity>

      <View style={[styles.divider, { backgroundColor: c.border }]} />

      {/* Preview */}
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Preview read-aloud"
        onPress={() => {
          tapLight();
          if (s.phase === 'speaking') {
            stopSpeaking();
          } else {
            speak('tts:preview', PREVIEW_TEXT, 'Voice preview');
          }
        }}
      >
        <Ionicons name={s.phase === 'speaking' ? 'stop' : 'play'} size={18} color={c.accent} />
        <Text style={[styles.label, { color: c.accent }]}>
          {s.phase === 'speaking' ? 'Stop preview' : 'Hear a preview'}
        </Text>
      </TouchableOpacity>

      {/* Voice picker */}
      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={[styles.modalScrim, { backgroundColor: c.scrim }]}>
          <View style={[styles.sheet, { backgroundColor: c.elevated }]}>
            <View style={styles.sheetHead}>
              <Text style={[styles.sheetTitle, { color: c.text }]}>Read-aloud voice</Text>
              <TouchableOpacity
                onPress={() => setPickerOpen(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Close voice picker"
              >
                <Ionicons name="close" size={20} color={c.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.voiceList}>
              <TouchableOpacity
                style={styles.voiceRow}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="System default voice"
                onPress={() => { tapLight(); void setVoice(null); setPickerOpen(false); }}
              >
                <Text style={[styles.voiceName, { color: c.text }]}>System default</Text>
                {s.voice == null ? <Ionicons name="checkmark" size={17} color={c.accent} /> : null}
              </TouchableOpacity>
              {voicesLoading ? (
                <Text style={[styles.voiceHint, { color: c.textSecondary }]}>Loading voices…</Text>
              ) : null}
              {!voicesLoading && voices.length === 0 ? (
                <Text style={[styles.voiceHint, { color: c.textSecondary }]}>
                  This phone reports no extra voices — the system default is all that's installed.
                </Text>
              ) : null}
              {voices.map((v) => (
                <TouchableOpacity
                  key={v.identifier}
                  style={styles.voiceRow}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${v.name} (${v.language})`}
                  onPress={() => {
                    tapLight();
                    void setVoice(v.identifier);
                    setPickerOpen(false);
                    // Audition the picked voice right away.
                    speak('tts:preview', PREVIEW_TEXT, `Voice preview · ${v.name}`);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.voiceName, { color: c.text }]} numberOfLines={1}>{v.name}</Text>
                    <Text style={[styles.voiceLang, { color: c.textSecondary }]}>
                      {v.language}{v.quality && v.quality !== 'Default' ? ` · ${v.quality}` : ''}
                    </Text>
                  </View>
                  {s.voice === v.identifier ? <Ionicons name="checkmark" size={17} color={c.accent} /> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  label: { fontSize: 14, fontWeight: '600', flex: 1 },
  value: { fontSize: 13, maxWidth: 170 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 18, fontWeight: '700', lineHeight: 20 },
  rateValue: { fontSize: 14, fontWeight: '700', minWidth: 52, textAlign: 'center', fontVariant: ['tabular-nums'] },
  modalScrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '75%',
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    paddingBottom: 32,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.spacing.md,
  },
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  voiceList: { paddingHorizontal: theme.spacing.md },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  voiceName: { fontSize: 14, fontWeight: '600' },
  voiceLang: { fontSize: 12, marginTop: 1 },
  voiceHint: { fontSize: 13, paddingVertical: 14, lineHeight: 19 },
});
