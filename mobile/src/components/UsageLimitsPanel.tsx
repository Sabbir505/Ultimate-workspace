/**
 * UsageLimitsPanel — the phone twin of the desktop's UsageLimitsPanel.
 *
 * Metered sources (API providers + harness CLIs) with three layers each:
 *   1. Plan snapshot — credits / the vendor's own period totals.
 *   2. Rolling windows Relay measured locally (1h / 24h / 7d / 30d).
 *   3. Windows the provider/CLI REPORTED (resets, plan limits), plus any
 *      user-configured caps, tinted ok / warn / crit by threshold.
 *
 * Caps are edited inline (window segmented control + $ / requests unit +
 * warn %), written back through the relay's SetUsageLimit arm and persisted
 * desktop-side, so a cap set on the phone governs the desktop too. The
 * desktop shows a generic tooltip for each hint; the phone uses a11y labels
 * on every control instead.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import {
  onUsageMeters, onUsageLimitsAck, useRelay,
  type UsageMeterPayload, type UsageCapState, type UsageTier, type UsageLimitAlertPayload,
} from '../hooks/useRelay';
import { tapLight, tapMedium } from '../lib/haptics';
import { formatTokens } from '../lib/format';

/** "resets in 2h 10m" / "resetting" (desktop usageResetSuffix parity). */
function resetSuffix(resetsAt: number | null | undefined): string | null {
  if (resetsAt == null) return null;
  const secs = resetsAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return 'resetting';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const label = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  return `resets in ${label}`;
}

const WINDOW_KEYS: [keyof UsageMeterPayload['windows'], string][] = [
  ['lastHour', '1h'],
  ['lastDay', '24h'],
  ['lastWeek', '7d'],
  ['lastMonth', '30d'],
];

/** Rolling-window token total: cache reads + creation count as input volume
 *  (desktop tokenTotal parity — a cache hit is still a token). */
function windowTokens(w: UsageMeterPayload['windows'][keyof UsageMeterPayload['windows']]): number {
  return w.inputTokens + w.outputTokens + w.cacheReadTokens + w.cacheCreationTokens + w.reasoningTokens;
}

const tierColor = (tier: UsageTier | string | null | undefined, c: { success: string; warning: string; error: string }) =>
  tier === 'crit' ? c.error : tier === 'warn' ? c.warning : c.success;

/** Unit-aware cap display: the payload carries whichever unit the cap is in. */
function capLine(cap: UsageCapState): string {
  if (cap.capUsd != null) return `$${cap.usedUsd?.toFixed(2) ?? '0.00'} of $${cap.capUsd.toFixed(2)}`;
  if (cap.capTokens != null) return `${formatTokens(cap.usedTokens ?? 0)} of ${formatTokens(cap.capTokens)}`;
  if (cap.capRequests != null) return `${cap.usedRequests ?? 0} of ${cap.capRequests} requests`;
  return `${cap.usedPct.toFixed(1)}% used`;
}

function CapEditor({
  target,
  initial,
  onCancel,
}: {
  target: string;
  initial: UsageCapState | null;
  onCancel: () => void;
}) {
  const c = theme.colors;
  const { setUsageLimit, removeUsageLimit } = useRelay();
  const [windowKey, setWindowKey] = useState(initial?.window ?? 'day');
  const [capUsd, setCapUsd] = useState(initial?.capUsd != null ? String(initial.capUsd) : '');
  const [capReq, setCapReq] = useState(initial?.capRequests != null ? String(initial.capRequests) : '');
  const [warn, setWarn] = useState(String(Math.round(initial?.thresholdPct ?? 80)));
  const [saving, setSaving] = useState(false);

  const submit = () => {
    setSaving(true);
    setUsageLimit(
      target,
      windowKey,
      capUsd ? Number(capUsd) : null,
      null,
      capReq ? Number(capReq) : null,
      warn ? Number(warn) : null,
    );
  };

  return (
    <View style={[styles.capEditor, { backgroundColor: c.surface2, borderColor: c.border }]}>
      <View style={styles.segRow}>
        {(['hour', 'day', 'week', 'month'] as const).map((w) => (
          <TouchableOpacity
            key={w}
            style={[styles.seg, windowKey === w && { backgroundColor: c.accent }]}
            accessibilityRole="button"
            accessibilityState={{ selected: windowKey === w }}
            accessibilityLabel={`Cap window ${w}`}
            onPress={() => { tapLight(); setWindowKey(w); }}
          >
            <Text style={{ color: windowKey === w ? c.white : c.textSecondary, fontSize: 11, fontWeight: '700' }}>{w}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.capFields}>
        <View style={styles.capField}>
          <Text style={[styles.capFieldLabel, { color: c.textSecondary }]}>Cap $</Text>
          <TextInput
            style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.elevated }]}
            placeholder="0 = none"
            placeholderTextColor={c.textSecondary}
            keyboardType="decimal-pad"
            value={capUsd}
            onChangeText={setCapUsd}
          />
        </View>
        <View style={styles.capField}>
          <Text style={[styles.capFieldLabel, { color: c.textSecondary }]}>Cap requests</Text>
          <TextInput
            style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.elevated }]}
            placeholder="0 = none"
            placeholderTextColor={c.textSecondary}
            keyboardType="number-pad"
            value={capReq}
            onChangeText={setCapReq}
          />
        </View>
        <View style={styles.capField}>
          <Text style={[styles.capFieldLabel, { color: c.textSecondary }]}>Warn %</Text>
          <TextInput
            style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.elevated }]}
            placeholder="80"
            placeholderTextColor={c.textSecondary}
            keyboardType="number-pad"
            value={warn}
            onChangeText={setWarn}
          />
        </View>
      </View>
      <View style={styles.capActions}>
        <TouchableOpacity
          style={[styles.capBtn, { backgroundColor: c.accent }, saving && { opacity: 0.6 }]}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save cap"
          onPress={() => { tapMedium(); submit(); }}
        >
          {saving ? <ActivityIndicator size="small" color={c.white} /> : <Text style={{ color: c.white, fontWeight: '700', fontSize: 12 }}>Save cap</Text>}
        </TouchableOpacity>
        {initial ? (
          <TouchableOpacity
            style={[styles.capBtn, { borderColor: c.border, borderWidth: 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Remove cap"
            onPress={() => { tapLight(); removeUsageLimit(target, initial.window); }}
          >
            <Text style={{ color: c.error, fontWeight: '700', fontSize: 12 }}>Remove</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={styles.capBtn}
          accessibilityRole="button"
          accessibilityLabel="Cancel cap edit"
          onPress={() => { tapLight(); onCancel(); }}
        >
          <Text style={{ color: c.textSecondary, fontWeight: '600', fontSize: 12 }}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function MeterCard({ meter }: { meter: UsageMeterPayload }) {
  const c = theme.colors;
  const [editing, setEditing] = useState(false);
  // The first configured cap for this source (the desktop shows them all; the
  // phone edits one at a time, which is what the inline editor supports).
  const cap = meter.caps[0] ?? null;
  const nearLimit = meter.caps.some((k) => k.tier === 'crit') ? 'crit'
    : meter.caps.some((k) => k.tier === 'warn') ? 'warn' : null;

  return (
    <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
      <View style={styles.cardHead}>
        <Text style={[styles.cardLabel, { color: c.text }]} numberOfLines={1}>{meter.label}</Text>
        {meter.plan ? (
          <View style={[styles.chip, { borderColor: c.border }]}>
            <Text style={{ color: c.textSecondary, fontSize: 10, fontWeight: '600' }}>{meter.plan.planName}</Text>
          </View>
        ) : null}
        {meter.plan && meter.plan.creditsRemaining != null ? (
          <View style={[styles.chip, { borderColor: c.border }]}>
            <Text style={{ color: c.textSecondary, fontSize: 10, fontWeight: '600' }}>
              ${meter.plan.creditsRemaining.toFixed(2)} left
            </Text>
          </View>
        ) : null}
      </View>

      {/* Provider-reported account totals for the current period. */}
      {meter.plan && (meter.plan.requestsTotal != null || meter.plan.tokensTotal != null || meter.plan.costTotalUsd != null) ? (
        <Text style={[styles.accountLine, { color: c.textSecondary }]}>
          {meter.plan.requestsTotal != null ? `${formatTokens(meter.plan.requestsTotal)} runs` : ''}
          {meter.plan.tokensTotal != null ? ` · ${formatTokens(meter.plan.tokensTotal)} tokens` : ''}
          {meter.plan.costTotalUsd != null ? ` · $${meter.plan.costTotalUsd.toFixed(2)} spent` : ''}
        </Text>
      ) : null}

      {/* Rolling windows Relay measured. */}
      <View style={styles.windowGrid}>
        {WINDOW_KEYS.map(([key, label]) => {
          const w = meter.windows[key];
          const tokens = windowTokens(w);
          return (
            <View key={String(key)} style={[styles.windowCell, { borderColor: c.border }]}>
              <Text style={{ color: c.textSecondary, fontSize: 10, fontWeight: '700' }}>{label}</Text>
              <Text style={{ color: c.text, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
                {formatTokens(tokens)}
              </Text>
              <Text style={{ color: c.textSecondary, fontSize: 10 }} numberOfLines={1}>
                {w.costUsd > 0 ? `$${w.costUsd.toFixed(2)}` : `${w.requests} req`}
              </Text>
            </View>
          );
        })}
      </View>

      {/* Configured caps with the threshold tick. */}
      {meter.caps.map((k) => (
        <View key={`${k.window}-${k.capUsd}-${k.capTokens}-${k.capRequests}`} style={styles.capRow}>
          <View style={styles.capHead}>
            <View style={[styles.tick, { backgroundColor: tierColor(k.tier, c) }]} />
            <Text style={{ color: c.text, fontSize: 12, fontWeight: '600', textTransform: 'capitalize' }}>{k.window} cap</Text>
            <Text style={{ color: c.textSecondary, fontSize: 11 }}>{capLine(k)}</Text>
          </View>
          <View style={[styles.bar, { backgroundColor: c.border }]}>
            <View
              style={[
                styles.barFill,
                { backgroundColor: tierColor(k.tier, c), width: `${Math.min(100, k.usedPct)}%` },
              ]}
            />
            <View style={[styles.thresholdTick, { left: `${k.thresholdPct}%`, backgroundColor: c.text }]} />
          </View>
          <Text style={{ color: c.textSecondary, fontSize: 10 }}>
            {k.usedPct.toFixed(1)}% used · warn at {Math.round(k.thresholdPct)}%
          </Text>
        </View>
      ))}

      {/* Windows the provider/CLI reported. */}
      {meter.reported.map((w) => (
        <View key={`${w.window}-${w.label}-${w.source}`} style={styles.reportedRow}>
          <Text style={{ color: c.text, fontSize: 12, fontWeight: '600', flex: 1 }} numberOfLines={1}>
            {w.label}
          </Text>
          {w.limit != null && w.used != null ? (
            <Text style={{ color: c.textSecondary, fontSize: 11 }}>
              {w.usedPct != null ? `${w.usedPct.toFixed(1)}% · ` : ''}
              {w.unit === 'usd' ? `$${w.used.toFixed(2)} of $${w.limit.toFixed(2)}` : `${formatTokens(w.used)} of ${formatTokens(w.limit)}`}
            </Text>
          ) : null}
          {w.limit == null && w.remaining != null ? (
            <Text style={{ color: c.textSecondary, fontSize: 11 }}>{formatTokens(w.remaining)} left</Text>
          ) : null}
          {w.status === 'exceeded' ? (
            <Text style={{ color: c.error, fontSize: 11, fontWeight: '700' }}>limit reached</Text>
          ) : null}
          {resetSuffix(w.resetsAt) ? (
            <Text style={{ color: c.textSecondary, fontSize: 10 }}>{resetSuffix(w.resetsAt)}</Text>
          ) : null}
        </View>
      ))}

      {meter.health ? (
        <View style={styles.healthRow}>
          <Ionicons name="warning-outline" size={12} color={c.error} />
          <Text style={{ color: c.error, fontSize: 11, flex: 1 }} numberOfLines={2}>{meter.health}</Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.setCapBtn, { borderColor: c.border }]}
        accessibilityRole="button"
        accessibilityLabel={cap ? `Edit cap for ${meter.label}` : `Set cap for ${meter.label}`}
        onPress={() => { tapLight(); setEditing((v) => !v); }}
      >
        <Text style={{ color: c.accent, fontSize: 12, fontWeight: '700' }}>{cap ? 'Edit cap' : 'Set cap'}</Text>
      </TouchableOpacity>

      {editing ? <CapEditor target={meter.target} initial={cap} onCancel={() => setEditing(false)} /> : null}
      {nearLimit ? (
        <View style={[styles.nearLimit, { borderColor: tierColor(nearLimit, c) }]}>
          <Text style={{ color: tierColor(nearLimit, c), fontSize: 10, fontWeight: '700' }}>near limit</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function UsageLimitsPanel() {
  const c = theme.colors;
  const { getUsageMeters, checkUsageLimits, refreshUsageWindows } = useRelay();
  const [meters, setMeters] = useState<UsageMeterPayload[]>([]);
  const [alerts, setAlerts] = useState<UsageLimitAlertPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  React.useEffect(() => {
    const off = onUsageMeters.on((m) => { setMeters(m.meters); setAlerts(m.alerts); setLoading(false); setError(null); });
    return off;
  }, []);
  React.useEffect(() => {
    setLoading(true);
    getUsageMeters();
    // `nonce` is the manual-refresh trigger: the bus reply settles the fetch.
  }, [nonce]);
  React.useEffect(() => {
    const off = onUsageLimitsAck.on((a) => { if (!a.ok && a.error) setError(a.error); else setNonce((n) => n + 1); });
    return off;
  }, []);

  const grouped = useMemo(() => {
    const providers = meters.filter((m) => m.target.startsWith('chat:'));
    const clis = meters.filter((m) => !m.target.startsWith('chat:'));
    return { providers, clis };
  }, [meters]);

  const nearLimit = meters.filter((m) => m.caps.some((k) => k.tier === 'warn' || k.tier === 'crit')).length;

  if (loading && meters.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={c.textSecondary} />
      </View>
    );
  }
  if (!loading && meters.length === 0 && !error) {
    return (
      <Text style={[styles.hint, { color: c.textSecondary }]}>
        No metered sources yet — send a turn or set a cap to populate this panel.
      </Text>
    );
  }

  return (
    <View>
      <View style={styles.chipRow}>
        {nearLimit > 0 ? (
          <View style={[styles.chip, { borderColor: c.warning }]}>
            <Text style={{ color: c.warning, fontSize: 10, fontWeight: '700' }}>{nearLimit} near limit</Text>
          </View>
        ) : null}
        <View style={[styles.chip, { borderColor: c.border }]}>
          <Text style={{ color: c.textSecondary, fontSize: 10, fontWeight: '700' }}>{meters.length} sources</Text>
        </View>
        <TouchableOpacity
          style={[styles.chip, { borderColor: c.border }]}
          accessibilityRole="button"
          accessibilityLabel="Refresh usage windows"
          onPress={() => { tapLight(); refreshUsageWindows(); checkUsageLimits(); }}
        >
          <Ionicons name="refresh" size={11} color={c.accent} />
          <Text style={{ color: c.accent, fontSize: 10, fontWeight: '700', marginLeft: 4 }}>Refresh</Text>
        </TouchableOpacity>
      </View>
      {error ? <Text style={[styles.errorLine, { color: c.error }]}>Last refresh failed: {error}</Text> : null}
      {alerts.length > 0 ? (
        <Text style={{ color: c.warning, fontSize: 11 }}>{alerts.length} alert{alerts.length === 1 ? '' : 's'} active</Text>
      ) : null}

      {grouped.providers.map((m) => <MeterCard key={m.target} meter={m} />)}
      {grouped.providers.length > 0 && grouped.clis.length > 0 ? (
        <Text style={[styles.groupTitle, { color: c.textSecondary }]}>Harness CLIs</Text>
      ) : null}
      {grouped.clis.map((m) => <MeterCard key={m.target} meter={m} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', paddingVertical: 24 },
  hint: { fontSize: 12, lineHeight: 18, paddingVertical: 8 },
  errorLine: { fontSize: 11, paddingBottom: 4 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingBottom: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: theme.radius.pill,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  groupTitle: { fontSize: 11, fontWeight: '700', paddingTop: 10, paddingBottom: 4, letterSpacing: 0.4 },
  card: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    marginBottom: 8,
    gap: 8,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardLabel: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  accountLine: { fontSize: 10 },
  windowGrid: { flexDirection: 'row', gap: 6 },
  windowCell: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: theme.radius.sm, padding: 6, gap: 1 },
  capRow: { gap: 4 },
  capHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  tick: { width: 8, height: 8, borderRadius: 4 },
  bar: { height: 5, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3 },
  thresholdTick: { position: 'absolute', top: -2, width: 1, height: 9 },
  reportedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  healthRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  setCapBtn: {
    alignSelf: 'flex-start', borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill, paddingHorizontal: 12, paddingVertical: 5,
  },
  nearLimit: {
    position: 'absolute', top: 8, right: 8,
    borderWidth: 1, borderRadius: theme.radius.pill, paddingHorizontal: 6, paddingVertical: 1,
  },
  capEditor: { borderRadius: theme.radius.md, borderWidth: StyleSheet.hairlineWidth, padding: 8, gap: 8 },
  segRow: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  seg: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent',
  },
  capFields: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  capField: { flex: 1, minWidth: 88, gap: 2 },
  capFieldLabel: { fontSize: 10, fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: theme.radius.sm, paddingHorizontal: 8, paddingVertical: 6, fontSize: 13 },
  capActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  capBtn: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: theme.radius.pill,
    alignItems: 'center', minWidth: 60,
  },
});
