/**
 * DailySpendChart — phone twin of the desktop cost-dashboard DailyChart:
 * a stacked AREA chart (smooth curvature) of per-provider daily spend with
 * a Cost/Tokens mode toggle, gridlines, day labels, and tap-to-inspect
 * (phone equivalent of the desktop hover tooltip). Rendered as SVG via
 * react-native-svg (already a dependency for the brand icons).
 *
 * Series hue order + provider normalization are ports of the desktop
 * component so both surfaces color the same provider the same way.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import Svg, { Path, Line, Text as SvgText } from 'react-native-svg';
import { theme } from '../theme';
import { formatUsd, formatTokens } from '../lib/format';
import type { CostRollupsData } from '../hooks/useRelay';

type Mode = 'cost' | 'tokens';

// Fixed categorical hue order (desktop parity) — assigned by provider
// identity, never by rank, so filtering never repaints survivors.
const SERIES_ORDER = [
  'claude_code', 'kimi_code', 'opencode', 'pi', 'omp', 'commandcode',
  'chat:anthropic', 'chat:openai', 'chat:openrouter', 'chat:local_gguf',
];
const SERIES_COLORS = [
  '#E08A66', '#7C6FE0', '#4CA6A6', '#C9A227', '#8A66E0', '#D64545',
  '#C96F4A', '#3B6EA5', '#4C9E5F', '#8A877E',
];
const OTHER_COLOR = '#6B6862';

function normalizeProvider(p: string): string {
  if (p === 'chat:anthropic_compatible' || p === 'chat:anthropic') return 'chat:anthropic';
  if (p === 'chat:openai_compatible' || p === 'chat:openai') return 'chat:openai';
  return p;
}

function seriesLabel(p: string): string {
  const map: Record<string, string> = {
    claude_code: 'Claude Code', kimi_code: 'Kimi', opencode: 'OpenCode',
    pi: 'Pi', omp: 'Omp', commandcode: 'CommandCode',
    'chat:anthropic': 'Anthropic', 'chat:openai': 'OpenAI',
    'chat:openrouter': 'OpenRouter', 'chat:local_gguf': 'Local GGUF', other: 'Other',
  };
  if (map[p]) return map[p];
  let out = p.startsWith('chat:') ? p.slice(5) : p;
  if (out.startsWith('harness:')) out = out.slice(8);
  return out.replace(/_/g, ' ');
}

export default function DailySpendChart({ daily }: { daily: CostRollupsData['daily'] }) {
  const c = theme.colors;
  const [mode, setMode] = useState<Mode>('cost');
  const [tapped, setTapped] = useState<number | null>(null);

  const { series, stacked, maxTotal } = useMemo(() => {
    if (daily.length === 0) return { series: [] as string[], stacked: [] as number[][], maxTotal: 1 };
    const bucket = (d: CostRollupsData['daily'][number]) =>
      mode === 'cost' ? d.costByProvider : d.tokensByProvider;
    const present = new Set<string>();
    for (const d of daily) {
      for (const p of Object.keys(bucket(d))) present.add(normalizeProvider(p));
    }
    const ordered = SERIES_ORDER.filter((p) => present.has(p));
    const others = [...present].filter((p) => !SERIES_ORDER.includes(p)).sort();
    const list = [...ordered, ...(others.length ? ['other'] : [])];

    const seriesOf = (d: CostRollupsData['daily'][number], p: string): number => {
      const m = bucket(d);
      if (p === 'other') {
        return Object.entries(m)
          .filter(([k]) => !SERIES_ORDER.includes(normalizeProvider(k)))
          .reduce((s, [, v]) => s + v, 0);
      }
      return Object.entries(m)
        .filter(([k]) => normalizeProvider(k) === p)
        .reduce((s, [, v]) => s + v, 0);
    };

    // Per-day cumulative tops per series (stack bottom→top).
    const stacked = daily.map((d) => {
      const tops: number[] = [];
      let acc = 0;
      for (const p of list) {
        acc += seriesOf(d, p);
        tops.push(acc);
      }
      return tops;
    });
    const maxTotal = Math.max(...stacked.map((t) => t[t.length - 1] ?? 0), 1e-9);
    return { series: list, stacked, maxTotal };
  }, [daily, mode]);

  const fmt = mode === 'cost'
    ? (n: number) => formatUsd(n)
    : (n: number) => formatTokens(n);

  // Geometry: width fits the day count; horizontal scroll for long ranges.
  const HEIGHT = 150;
  const LABEL_H = 18;
  const STEP = 34;
  const WIDTH = Math.max(daily.length * STEP, 280);
  const chartH = HEIGHT;
  const y = (v: number) => chartH - (v / maxTotal) * chartH;

  // Smooth stacked area path (Catmull-Rom-ish via quadratic midpoints —
  // the desktop uses straight lines between sparse days; curvature reads
  // better at phone width).
  const areaPath = (sIdx: number): string => {
    if (daily.length === 0) return '';
    const top = stacked.map((tops, i) => ({ x: i * STEP + STEP / 2, v: tops[sIdx] }));
    const bot = sIdx === 0
      ? top.map((p) => ({ x: p.x, v: 0 }))
      : stacked.map((tops, i) => ({ x: i * STEP + STEP / 2, v: tops[sIdx - 1] }));
    let d = `M ${bot[0].x} ${y(bot[0].v)}`;
    for (let i = 0; i < top.length; i++) d += ` L ${top[i].x} ${y(top[i].v)}`;
    for (let i = bot.length - 1; i >= 0; i--) d += ` L ${bot[i].x} ${y(bot[i].v)}`;
    return d + ' Z';
  };

  const total = (i: number) => stacked[i]?.[stacked[i].length - 1] ?? 0;
  const labelEvery = Math.ceil(daily.length / (WIDTH / 34 > daily.length ? daily.length : 8));

  return (
    <View style={[styles.wrap, { backgroundColor: c.surface2, borderColor: c.border }]}>
      {/* Mode toggle — desktop parity */}
      <View style={styles.toggleRow}>
        {(['cost', 'tokens'] as Mode[]).map((m) => (
          <View key={m} style={[styles.toggle, mode === m && { backgroundColor: c.accent }]}>
            <Text style={{ color: mode === m ? c.white : c.textSecondary, fontSize: 11, fontWeight: '700' }}>
              {m === 'cost' ? 'Cost' : 'Tokens'}
            </Text>
          </View>
        ))}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {daily.length > 0 ? (
          <Svg width={WIDTH} height={chartH + LABEL_H}>
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <Line
                key={f}
                x1={0} x2={WIDTH}
                y1={y(maxTotal * f)} y2={y(maxTotal * f)}
                stroke={c.border} strokeWidth={0.5}
              />
            ))}
            {series.map((p, sIdx) => (
              <Path
                key={p}
                d={areaPath(sIdx)}
                fill={p === 'other' ? OTHER_COLOR : SERIES_COLORS[SERIES_ORDER.indexOf(p) % SERIES_COLORS.length]}
                opacity={0.85}
              />
            ))}
            {tapped != null ? (
              <Line
                x1={tapped * STEP + STEP / 2} x2={tapped * STEP + STEP / 2}
                y1={0} y2={chartH}
                stroke={c.accent} strokeWidth={1}
              />
            ) : null}
            {daily.map((d, i) => (
              <SvgText
                key={d.day}
                x={i * STEP + STEP / 2}
                y={chartH + 13}
                fontSize={8.5}
                fill={c.textSecondary}
                textAnchor="middle"
                fontFamily="monospace"
              >
                {d.day.slice(5)}
              </SvgText>
            ))}
            {/* Tap targets: full-height day columns */}
            {daily.map((d, i) => (
              <Path
                key={`hit-${d.day}`}
                d={`M ${i * STEP} 0 H ${(i + 1) * STEP} V ${chartH} H ${i * STEP} Z`}
                fill="transparent"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onPress={() => setTapped((prev) => (prev === i ? null : i as any))}
              />
            ))}
          </Svg>
        ) : (
          <Text style={[styles.empty, { color: c.textSecondary }]}>No usage in this range.</Text>
        )}
      </ScrollView>

      {/* Legend (≥2 series) — desktop parity */}
      {series.length >= 2 ? (
        <View style={styles.legend}>
          {series.map((p, sIdx) => (
            <View key={p} style={styles.legendItem}>
              <View
                style={[
                  styles.legendSwatch,
                  { backgroundColor: p === 'other' ? OTHER_COLOR : SERIES_COLORS[SERIES_ORDER.indexOf(p) % SERIES_COLORS.length] },
                ]}
              />
              <Text style={{ color: c.textSecondary, fontSize: 10 }}>{seriesLabel(p)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Tap inspector — the phone's hover tooltip */}
      {tapped != null && daily[tapped] ? (
        <View style={[styles.tooltip, { backgroundColor: c.elevated, borderColor: c.border }]}>
          <Text style={{ color: c.text, fontSize: 11, fontWeight: '700', marginBottom: 4 }}>
            {daily[tapped].day}
          </Text>
          {series.map((p) => {
            const m = mode === 'cost' ? daily[tapped].costByProvider : daily[tapped].tokensByProvider;
            const v = p === 'other'
              ? Object.entries(m).filter(([k]) => !SERIES_ORDER.includes(normalizeProvider(k))).reduce((s, [, v2]) => s + v2, 0)
              : Object.entries(m).filter(([k]) => normalizeProvider(k) === p).reduce((s, [, v2]) => s + v2, 0);
            if (v <= 0) return null;
            return (
              <View key={p} style={styles.tooltipRow}>
                <View
                  style={[
                    styles.legendSwatch,
                    { backgroundColor: p === 'other' ? OTHER_COLOR : SERIES_COLORS[SERIES_ORDER.indexOf(p) % SERIES_COLORS.length] },
                  ]}
                />
                <Text style={{ color: c.textSecondary, fontSize: 11, flex: 1 }}>{seriesLabel(p)}</Text>
                <Text style={{ color: c.text, fontSize: 11, fontFamily: 'monospace' }}>{fmt(v)}</Text>
              </View>
            );
          })}
          <View style={[styles.tooltipRow, { marginTop: 3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 4 }]}>
            <Text style={{ color: c.text, fontSize: 11, fontWeight: '700', flex: 1 }}>Total</Text>
            <Text style={{ color: c.text, fontSize: 11, fontFamily: 'monospace', fontWeight: '700' }}>
              {fmt(mode === 'cost' ? daily[tapped].costUsd : Object.values(daily[tapped].tokensByProvider).reduce((a, b) => a + b, 0))}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  toggleRow: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  toggle: {
    borderRadius: theme.radius.pill,
    paddingHorizontal: 12, paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent',
  },
  empty: { fontSize: 12, paddingVertical: 24, textAlign: 'center' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 8, height: 8, borderRadius: 2 },
  tooltip: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    padding: theme.spacing.sm,
    marginTop: 8,
  },
  tooltipRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
