/**
 * ModelSheet — the ChatGPT-style bottom sheet for picking a session model.
 *
 * Opened from the header's model chip. Providers are grouped Cloud / Local;
 * each provider shows its models as quiet rows and the current selection
 * (from the hook's `meta`) carries an accent check. Tapping a model calls
 * `onSelect(providerId, model)` (→ useSessionChat.setModel) and closes.
 *
 * A local provider that isn't running shows "Stopped — tap to start": the
 * tap first calls `onStartLocal(model, ggufPath)` (→ useRelay.startLocalModel)
 * and then onSelect, flipping that row into an inline "Starting…" state
 * until the sheet closes.
 *
 * Animation: scrim fade + sheet slide-up via the Animated API (no
 * reanimated dependency), inside a transparent Modal. Scrim tap closes.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  Animated,
  ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import { tapLight } from '../../lib/haptics';
import type { ProviderInfo } from '../../hooks/useRelay';

// M4: Ionicons glyph-font wrappers preserving the lucide call-shapes.
const Check = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="checkmark" size={size} color={color} />
);
const CloudIcon = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="cloud-outline" size={size} color={color} />
);
const CpuIcon = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="hardware-chip-outline" size={size} color={color} />
);

export interface ModelSheetProps {
  visible: boolean;
  onClose: () => void;
  providers: ProviderInfo[];
  /** Current selection from useSessionChat's `meta`. */
  currentProvider: string | null;
  currentModel: string | null;
  /** Select a model — the caller wires useSessionChat.setModel. */
  onSelect: (providerId: string, model: string) => void;
  /** Start a stopped local sidecar — the caller wires useRelay.startLocalModel. */
  onStartLocal: (model: string, ggufPath: string) => void;
}

export default function ModelSheet({
  visible,
  onClose,
  providers,
  currentProvider,
  currentModel,
  onSelect,
  onStartLocal,
}: ModelSheetProps) {
  const c = theme.colors;
  // `mounted` keeps the Modal alive while the close animation plays.
  const [mounted, setMounted] = useState(visible);
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const anim = useRef(new Animated.Value(0)).current; // 0 closed · 1 open

  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 240,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) {
        setMounted(false);
        setStartingKey(null);
      }
    });
  }, [visible, anim]);

  const cloud = useMemo(() => providers.filter((p) => !p.is_local), [providers]);
  const local = useMemo(() => providers.filter((p) => p.is_local), [providers]);

  const handleModel = (provider: ProviderInfo, model: string) => {
    tapLight();
    const needsStart = provider.is_local && !provider.is_running;
    if (needsStart) {
      // Start the sidecar first, then switch the session onto it. The
      // desktop answers with LocalModelReady + SessionModelSet; the sheet
      // closes after a beat so the user sees the "Starting…" state.
      setStartingKey(`${provider.id}|${model}`);
      onStartLocal(model, provider.gguf_path ?? '');
      onSelect(provider.id, model);
      setTimeout(() => {
        setStartingKey(null);
        onClose();
      }, 1200);
      return;
    }
    onSelect(provider.id, model);
    onClose();
  };

  const renderProvider = (provider: ProviderInfo) => {
    const isRunning = provider.is_running !== false;
    return (
      <View key={provider.id + (provider.gguf_path ?? '')} style={styles.providerBlock}>
        <View style={styles.providerRow}>
          {provider.is_local ? (
            <CpuIcon size={15} color={isRunning ? c.success : c.textSecondary} />
          ) : (
            <CloudIcon size={15} color={c.textSecondary} />
          )}
          <Text style={[styles.providerName, { color: c.text }]} numberOfLines={1}>
            {provider.display_name}
          </Text>
          {provider.is_local ? (
            <View
              style={[
                styles.localBadge,
                { backgroundColor: isRunning ? c.surface2 : withAlphaLocal(c.warning) },
              ]}
            >
              <Text
                style={[styles.localBadgeText, { color: isRunning ? c.success : c.warning }]}
              >
                {isRunning ? 'Local' : 'Stopped'}
              </Text>
            </View>
          ) : null}
        </View>

        {(provider.models ?? []).map((model) => {
          const key = `${provider.id}|${model}`;
          const isCurrent = provider.id === currentProvider && model === currentModel;
          const isStarting = startingKey === key;
          return (
            <TouchableOpacity
              key={model}
              style={[styles.modelRow, isCurrent && { backgroundColor: c.surface2 }]}
              activeOpacity={0.7}
              onPress={() => handleModel(provider, model)}
            >
              <View style={styles.modelTextWrap}>
                <Text
                  style={[styles.modelName, { color: isCurrent ? c.accent : c.text }]}
                  numberOfLines={1}
                >
                  {model}
                </Text>
                {isStarting ? (
                  <View style={styles.startingRow}>
                    <ActivityIndicator size="small" color={c.accent} />
                    <Text style={[styles.stoppedText, { color: c.accent }]}>Starting…</Text>
                  </View>
                ) : provider.is_local && !isRunning ? (
                  <Text style={[styles.stoppedText, { color: c.textSecondary }]}>
                    Stopped — tap to start
                  </Text>
                ) : null}
              </View>
              {isCurrent ? <Check size={18} color={c.accent} /> : null}
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  const sheetTranslate = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [420, 0],
  });

  if (!mounted) return null;

  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.scrim, { opacity: anim }]}>
          <TouchableOpacity style={styles.scrimTouch} activeOpacity={1} onPress={onClose} />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: c.elevated, transform: [{ translateY: sheetTranslate }] },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: c.border }]} />
          <View style={styles.header}>
            <Text style={[styles.headerTitle, { color: c.text }]}>Model</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={[styles.headerDone, { color: c.accent }]}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
          >
            {providers.length === 0 ? (
              <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                No providers available — connect to your desktop first.
              </Text>
            ) : null}
            {cloud.length > 0 ? (
              <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>Cloud</Text>
            ) : null}
            {cloud.map(renderProvider)}
            {local.length > 0 ? (
              <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>Local</Text>
            ) : null}
            {local.map(renderProvider)}
            <View style={styles.bottomPad} />
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** rgba tint from the current token (kept local — colors are theme-fed). */
function withAlphaLocal(hex: string): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
  return `rgba(${r}, ${g}, ${b}, 0.16)`;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.scrim,
  },
  scrimTouch: { flex: 1 },
  sheet: {
    maxHeight: '70%',
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    paddingBottom: theme.spacing.lg,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginTop: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  headerTitle: {
    ...theme.type.title,
  },
  headerDone: {
    ...theme.type.secondary,
    fontWeight: '600',
  },
  list: { flexGrow: 0 },
  listContent: { paddingHorizontal: theme.spacing.lg },
  sectionLabel: {
    ...theme.type.label,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: theme.spacing.sm,
    marginBottom: 4,
  },
  providerBlock: { marginBottom: theme.spacing.sm },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  providerName: {
    ...theme.type.secondary,
    fontWeight: '600',
    flex: 1,
  },
  localBadge: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  localBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: theme.radius.sm,
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.md,
  },
  modelTextWrap: { flex: 1, marginRight: 8 },
  modelName: {
    fontSize: 15,
    lineHeight: 20,
  },
  startingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  stoppedText: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  emptyText: {
    ...theme.type.secondary,
    textAlign: 'center',
    paddingVertical: theme.spacing.xl,
  },
  bottomPad: { height: theme.spacing.sm },
});
