/**
 * ModelSheet — the phone's twin of the desktop AgentModelPicker popover.
 *
 * Same anatomy as the desktop popup, compacted for a phone screen and
 * docked just above the composer:
 *
 *   ┌──────────────────────────────────────┐
 *   │ AGENTS │ [ Search N models… ]        │
 *   │  (CC)  │  Opus 4.8        config  ✓  │
 *   │  (KC)  │  Haiku          builtin     │
 *   │ API    │  ↳ via api2.sharkai.cc      │
 *   │  (O)   ├─────────────────────────────┤
 *   │ LOCAL  │ Effort ●—●—●—●—●—●          │
 *   │  (GG)  │      Def Low Med High… Max  │
 *   └────────┴─────────────────────────────┘
 *
 * The left rail lists every way a turn can run — one entry per CLI harness
 * (the CLI's OWN model catalog, endpoint footnote, and effort tiers, exactly
 * the desktop harness pane), one per cloud endpoint, and the local GGUF
 * sidecar. Tapping a rail entry switches the right pane. Tapping a model
 * COMMITS the pick: `onSelect(providerId, model)` where a harness pick
 * carries `harness:<id>` as the provider (the desktop commits agent+model
 * together for the same reason). The effort slider mirrors the desktop's
 * SegmentedSlider — colored fill to the active stop, white knob, labels
 * under the stops — and commits live via `onEffortChange` without closing.
 *
 * A local provider that isn't running shows a "stopped" tag: the tap first
 * calls `onStartLocal(model, ggufPath)` (→ useRelay.startLocalModel) and
 * then onSelect, flipping that row into a "Starting…" spinner state.
 *
 * Animation: scrim fade + card rise/scale via the Animated API (no
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
  TextInput,
  useWindowDimensions,
  StyleProp,
  ViewStyle,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import { tapLight } from '../../lib/haptics';
import { railBrandIcon } from '../AgentIcons';
import {
  onHarnessModels,
  onDomainError,
  useRelay,
  type HarnessModelsPayload,
  type HarnessInfo,
  type AcpAgentInfo,
  type ProviderInfo,
} from '../../hooks/useRelay';

// M4: Ionicons glyph-font wrapper preserving the lucide check call-shape.
const Check = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="checkmark" size={size} color={color} />
);

export interface ModelSheetProps {
  visible: boolean;
  onClose: () => void;
  providers: ProviderInfo[];
  /** ACP agents (desktop picker "Agents · ACP" rail) — `acp:<id>`. */
  acpAgents?: AcpAgentInfo[];
  /** CLI harnesses from AvailableProviders (desktop rail parity). */
  harnesses?: HarnessInfo[];
  /** Current selection from useSessionChat's `meta` ('harness:<id>' counts). */
  currentProvider: string | null;
  currentModel: string | null;
  /** Select a model — the caller wires useSessionChat.setModel. */
  onSelect: (providerId: string, model: string) => void;
  /** Start a stopped local sidecar — the caller wires useRelay.startLocalModel. */
  onStartLocal: (model: string, ggufPath: string) => void;
  /** Reasoning effort ('' = provider default) — seeds the slider. */
  effort?: string;
  /** Commit an effort stop live (picker stays open), desktop parity. */
  onEffortChange?: (effort: string) => void;
}

/** Desktop-style display name: "deepseek/deepseek-v4.1-flash" →
 *  "Deepseek V4.1 Flash"; a leading "~" (unpriced marker) is dropped. */
function prettyModel(model: string): string {
  let name = model.startsWith('~') ? model.slice(1) : model;
  if (name.includes('/')) name = name.slice(name.indexOf('/') + 1);
  return name
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Compact stop labels + colors for harness effort tiers — the desktop's
 *  HARNESS_EFFORT_LABELS / HARNESS_EFFORT_COLORS tables. */
const HARNESS_TIER_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};
const HARNESS_TIER_COLORS: Record<string, string> = {
  off: '#94a3b8',
  minimal: '#38bdf8',
  low: '#22c55e',
  medium: '#f59e0b',
  high: '#ef4444',
  xhigh: '#a855f7',
  max: '#ec4899',
};

/** Cloud-provider slider stops (Def/Low/Med/High) or harness tiers
 *  (Def + Off…Max narrowed to the CLI's vocabulary). */
function effortStops(textDim: string, tiers?: string[]) {
  const def = { value: '', label: 'Def', color: textDim };
  if (!tiers || tiers.length === 0) {
    return [
      def,
      { value: 'low', label: 'Low', color: HARNESS_TIER_COLORS.low },
      { value: 'medium', label: 'Med', color: HARNESS_TIER_COLORS.medium },
      { value: 'high', label: 'High', color: HARNESS_TIER_COLORS.high },
    ];
  }
  return [
    def,
    ...tiers.map((t) => ({
      value: t,
      label: HARNESS_TIER_LABELS[t] ?? t,
      color: HARNESS_TIER_COLORS[t] ?? '#ef4444',
    })),
  ];
}

/** Rail entries: every way a turn can run, desktop rail order. */
type RailEntry =
  | { kind: 'harness'; id: string; label: string; installed: boolean }
  | { kind: 'acp'; id: string; label: string; installed: boolean }
  | { kind: 'provider'; provider: ProviderInfo };

export default function ModelSheet({
  visible,
  onClose,
  providers,
  acpAgents = [],
  harnesses,
  currentProvider,
  currentModel,
  onSelect,
  onStartLocal,
  effort,
  onEffortChange,
}: ModelSheetProps) {
  const c = theme.colors;
  const { requestHarnessModels } = useRelay();
  const { width: screenW } = useWindowDimensions();
  // `mounted` keeps the Modal alive while the close animation plays.
  const [mounted, setMounted] = useState(visible);
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // The active rail entry id ('harness:<id>' or the provider id).
  const [paneId, setPaneId] = useState<string | null>(null);
  // Harness catalogs seen so far — seeded from the warm AvailableProviders
  // cache, topped up from ListHarnessModels when a pane opens cold.
  const [harnessCfgs, setHarnessCfgs] = useState<Record<string, HarnessModelsPayload>>({});
  const [pendingHarness, setPendingHarness] = useState<string | null>(null);
  const anim = useRef(new Animated.Value(0)).current; // 0 closed · 1 open

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // Fresh search + the current selection's pane per open — a stale pane
      // or filter hid every row.
      setQuery('');
      setPaneId(currentProvider ?? null);
    }
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) {
        setMounted(false);
        setStartingKey(null);
      }
    });
  }, [visible, anim, currentProvider]);

  // Harness pane catalog: replies land via the bus (one subscription for the
  // sheet's lifetime — putting it in the request effect let setPendingHarness
  // tear it down before the reply arrived). The request effect fires once per
  // pane (guarded by requestedRef), regardless of the `installed` flag, which
  // reads false from a cold relay cache until the desktop's warm-up lands.
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!visible) return;
    const off = onHarnessModels.on((p) => {
      setHarnessCfgs((m) => ({ ...m, [p.harnessId]: p }));
      setPendingHarness((cur) => (cur === p.harnessId ? null : cur));
    });
    // A failed probe answers with a domain ChatError and NO HarnessModels
    // frame, so nothing cleared `pendingHarness` — the pane spun forever.
    // Drop the pending flag on the failure so the empty-state copy shows.
    const offErr = onDomainError.on(({ domain }) => {
      if (domain !== 'harness-models') return;
      setPendingHarness(null);
    });
    return () => { off(); offErr(); };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    if (!paneId?.startsWith('harness:')) return;
    const id = paneId.slice('harness:'.length);
    if (harnessCfgs[id] || requestedRef.current.has(id)) return;
    requestedRef.current.add(id);
    setPendingHarness(id);
    requestHarnessModels(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, paneId, harnessCfgs]);

  // Rail: AGENTS (harnesses) → API (cloud) → LOCAL, desktop rail order.
  const rail = useMemo<{ section: string; entry: RailEntry }[]>(() => {
    const rows: { section: string; entry: RailEntry }[] = [];
    for (const h of harnesses ?? []) {
      rows.push({
        section: 'AGENTS',
        entry: { kind: 'harness', id: h.id, label: h.display_name, installed: h.installed },
      });
    }
    for (const a of acpAgents) {
      rows.push({
        section: 'ACP',
        entry: { kind: 'acp', id: a.id, label: a.display_name, installed: a.installed },
      });
    }
    const seen = new Set<string>();
    const uniq = providers.filter((p) => {
      const key = p.id + (p.gguf_path ?? '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const p of uniq.filter((p) => !p.is_local)) {
      rows.push({ section: 'API', entry: { kind: 'provider', provider: p } });
    }
    for (const p of uniq.filter((p) => p.is_local)) {
      rows.push({ section: 'LOCAL', entry: { kind: 'provider', provider: p } });
    }
    return rows;
  }, [harnesses, acpAgents, providers]);

  const activeEntry = useMemo<RailEntry | null>(() => {
    if (paneId == null) return rail[0]?.entry ?? null;
    return (
      rail.find(
        (r) =>
          (r.entry.kind === 'harness' && `harness:${r.entry.id}` === paneId) ||
          (r.entry.kind === 'acp' && `acp:${r.entry.id}` === paneId) ||
          (r.entry.kind === 'provider' && r.entry.provider.id === paneId),
      )?.entry ?? rail[0]?.entry ?? null
    );
  }, [rail, paneId]);

  // --- pane rows (search applies to both kinds) ---
  const activeProviderPane = activeEntry?.kind === 'provider' ? activeEntry.provider : null;
  const activeHarnessId = activeEntry?.kind === 'harness' ? activeEntry.id : null;
  const activeAcpId = activeEntry?.kind === 'acp' ? activeEntry.id : null;
  const activeHarnessCfg = activeHarnessId ? harnessCfgs[activeHarnessId] : undefined;
  const activeHarnessMeta = useMemo(
    () => harnesses?.find((h) => h.id === activeHarnessId),
    [harnesses, activeHarnessId],
  );
  const harnessNotInstalled =
    activeHarnessId != null &&
    activeHarnessMeta != null &&
    !activeHarnessMeta.installed;

  const providerRows = useMemo(() => {
    if (!activeProviderPane) return [];
    const q = query.trim().toLowerCase();
    const all = activeProviderPane.models ?? [];
    if (!q) return all;
    return all.filter(
      (m) => m.toLowerCase().includes(q) || prettyModel(m).toLowerCase().includes(q),
    );
  }, [activeProviderPane, query]);

  const harnessRows = useMemo(() => {
    if (!activeHarnessId) return [];
    const q = query.trim().toLowerCase();
    const rows = activeHarnessCfg?.models ?? [];
    if (!q) return rows;
    return rows.filter(
      (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
    );
  }, [activeHarnessId, activeHarnessCfg, query]);

  const paneCount = activeProviderPane
    ? (activeProviderPane.models ?? []).length
    : (activeHarnessCfg?.models ?? activeHarnessMeta?.models ?? []).length;

  const handleModel = (providerId: string, model: string) => {
    tapLight();
    const provider = rail.find((r) => r.entry.kind === 'provider' && r.entry.provider.id === providerId)?.entry as
      | Extract<RailEntry, { kind: 'provider' }>
      | undefined;
    const needsStart = provider?.provider.is_local && provider.provider.is_running === false;
    if (needsStart && provider) {
      // Start the sidecar first, then switch the session onto it. The
      // desktop answers with LocalModelReady + SessionModelSet; the sheet
      // closes after a beat so the user sees the "Starting…" state.
      setStartingKey(`${providerId}|${model}`);
      onStartLocal(model, provider.provider.gguf_path ?? '');
      onSelect(providerId, model);
      setTimeout(() => {
        setStartingKey(null);
        onClose();
      }, 1200);
      return;
    }
    onSelect(providerId, model);
    onClose();
  };

  const cardScale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] });
  // Slides UP from the composer edge — the desktop popup grows out of the
  // chip, and both call sites keep their composer at the bottom.
  const cardRise = anim.interpolate({ inputRange: [0, 1], outputRange: [48, 0] });

  // Effort slider stops for the ACTIVE pane: provider panes get the flat
  // Def/Low/Med/High ladder; harness panes get the CLI's own tiers (the
  // picked model's per-model tiers when it publishes any).
  // (Above the early return — hooks must run unconditionally.)
  const activeStops = useMemo(() => {
    if (activeHarnessCfg) {
      const row = harnessRows.find((r) => r.id === currentModel);
      const tiers =
        currentProvider === `harness:${activeHarnessId}` &&
        row?.thinking &&
        row.thinking.length > 0
          ? row.thinking
          : activeHarnessCfg.effortOptions;
      return effortStops(c.textSecondary, tiers);
    }
    return effortStops(c.textSecondary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHarnessCfg, harnessRows, currentModel, currentProvider, activeHarnessId, c.textSecondary]);

  if (!mounted) return null;

  const cardW = Math.min(344, screenW - 28);

  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.scrim, { opacity: anim }]}>
          <TouchableOpacity style={styles.scrimTouch} activeOpacity={1} onPress={onClose} />
        </Animated.View>
        {/* box-none: the dock is a full-screen flex column, so without this
            it sits on top of the scrim and swallows every tap outside the
            card — scrim-tap-to-dismiss never fired, and on the chat screen
            the leftover modal also blocked the header. The card itself still
            receives touches (box-none only disables the VIEW's own). */}
        <View style={styles.bottomDock} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.card,
              {
                width: cardW,
                backgroundColor: c.elevated,
                opacity: anim,
                transform: [{ translateY: cardRise }, { scale: cardScale }],
              },
            ]}
          >
            <View style={styles.panes}>
              {/* Left rail — AGENTS / API / LOCAL, desktop rail parity. */}
              <ScrollView
                style={[styles.rail, { borderRightColor: c.border }]}
                contentContainerStyle={styles.railContent}
                showsVerticalScrollIndicator={false}
              >
                {rail.map((r, i) => {
                  const prevSection = i > 0 ? rail[i - 1].section : null;
                  const showSection = r.section !== prevSection;
                  const e = r.entry;
                  const id = e.kind === 'harness' ? `harness:${e.id}` : e.kind === 'acp' ? `acp:${e.id}` : e.provider.id;
                  const active = activeEntry != null && id === paneId;
                  const dim = (e.kind === 'harness' || e.kind === 'acp') && !e.installed;
                  return (
                    <React.Fragment key={id + i}>
                      {showSection ? (
                        <Text style={[styles.railSection, { color: c.textSecondary }]}>
                          {r.section}
                        </Text>
                      ) : null}
                      <TouchableOpacity
                        style={[styles.railItem, active && { backgroundColor: c.surface2 }]}
                        onPress={() => { tapLight(); setQuery(''); setPaneId(id); }}
                        accessibilityRole="button"
                        accessibilityLabel={`${e.kind === 'provider' ? e.provider.display_name : e.label} models`}
                      >
                        {/* Real brand marks, desktop rail parity (railIcon()):
                            monogram only when no glyph exists for the key. */}
                        <View
                          style={[
                            styles.railAvatar,
                            { backgroundColor: active ? c.accent : c.surface2, opacity: dim ? 0.45 : 1 },
                          ]}
                        >
                          {(() => {
                            const iconKey =
                              e.kind === 'harness'
                                ? `harness:${e.id}`
                                : e.kind === 'acp'
                                  ? `acp:${e.id}`
                                  : e.provider.is_local
                                    ? 'local'
                                    : e.provider.id;
                            const brand = railBrandIcon(iconKey, {
                              color: active ? c.white : c.text,
                              size: 15,
                            });
                            if (brand) return brand;
                            return (
                              <Text
                                style={[
                                  styles.railAvatarText,
                                  { color: active ? c.white : c.text },
                                ]}
                              >
                                {(e.kind === 'provider' ? e.provider.display_name : e.label)
                                  .charAt(0)
                                  .toUpperCase()}
                              </Text>
                            );
                          })()}
                        </View>
                      </TouchableOpacity>
                    </React.Fragment>
                  );
                })}
              </ScrollView>

              {/* Right pane — search, model rows, endpoint footnote. */}
              <View style={styles.pane}>
                <View style={[styles.searchField, { backgroundColor: c.surface2, borderColor: c.border }]}>
                  <Ionicons name="search" size={14} color={c.textSecondary} />
                  <TextInput
                    style={[styles.searchInput, { color: c.text }]}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={`Search ${paneCount} models…`}
                    placeholderTextColor={c.textSecondary}
                    autoCorrect={false}
                    autoCapitalize="none"
                  />
                </View>
                <ScrollView
                  style={styles.modelList}
                  contentContainerStyle={styles.modelListContent}
                  keyboardShouldPersistTaps="handled"
                >
                  {rail.length === 0 ? (
                    <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                      No agents — connect to your desktop first.
                    </Text>
                  ) : null}

                  {/* Provider pane rows (cloud + local). */}
                  {activeProviderPane
                    ? providerRows.map((model) => {
                        const provider = activeProviderPane;
                        const isCurrent =
                          provider.id === currentProvider && model === currentModel;
                        const isStarting = startingKey === `${provider.id}|${model}`;
                        const stopped = provider.is_local && provider.is_running === false;
                        return (
                          <TouchableOpacity
                            key={model}
                            style={[styles.modelRow, isCurrent && { backgroundColor: c.surface2 }]}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={`Model ${prettyModel(model)}${provider.is_local ? ' (local)' : ''}`}
                            onPress={() => handleModel(provider.id, model)}
                          >
                            <Text
                              numberOfLines={1}
                              style={[styles.modelName, { color: isCurrent ? c.accent : c.text }]}
                            >
                              {prettyModel(model)}
                            </Text>
                            {isStarting ? (
                              <ActivityIndicator size="small" color={c.accent} />
                            ) : stopped ? (
                              <View style={styles.rowTag}>
                                <Text style={[styles.rowTagText, { color: c.warning }]}>stopped</Text>
                              </View>
                            ) : isCurrent ? (
                              <Check size={16} color={c.accent} />
                            ) : null}
                          </TouchableOpacity>
                        );
                      })
                    : null}

                  {/* Harness pane rows — the CLI's own catalog, with the
                      desktop's config/cli/builtin badges. */}
                  {activeHarnessId
                    ? harnessRows.map((row) => {
                        const harnessProviderId = `harness:${activeHarnessId}`;
                        const isCurrent =
                          harnessProviderId === currentProvider &&
                          (row.id === currentModel || row.label === currentModel);
                        return (
                          <TouchableOpacity
                            key={row.id}
                            style={[styles.modelRow, isCurrent && { backgroundColor: c.surface2 }]}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={`Model ${row.label} (${row.source})`}
                            onPress={() => handleModel(harnessProviderId, row.id)}
                          >
                            <Text
                              numberOfLines={1}
                              style={[styles.modelName, { color: isCurrent ? c.accent : c.text }]}
                            >
                              {row.label}
                            </Text>
                            <View style={styles.rowTag}>
                              <Text style={[styles.rowTagText, { color: c.textSecondary }]}>
                                {row.source}
                              </Text>
                            </View>
                            {isCurrent ? <Check size={16} color={c.accent} /> : null}
                          </TouchableOpacity>
                        );
                      })
                    : null}

                  {/* ACP pane — the agent owns model selection (desktop parity). */}
                  {activeAcpId ? (
                    <TouchableOpacity
                      style={[styles.modelRow, { backgroundColor: c.surface2 }]}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${activeAcpId}'s default model`}
                      onPress={() => handleModel(`acp:${activeAcpId}`, 'auto')}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.modelName, { color: c.text }]}>
                          Use the agent's own model
                        </Text>
                        <Text style={{ color: c.textSecondary, fontSize: 11, marginTop: 1 }}>
                          ACP agent — model selection belongs to the agent
                        </Text>
                      </View>
                      {currentProvider === `acp:${activeAcpId}` ? (
                        <Ionicons name="checkmark" size={16} color={c.accent} />
                      ) : null}
                    </TouchableOpacity>
                  ) : null}

                  {/* Harness pane states: cold probe / empty catalog. */}
                  {activeHarnessId && pendingHarness === activeHarnessId ? (
                    <View style={styles.paneState}>
                      <ActivityIndicator size="small" color={c.accent} />
                    </View>
                  ) : null}
                  {activeHarnessId &&
                  !pendingHarness &&
                  harnessRows.length === 0 ? (
                    <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                      No models configured — this CLI may not be installed on
                      the desktop yet.
                    </Text>
                  ) : null}

                  {rail.length > 0 &&
                  ((activeProviderPane && providerRows.length === 0) ||
                    (activeHarnessId && harnessRows.length === 0 && pendingHarness !== activeHarnessId)) &&
                  !(activeHarnessId && harnessNotInstalled) ? (
                    <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                      No models match.
                    </Text>
                  ) : null}

                  {/* Endpoint footnote — the CLI's own relay for AGENTS panes,
                      the provider name for API panes. */}
                  {activeHarnessCfg?.endpoint || activeProviderPane ? (
                    <View style={styles.endpoint}>
                      <Text style={[styles.endpointText, { color: c.textSecondary }]}>
                        ↳ via {activeHarnessCfg?.endpoint ?? activeProviderPane?.display_name}
                      </Text>
                    </View>
                  ) : null}
                </ScrollView>
              </View>
            </View>

            {/* Effort slider — the desktop SegmentedSlider footer. */}
            {onEffortChange ? (
              <View style={[styles.effortDivider, { borderTopColor: c.border }]} />
            ) : null}
            {onEffortChange ? (
              <EffortSlider
                value={effort ?? ''}
                stops={activeStops}
                onChange={(v) => { tapLight(); onEffortChange(v); }}
                trackColor={c.surface2}
                borderColor={c.border}
                knobColor={c.white}
                labelColor={c.textSecondary}
              />
            ) : null}
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

/** Phone twin of the desktop SegmentedSlider: a pill track with a colored
 *  fill up to the active stop, a white knob, dot-marked stops, and labels
 *  under them. Tap any of the n equal zones to jump to that stop. */
function EffortSlider({
  value,
  stops,
  onChange,
  trackColor,
  borderColor,
  knobColor,
  labelColor,
}: {
  value: string;
  stops: { value: string; label: string; color: string }[];
  onChange: (v: string) => void;
  trackColor: string;
  borderColor: string;
  knobColor: string;
  labelColor: string;
}) {
  const n = stops.length;
  let active = stops.findIndex((s) => s.value === value);
  if (active < 0) active = 0;
  const f = n <= 1 ? 0.5 : active / (n - 1);
  const activeColor = stops[active]?.color ?? borderColor;

  return (
    <View style={styles.effort}>
      <View style={styles.effortHead}>
        <Text style={[styles.effortTitle, { color: labelColor }]}>Effort</Text>
        <Text style={[styles.effortValue, { color: activeColor }]}>
          {stops[active]?.label}
        </Text>
      </View>
      <View style={styles.effortTrackWrap}>
        <View
          style={[
            styles.effortTrack,
            { backgroundColor: trackColor, borderColor },
          ]}
        >
          <View style={[styles.effortFill, { backgroundColor: activeColor, width: `${f * 100}%` }]} />
          {stops.map((_, i) => {
            const p = n <= 1 ? 0.5 : i / (n - 1);
            return (
              <View
                key={i}
                style={[
                  styles.effortDot,
                  {
                    left: `${p * 100}%`,
                    backgroundColor: i <= active ? knobColor : borderColor,
                  },
                ]}
              />
            );
          })}
          <View style={[styles.effortKnob, { left: `${f * 100}%`, backgroundColor: knobColor }]} />
          {/* n equal tap zones over the track. */}
          <View style={styles.effortZones}>
            {stops.map((s, i) => (
              <TouchableOpacity
                key={s.value + i}
                style={styles.effortZone}
                onPress={() => { if (s.value !== value) onChange(s.value); }}
                accessibilityRole="button"
                accessibilityLabel={`Effort ${s.label}`}
              />
            ))}
          </View>
        </View>
        <View style={styles.effortLabels}>
          {stops.map((s, i) => {
            const p = n <= 1 ? 0.5 : i / (n - 1);
            const style: StyleProp<ViewStyle> = { left: `${p * 100}%` };
            if (i === 0) style.alignItems = 'flex-start';
            else if (i === n - 1) style.alignItems = 'flex-end';
            else style.alignItems = 'center';
            return (
              <View key={s.label + i} style={[styles.effortLabel, style]}>
                <Text
                  style={[
                    styles.effortLabelText,
                    { color: i === active ? s.color : labelColor, fontWeight: i === active ? '700' : '400' },
                  ]}
                >
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
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
  // Docked just above the composer — a small gap reads as "attached" to it,
  // like the desktop popup growing out of the chip.
  bottomDock: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  card: {
    maxHeight: '82%',
    borderRadius: 16,
    overflow: 'hidden',
    // Desktop popup shadow: a soft, tight drop.
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  panes: {
    flexDirection: 'row',
    minHeight: 170,
    maxHeight: 290,
    // When the card's max height bites, the model LIST shrinks — the effort
    // footer below it must never be the thing that gets cut off.
    flexShrink: 1,
    overflow: 'hidden',
  },
  rail: {
    width: 58,
    flexGrow: 0,
    borderRightWidth: 1,
  },
  railContent: {
    paddingVertical: 8,
    alignItems: 'center',
    gap: 6,
  },
  railSection: {
    fontSize: 7.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginTop: 6,
  },
  railItem: {
    borderRadius: 10,
    padding: 3,
  },
  railAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
  railAvatarText: { fontSize: 12, fontWeight: '700' },
  pane: {
    flex: 1,
    minHeight: 0,
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    marginHorizontal: 10,
    marginTop: 10,
  },
  searchInput: { flex: 1, padding: 0, fontSize: 13 },
  modelList: {
    // A ScrollView with flexGrow:0 takes its FULL content height — inside
    // the fixed-height pane it overflowed and covered the effort footer
    // ("something is getting cut off"). Shrink-to-fit is the fix.
    flexGrow: 0,
    flexShrink: 1,
  },
  modelListContent: {
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: theme.radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 8,
  },
  modelName: {
    flex: 1,
    fontSize: 13.5,
    lineHeight: 18,
  },
  rowTag: {
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  rowTagText: {
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  paneState: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  endpoint: {
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 6,
  },
  endpointText: { fontSize: 11 },
  emptyText: {
    fontSize: 12.5,
    textAlign: 'center',
    paddingVertical: 14,
  },

  // --- effort slider ---
  effortDivider: {
    borderTopWidth: 1,
  },
  effort: {
    // Never shrink: this is the row that used to get clipped ("Effort Def"
    // collapsed to half a header when the pane list grew long).
    flexShrink: 0,
    paddingTop: 8,
    paddingBottom: 10,
  },
  effortHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    marginBottom: 6,
  },
  effortTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  effortValue: { fontSize: 11, fontWeight: '700' },
  effortTrackWrap: {
    marginHorizontal: 13,
  },
  effortTrack: {
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    overflow: 'hidden',
  },
  effortFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 11,
  },
  effortDot: {
    position: 'absolute',
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginLeft: -2.5,
    top: 8.5,
  },
  effortKnob: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    top: 2,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  effortZones: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  effortZone: { flex: 1 },
  effortLabels: {
    height: 14,
    marginTop: 3,
  },
  effortLabel: {
    position: 'absolute',
    width: 60,
    marginLeft: -30,
  },
  effortLabelText: { fontSize: 9.5 },
});
