import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, TextInput, Modal, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import {
  onBudgetList, onCostRollups, onPriceInfo, onProjectList, onHiddenCostProjects, useRelay,
  type BudgetInfo, type CostRollupsData, type ProjectInfo,
} from '../hooks/useRelay';
import { useRelayList } from '../hooks/useRelayList';
import { screenCacheGet, screenCacheSet, screenCacheHas } from '../lib/screenCache';
import { ScreenLoading, FadeIn } from '../components/ScreenFeedback';
import DailySpendChart from '../components/DailySpendChart';
import UsageLimitsPanel from '../components/UsageLimitsPanel';
import ArtifactCostPanel from '../components/ArtifactCostPanel';
// Shared formatters — the hand-copied `usd`/`tokens` helpers used to drift
// from the chat usage line's copy.
import { formatUsd as usd, formatTokens as tokens } from '../lib/format';
import ScreenHeader from '../components/ScreenHeader';

/**
 * Mobile mirror of the desktop CostDashboard. Same data source
 * (get_cost_rollups_v2) and the same section order: price bar, hero, daily
 * chart, token stats, usage & limits, model breakdown, cost quality, project
 * budgets, artifact attribution.
 */

const RANGES: { label: string; value: number }[] = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
];

// Desktop DailyChart formatters, kept local so the shared helpers used by
// other screens keep their existing behaviour.
const fmtUsd = (n: number) => {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 10) return `$${n.toFixed(0)}`;
  if (n > 0) return `$${n.toFixed(2)}`;
  return '$0';
};
const fmtTokens = (n: number) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
};

/** Desktop modelLabel parity: strip a `harness:` prefix, snake_case to
 *  spaces, title-case. API model ids pass through untouched. */
function modelLabel(key: string): string {
  const cleaned = key.replace(/^harness:/, '').replace(/_/g, ' ').trim();
  if (cleaned !== key) return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
  return key;
}

/** Desktop CostHero label map (labelFor parity). */
const PROVIDER_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  kimi_code: 'Kimi Code',
  opencode: 'OpenCode',
  opencode_go: 'OpenCode Go',
  pi: 'Pi',
  omp: 'Omp',
  commandcode: 'CommandCode',
  'chat:anthropic': 'Anthropic API',
  'chat:openai': 'OpenAI API',
  'chat:openai_chat': 'OpenAI API',
  'chat:openai_responses': 'OpenAI (Responses)',
  'chat:openrouter': 'OpenRouter',
  'chat:anthropic_compatible': 'Anthropic-compatible',
  'chat:openai_compatible': 'OpenAI-compatible',
  'chat:local_gguf': 'Local model',
};
const providerLabel = (id: string) =>
  PROVIDER_LABELS[id] ??
  id.replace(/^chat:/, '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

type ModelSort = { field: 'costUsd' | 'sharePct' | 'tokens'; dir: 'asc' | 'desc' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Desktop formats the hero range as "Mon D". */
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}`;
};

export default function CostScreen() {
  useScreenMountTiming('CostScreen');
  const c = theme.colors;
  const {
    getCostRollups, connected, listBudgets, setBudget, removeBudget,
    listProjects, listHiddenCostProjects, hideCostProject, unhideCostProject,
    getPriceInfo, refreshPrices, refreshUsageWindows, checkUsageLimits, refreshProviders, refreshCost,
  } = useRelay();
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30);
  const [rollups, setRollups] = useState<CostRollupsData | null>(() =>
    screenCacheGet<CostRollupsData>('cost.rollups') ?? null,
  );
  const [loaded, setLoaded] = useState(() => screenCacheHas('cost.rollups'));
  // Range switches fetch fresh rollups — a small inline spinner says it's
  // working (the cached chart stays on screen underneath), and the body dims
  // so the numbers visibly read as stale until the reply lands.
  const [refreshing, setRefreshing] = useState(false);
  // Rollup fetch failures (the phone's own error surface — the dismiss-only
  // DomainErrorBar can't offer a Retry).
  const [error, setError] = useState<string | null>(null);

  // ---- prices (desktop price bar parity) ----
  const [priceFetchedAt, setPriceFetchedAt] = useState<number | null>(null);
  const [pricesUpdating, setPricesUpdating] = useState(false);

  // ---- budgets / hidden projects (desktop BudgetPanel parity) ----
  const [budgets, setBudgets] = useState<BudgetInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [editingBudget, setEditingBudget] = useState<BudgetInfo | 'new' | null>(null);
  const [budgetUsd, setBudgetUsd] = useState('');
  const [budgetPct, setBudgetPct] = useState('100');

  const [modelSort, setModelSort] = useState<ModelSort>({ field: 'costUsd', dir: 'desc' });

  // Both fetches refire on reconnect — the mount sends are dropped while the
  // socket is still pairing, and a lost first fetch must not leave the
  // screen on "Loading…" (or a false empty state) forever.
  useRelayList(() => { listBudgets(); listProjects(); listHiddenCostProjects(); });
  useRelayList(() => { getCostRollups(rangeDays); }, [rangeDays]);

  useEffect(() => {
    const offB = onBudgetList.on(({ budgets: list }) => setBudgets(list));
    const offP = onProjectList.on(({ projects: list }) => setProjects(list));
    const offH = onHiddenCostProjects.on(({ projectIds }) => setHidden(projectIds));
    return () => { offB(); offP(); offH(); };
  }, []);
  useEffect(() => onCostRollups.on(({ rollups: r }) => {
    screenCacheSet('cost.rollups', r);
    setRollups(r);
    setLoaded(true);
    setRefreshing(false);
    setError(null);
  }), []);
  useEffect(() => {
    const off = onPriceInfo.on((p) => { setPriceFetchedAt(p.fetchedAt ?? null); setPricesUpdating(false); });
    return off;
  }, []);
  // The phone's rollup arm only answers GetCostRollups, so a dropped reply
  // is invisible to the request/response path. This watchdog turns that
  // silence into the desktop's "Failed to load: …" banner + Retry instead of
  // leaving the screen refreshing forever. A reply clears the timer.
  useEffect(() => {
    if (!connected) return;
    setRefreshing(true);
    const t = setTimeout(() => {
      setRefreshing(false);
      setError('The desktop did not answer the usage request.');
    }, 8000);
    return () => clearTimeout(t);
  }, [connected, rangeDays]);

  const saveBudget = (projectId: string) => {
    const cap = parseFloat(budgetUsd);
    const pct = parseFloat(budgetPct);
    setBudget(projectId, Number.isFinite(cap) ? cap : 0, Number.isFinite(pct) ? pct : 100);
    setEditingBudget(null);
  };

  const daily = useMemo(() => (rollups?.daily ?? []).slice(-(rollups?.rangeDays ?? 30)), [rollups]);
  const totals = rollups?.totals;
  const byKind = rollups?.byKind;
  const quality = rollups?.costQuality;

  const editingId = editingBudget && editingBudget !== 'new' ? editingBudget.project_id : null;

  const projectName = useMemo(() => {
    const map = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [projects]);

  /** Desktop ModelBreakdownTable parity: every row, sorted by the picked key. */
  const modelRows = useMemo(() => {
    const rows = [...(rollups?.perModel ?? [])];
    const dir = modelSort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => (a[modelSort.field] - b[modelSort.field]) * dir);
    return rows;
  }, [rollups, modelSort]);
  const sortArrow = (f: ModelSort['field']) =>
    modelSort.field !== f ? '' : modelSort.dir === 'asc' ? '↑' : '↓';
  const toggleSort = (f: ModelSort['field']) =>
    setModelSort((s) => ({ field: f, dir: s.field === f && s.dir === 'desc' ? 'asc' : 'desc' }));

  /** Provider rows with spend, desktop CostHero parity. */
  const providerRows = useMemo(() =>
    (rollups?.perProvider ?? [])
      .filter((p) => p.costUsd > 0)
      .sort((a, b) => b.costUsd - a.costUsd),
    [rollups],
  );

  /** Project rows: visible projects plus the removed ones when disclosed. */
  const projectRows = useMemo(() => {
    const all = rollups?.perProject ?? [];
    return showHidden ? all : all.filter((p) => !hidden.includes(p.projectId));
  }, [rollups, hidden, showHidden]);

  const refreshAll = () => {
    setRefreshing(true);
    setPricesUpdating(true);
    getCostRollups(rangeDays);
    refreshPrices();
    refreshUsageWindows();
    checkUsageLimits();
    refreshProviders();
    refreshCost();
  };

  // Price freshness on open, then a live re-fetch (desktop open-time effect).
  useEffect(() => {
    getPriceInfo();
    refreshPrices();
  }, [getPriceInfo, refreshPrices]);

  const pageEmpty = totals != null && totals.rawTokenCostUsd === 0 && daily.length === 0;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <ScreenHeader title="Cost dashboard" right={
        <TouchableOpacity
          style={styles.headerBtn}
          hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Refresh cost dashboard"
          onPress={refreshAll}
        >
          <Ionicons name="refresh" size={18} color={c.text} />
        </TouchableOpacity>
      } errorDomains={['budget', 'cost-rollups']} />

      <ScrollView contentContainerStyle={styles.body}>
        {/* Range toggle — desktop RangeToggle parity (7d/30d/90d). */}
        <View style={[styles.rangeRow, { backgroundColor: c.surface2, borderColor: c.border }]}>
          {RANGES.map((r) => (
            <TouchableOpacity
              key={r.value}
              style={[styles.rangeChip, rangeDays === r.value && { backgroundColor: c.accent }]}
              onPress={() => setRangeDays(r.value as 7 | 30 | 90)}
              accessibilityRole="button"
              accessibilityLabel={`Range ${r.label}`}
            >
              <Text style={{ color: rangeDays === r.value ? c.white : c.textSecondary, fontSize: 12, fontWeight: '600' }}>
                {r.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Price freshness bar — desktop cost-price-bar parity. */}
        <Text style={[styles.priceBar, { color: c.textSecondary }]}>
          {priceFetchedAt
            ? `Live prices updated ${new Date(priceFetchedAt * 1000).toLocaleString()}`
            : 'Live prices not fetched yet — using the built-in rate table'}
          {pricesUpdating ? ' · updating…' : ''}
        </Text>

        {refreshing ? (
          <View style={styles.refreshRow}>
            <ActivityIndicator size="small" color={c.accent} />
            <Text style={{ color: c.textSecondary, fontSize: 11 }}>Fetching {rangeDays}d…</Text>
          </View>
        ) : null}

        {/* Rollup failure + Retry (desktop error banner parity). */}
        {error ? (
          <View style={[styles.errorRow, { backgroundColor: c.surface2, borderColor: c.error }]}>
            <Text style={[styles.errorText, { color: c.error }]} numberOfLines={2}>
              Failed to load: {error}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Retry loading usage"
              onPress={() => { setError(null); refreshAll(); }}
            >
              <Text style={{ color: c.accent, fontSize: 12, fontWeight: '700' }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {!connected ? (
          <Text style={[styles.note, { color: c.textSecondary }]}>Connect to your desktop to see spend.</Text>
        ) : !rollups ? (
          !loaded ? (
            <ScreenLoading label="Loading spend" />
          ) : (
            <Text style={[styles.note, { color: c.textSecondary }]}>No spend data yet.</Text>
          )
        ) : pageEmpty ? (
          <View style={styles.pageEmpty}>
            <Text style={{ fontSize: 28 }}>📊</Text>
            <Text style={[styles.note, { color: c.textSecondary }]}>No usage in this range.</Text>
          </View>
        ) : (
          <FadeIn>
          {/* Stale dim: the numbers on screen belong to the previous range
              while a fetch is in flight (desktop cost-refreshing parity). */}
          <View style={refreshing ? { opacity: 0.5 } : undefined}>
            {/* Hero — desktop CostHero parity. The headline is the RAW TOKEN
                COST (the same number the desktop leads with); the estimate
                stays as a secondary line, as it does on the desktop's
                cost-quality math. */}
            <View style={[styles.hero, { backgroundColor: c.surface2, borderColor: c.border }]}>
              <Text style={[styles.heroLabel, { color: c.textSecondary }]}>Raw token cost</Text>
              <Text style={[styles.heroValue, { color: c.text }]}>{usd(totals!.rawTokenCostUsd)}</Text>
              {quality && quality.cacheSavingsUsd > 0 ? (
                <Text style={{ color: c.success, fontSize: 12, fontWeight: '600' }}>
                  Saved {usd(quality.cacheSavingsUsd)} by prompt caching
                </Text>
              ) : null}
              {byKind && byKind.processedTokens > 0 ? (
                <Text style={{ color: c.textSecondary, fontSize: 11 }}>
                  {((byKind.cachedInputTokens / byKind.processedTokens) * 100).toFixed(1)}% of input cached
                </Text>
              ) : null}
              {rollups.rangeStart && rollups.rangeEnd ? (
                <Text style={{ color: c.textSecondary, fontSize: 11, marginTop: 4 }}>
                  {dayLabel(rollups.rangeStart)} to {dayLabel(rollups.rangeEnd)}
                </Text>
              ) : null}
              <Text style={{ color: c.textSecondary, fontSize: 11 }}>
                Estimated {usd(totals!.estimatedUsd)} · provider-reported {usd(totals!.providerReportedUsd)}
              </Text>

              {/* Per-provider rows with share + token volume. */}
              {providerRows.map((p) => (
                <View key={p.provider} style={[styles.providerRow, { borderTopColor: c.border }]}>
                  <Text style={{ color: c.text, fontSize: 12, fontWeight: '600', flex: 1 }} numberOfLines={1}>
                    {providerLabel(p.provider)}
                  </Text>
                  <Text style={{ color: c.text, fontSize: 12 }}>{usd(p.costUsd)}</Text>
                  <Text style={{ color: c.textSecondary, fontSize: 10 }}>
                    {totals!.rawTokenCostUsd > 0
                      ? `${((p.costUsd / totals!.rawTokenCostUsd) * 100).toFixed(1)}%`
                      : '0%'}
                    {` · ${(p.tokens / 1e9).toFixed(2)}B tokens`}
                  </Text>
                </View>
              ))}
              {providerRows.length === 0 ? (
                <Text style={{ color: c.textSecondary, fontSize: 11, marginTop: 6 }}>No paid usage in this range.</Text>
              ) : null}
            </View>

            {/* Daily spend — desktop DailyChart parity: stacked provider
                areas, Cost/Tokens toggle, tap-to-inspect. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Daily spend</Text>
            <DailySpendChart daily={daily} />

            {/* Token stats — desktop StatsRow parity (value + sub-line). */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Tokens</Text>
            <View style={[styles.statsGrid, { backgroundColor: c.surface2, borderColor: c.border }]}>
              {[
                {
                  label: 'Processed', value: fmtTokens(byKind!.processedTokens),
                  sub: `${byKind!.responses} responses`,
                },
                {
                  label: 'Cached input', value: fmtTokens(byKind!.cachedInputTokens),
                  sub: byKind!.processedTokens > 0
                    ? `${((byKind!.cachedInputTokens / byKind!.processedTokens) * 100).toFixed(1)}% of input`
                    : '0% of input',
                },
                { label: 'Uncached input', value: fmtTokens(byKind!.uncachedInputTokens), sub: 'tokens' },
                {
                  label: 'Output', value: fmtTokens(byKind!.outputTokens),
                  sub: `${fmtTokens(byKind!.reasoningTokens)} reasoning`,
                },
                { label: 'Responses', value: String(byKind!.responses), sub: `${byKind!.sessions} sessions` },
                {
                  label: 'Cache savings', value: usd(quality?.cacheSavingsUsd ?? 0),
                  sub: 'cumulative', accent: true,
                },
              ].map((s) => (
                <View key={s.label} style={styles.statCell}>
                  <Text style={[styles.statValue, { color: s.accent ? c.accent : c.text }]}>{s.value}</Text>
                  <Text style={[styles.statLabel, { color: c.textSecondary }]}>{s.label}</Text>
                  <Text style={[styles.statSub, { color: c.textSecondary }]} numberOfLines={1}>{s.sub}</Text>
                </View>
              ))}
            </View>

            {/* Usage & limits — desktop UsageLimitsPanel parity. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Usage &amp; limits</Text>
            <UsageLimitsPanel />

            {/* Per-model breakdown — desktop ModelBreakdownTable parity:
                every row, sortable by cost / share / tokens. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Model breakdown</Text>
            <View style={[styles.table, { backgroundColor: c.surface2, borderColor: c.border, maxHeight: 260 }]}>
              <ScrollView nestedScrollEnabled style={{ flexGrow: 0 }}>
              <View style={styles.tHead}>
                <Text style={[styles.tCellHead, { flex: 1.6, color: c.textSecondary }]}>Model</Text>
                {(['costUsd', 'sharePct', 'tokens'] as const).map((f) => (
                  <TouchableOpacity
                    key={f}
                    style={styles.sortBtn}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityState={{ selected: modelSort.field === f }}
                    accessibilityLabel={`Sort by ${f === 'costUsd' ? 'cost' : f}`}
                    onPress={() => toggleSort(f)}
                  >
                    <Text style={[styles.tCellHead, { color: c.textSecondary }]}>
                      {f === 'costUsd' ? 'Cost' : f === 'sharePct' ? 'Share' : 'Tokens'}{sortArrow(f)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {modelRows.map((m) => (
                <View key={m.modelKey} style={[styles.tRow, { borderBottomColor: c.border }]}>
                  <Text numberOfLines={1} style={[styles.tCell, { flex: 1.6, color: c.text }]}>
                    {modelLabel(m.displayName || m.modelKey)}
                  </Text>
                  <Text style={[styles.tCell, styles.tRight, { color: c.text }]}>{fmtUsd(m.costUsd)}</Text>
                  <Text style={[styles.tCell, styles.tRight, { color: c.textSecondary }]}>{m.sharePct.toFixed(1)}%</Text>
                  <Text style={[styles.tCell, styles.tRight, { color: c.textSecondary }]}>{fmtTokens(m.tokens)}</Text>
                </View>
              ))}
              {modelRows.length === 0 && (
                <Text style={[styles.tEmpty, { color: c.textSecondary }]}>No model breakdown in this range.</Text>
              )}
              </ScrollView>
            </View>

            {/* Cost quality — desktop CostQualityPanel parity. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Cost quality</Text>
            <View style={[styles.table, { backgroundColor: c.surface2, borderColor: c.border }]}>
              {([
                ['Provider reported', quality?.providerReportedPct ?? 0, c.success],
                ['Model priced', quality?.modelPricedPct ?? 0, c.accent],
                ['Unpriced', quality?.unpricedPct ?? 0, c.warning],
              ] as const).map(([label, pct, color]) => (
                <View key={label} style={[styles.qualityRow, { borderBottomColor: c.border }]}>
                  <Text style={{ color: c.text, fontSize: 12, width: 128 }} numberOfLines={1}>{label}</Text>
                  <View style={[styles.track, { backgroundColor: c.border }]}>
                    <View style={[styles.trackFill, { backgroundColor: color, width: `${Math.min(100, pct)}%` }]} />
                  </View>
                  <Text style={{ color: c.textSecondary, fontSize: 11, width: 52, textAlign: 'right' }}>
                    {pct.toFixed(1)}%
                  </Text>
                </View>
              ))}
              <Text style={{ color: c.textSecondary, fontSize: 11, paddingVertical: 8 }}>
                Cache savings {usd(quality?.cacheSavingsUsd ?? 0)}
              </Text>
            </View>

            {/* Per-project — desktop BudgetPanel parity: every spending
                project, named, with the cap utilisation. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Project budgets</Text>
            <View style={[styles.table, { backgroundColor: c.surface2, borderColor: c.border }]}>
              {projectRows.length === 0 && (
                <Text style={[styles.tEmpty, { color: c.textSecondary }]}>No project spend in this range.</Text>
              )}
              {(rollups?.perProject ?? []).map((pj) => {
                if (!projectRows.includes(pj)) return null;
                const cfg = budgets.find((b) => b.project_id === pj.projectId);
                const pct = cfg && cfg.monthly_usd > 0
                  ? (pj.totalCostUsd / cfg.monthly_usd) * 100
                  : null;
                const over = pct != null && pct >= (cfg ? cfg.threshold_pct : 100);
                return (
                  <View key={pj.projectId} style={[styles.tRow, { borderBottomColor: c.border }]}>
                    <TouchableOpacity
                      style={{ flex: 1.2, marginRight: 8 }}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={cfg ? `Edit budget for ${projectName(pj.projectId)}` : `Set budget for ${projectName(pj.projectId)}`}
                      onPress={() => {
                        setEditingBudget(
                          cfg ?? { project_id: pj.projectId, monthly_usd: 0, threshold_pct: 100 },
                        );
                        setBudgetUsd(cfg ? String(cfg.monthly_usd) : '');
                        setBudgetPct(cfg ? String(cfg.threshold_pct) : '100');
                      }}
                    >
                      <Text numberOfLines={1} style={[styles.tCell, { color: c.text }]}>
                        {projectName(pj.projectId)}
                      </Text>
                      {cfg ? (
                        <Text style={[styles.tMeta, { color: over ? c.error : c.textSecondary }]}>
                          {pct != null ? `${pct.toFixed(0)}% of ${usd(cfg.monthly_usd)}` : `${usd(pj.totalCostUsd)} · cap ${usd(cfg.monthly_usd)}`}
                          {over ? ' · over' : ''}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                    <View style={{ alignItems: 'flex-end', gap: 3 }}>
                      <Text style={[styles.tCell, { color: c.text, textAlign: 'right' }]}>{usd(pj.totalCostUsd)}</Text>
                      <Text style={{ color: c.textSecondary, fontSize: 10 }}>
                        ↑{tokens(pj.totalInputTokens)} ↓{tokens(pj.totalOutputTokens)}
                      </Text>
                    </View>
                    <TouchableOpacity
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Hide ${projectName(pj.projectId)} from the cost page`}
                      onPress={() => hideCostProject(pj.projectId)}
                    >
                      <Ionicons name="eye-off-outline" size={15} color={c.textSecondary} />
                    </TouchableOpacity>
                    {cfg ? (
                      <TouchableOpacity
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove budget for ${projectName(pj.projectId)}`}
                        onPress={() => removeBudget(cfg.project_id)}
                      >
                        <Ionicons name="trash-outline" size={15} color={c.error} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              })}
              {/* Removed projects disclosure (desktop collapsible parity). */}
              {hidden.length > 0 ? (
                <View style={[styles.tRow, { borderBottomWidth: 0 }]}>
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={showHidden ? 'Hide removed projects' : `Show removed projects (${hidden.length})`}
                    onPress={() => setShowHidden((v) => !v)}
                  >
                    <Text style={{ color: c.accent, fontSize: 12, fontWeight: '600' }}>
                      {showHidden ? 'Hide removed' : `Show removed (${hidden.length})`}
                    </Text>
                  </TouchableOpacity>
                  {showHidden ? (
                    <View style={styles.removedList}>
                      {hidden.map((id) => (
                        <TouchableOpacity
                          key={id}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={`Restore ${projectName(id)}`}
                          onPress={() => unhideCostProject(id)}
                        >
                          <Text style={{ color: c.textSecondary, fontSize: 11 }} numberOfLines={1}>
                            {projectName(id)}
                          </Text>
                          <Text style={{ color: c.accent, fontSize: 11, fontWeight: '700' }}>Restore</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : null}
              <TouchableOpacity
                style={styles.budgetAdd}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Add budget"
                onPress={() => { setEditingBudget('new'); setBudgetUsd(''); setBudgetPct('100'); }}
              >
                <Ionicons name="add-circle-outline" size={15} color={c.accent} />
                <Text style={{ color: c.accent, fontSize: 12, fontWeight: '600' }}>Add budget</Text>
              </TouchableOpacity>
            </View>

            {/* Artifact attribution — desktop ArtifactCostPanel parity. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Artifact attribution</Text>
            <ArtifactCostPanel rangeDays={rollups.rangeDays ?? rangeDays} />
          </View>
          </FadeIn>
        )}
      </ScrollView>

      <Modal
        visible={editingBudget != null}
        transparent
        animationType="slide"
        onRequestClose={() => setEditingBudget(null)}
      >
        <View style={[styles.editorScrim, { backgroundColor: c.scrim }]}>
          <View style={[styles.editor, { backgroundColor: c.elevated }]}>
            <Text style={[styles.editorTitle, { color: c.text }]}>
              {editingId ? `Budget · ${projectName(editingId)}` : 'Add budget'}
            </Text>
            {editingBudget === 'new' ? (
              <ScrollView style={styles.projectPicker} keyboardShouldPersistTaps="handled">
                {(rollups?.perProject ?? [])
                  .filter((pj) => !hidden.includes(pj.projectId))
                  .map((pj) => (
                    <TouchableOpacity
                      key={pj.projectId}
                      style={styles.projectPickRow}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={`Budget for ${projectName(pj.projectId)}`}
                      onPress={() => {
                        setEditingBudget({ project_id: pj.projectId, monthly_usd: 0, threshold_pct: 100 });
                        setBudgetUsd('');
                      }}
                    >
                      <Text style={{ color: c.text, fontSize: 14 }}>{projectName(pj.projectId)}</Text>
                      <Text style={{ color: c.textSecondary, fontSize: 12 }}>
                        {usd(pj.totalCostUsd)} this range
                      </Text>
                    </TouchableOpacity>
                  ))}
                {(rollups?.perProject ?? []).filter((pj) => !hidden.includes(pj.projectId)).length === 0 ? (
                  <Text style={{ color: c.textSecondary, fontSize: 12, padding: 12 }}>
                    No project spend in this range to budget against.
                  </Text>
                ) : null}
              </ScrollView>
            ) : (
              <>
                <TextInput
                  style={[styles.editorInput, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
                  placeholder="Monthly cap in USD (0 = none)"
                  placeholderTextColor={c.textSecondary}
                  keyboardType="decimal-pad"
                  value={budgetUsd}
                  onChangeText={setBudgetUsd}
                  accessibilityLabel="Monthly budget USD"
                />
                <TextInput
                  style={[styles.editorInput, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
                  placeholder="Alert at % of cap (default 100)"
                  placeholderTextColor={c.textSecondary}
                  keyboardType="number-pad"
                  value={budgetPct}
                  onChangeText={setBudgetPct}
                  accessibilityLabel="Budget alert threshold percent"
                />
                <TouchableOpacity
                  style={[styles.editorBtn, { backgroundColor: c.accent }]}
                  accessibilityRole="button"
                  accessibilityLabel="Save budget"
                  onPress={() => saveBudget((editingBudget as BudgetInfo).project_id)}
                >
                  <Text style={{ color: c.white, fontWeight: '700' }}>Save budget</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity
              style={styles.editorBtn}
              accessibilityRole="button"
              accessibilityLabel="Close budget editor"
              onPress={() => setEditingBudget(null)}
            >
              <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: { padding: theme.spacing.md, paddingBottom: 40 },
  headerBtn: { padding: 4 },
  rangeRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    padding: 3,
    gap: 3,
    marginBottom: theme.spacing.md,
  },
  rangeChip: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: theme.radius.pill },
  priceBar: { fontSize: 10, marginBottom: theme.spacing.sm },
  errorRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: theme.radius.md,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: theme.spacing.sm,
  },
  errorText: { fontSize: 11, flex: 1 },
  hero: {
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.lg,
  },
  heroLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  heroValue: { fontSize: 40, fontWeight: '800', marginVertical: 6 },
  providerRow: {
    flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
    borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6, marginTop: 6,
  },
  sectionTitle: {
    fontSize: theme.fontSize.xs, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.6, marginBottom: theme.spacing.sm, marginTop: theme.spacing.lg,
  },
  refreshRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 8,
  },
  statsGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    borderRadius: theme.radius.lg, borderWidth: 1,
  },
  statCell: { width: '33.3%', alignItems: 'center', paddingVertical: 12 },
  statValue: { fontSize: 15, fontWeight: '700', fontFamily: 'monospace' },
  statLabel: { fontSize: 10, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  statSub: { fontSize: 9, marginTop: 1 },
  table: {
    borderRadius: theme.radius.lg, borderWidth: 1,
    paddingVertical: 4, paddingHorizontal: theme.spacing.md, marginBottom: 4,
  },
  tHead: { flexDirection: 'row', paddingVertical: 8, alignItems: 'center' },
  tCellHead: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  sortBtn: { marginLeft: 8, paddingHorizontal: 2, paddingVertical: 2 },
  tRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  tCell: { fontSize: 12 },
  tRight: { textAlign: 'right', marginLeft: 8 },
  tMeta: { fontSize: 10, marginTop: 1 },
  qualityRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth },
  track: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, borderRadius: 3 },
  budgetAdd: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    paddingVertical: 10, paddingHorizontal: 4,
  },
  removedList: { alignItems: 'flex-end', gap: 4 },
  editorScrim: { flex: 1, justifyContent: 'center', padding: 20 },
  editor: { borderRadius: 16, padding: 18, gap: 12 },
  editorTitle: { fontSize: 16, fontWeight: '700' },
  editorInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  editorBtn: { borderRadius: theme.radius.pill, paddingVertical: 10, alignItems: 'center' },
  projectPicker: { maxHeight: 220 },
  projectPickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4 },
  tEmpty: { fontSize: 12, textAlign: 'center', paddingVertical: 14 },
  note: { fontSize: 11, textAlign: 'center', marginTop: theme.spacing.md },
  pageEmpty: { alignItems: 'center', paddingVertical: 40, gap: 8 },
});