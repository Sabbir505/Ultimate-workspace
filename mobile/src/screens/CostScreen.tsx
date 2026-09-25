import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, TextInput, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import { onBudgetList, onCostRollups, useRelay, type BudgetInfo, type CostRollupsData } from '../hooks/useRelay';
import DomainErrorBar from '../components/DomainErrorBar';

/**
 * Mobile mirror of the desktop CostDashboard: range toggle (7/30/90),
 * hero total, daily bars, token stats, per-model breakdown, per-project
 * table. Same data source (get_cost_rollups_v2), same section order.
 */

const RANGES: { label: string; value: number }[] = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
];

const usd = (n: number) => `$${n.toFixed(n >= 10 ? 2 : 4)}`;
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default function CostScreen() {
  useScreenMountTiming('CostScreen');
  const navigation = useNavigation<any>();
  const { getCostRollups, connected, listBudgets, setBudget, removeBudget } = useRelay();
  const c = theme.colors;
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30);
  const [rollups, setRollups] = useState<CostRollupsData | null>(null);
  // Budgets (desktop BudgetPanel parity): per-project monthly caps edited
  // right here; the desktop reads the same store.
  const [budgets, setBudgets] = useState<BudgetInfo[]>([]);
  const [editingBudget, setEditingBudget] = useState<BudgetInfo | 'new' | null>(null);
  const [budgetUsd, setBudgetUsd] = useState('');
  const [budgetPct, setBudgetPct] = useState('100');
  useEffect(() => {
    listBudgets();
    const offB = onBudgetList.on(({ budgets: list }) => setBudgets(list));
    return () => { offB(); };
  }, [listBudgets]);
  const saveBudget = (projectId: string) => {
    const usd = parseFloat(budgetUsd);
    const pct = parseFloat(budgetPct);
    setBudget(projectId, Number.isFinite(usd) ? usd : 0, Number.isFinite(pct) ? pct : 100);
    setEditingBudget(null);
  };

  const fetchRollups = useCallback((days: number) => {
    getCostRollups(days);
  }, [getCostRollups]);

  useEffect(() => {
    fetchRollups(rangeDays);
    const off = onCostRollups.on(({ rollups: r }) => setRollups(r));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeDays, fetchRollups]);

  const daily = useMemo(() => (rollups?.daily ?? []).slice(-30), [rollups]);
  const maxDaily = useMemo(() => Math.max(...daily.map((d) => d.costUsd), 0.0001), [daily]);
  const totals = rollups?.totals;

  const editingId =
    editingBudget && editingBudget !== 'new' ? editingBudget.project_id : null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: c.text }]}>Cost dashboard</Text>
        <View style={{ width: 22 }} />
      </View>

      <DomainErrorBar domains={['budget', 'cost-rollups']} />

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

        {!connected ? (
          <Text style={[styles.note, { color: c.textSecondary }]}>Connect to your desktop to see spend.</Text>
        ) : !rollups ? (
          <Text style={[styles.note, { color: c.textSecondary }]}>Loading…</Text>
        ) : (
          <>
            {/* Hero — desktop CostHero parity. */}
            <View style={[styles.hero, { backgroundColor: c.surface2, borderColor: c.border }]}>
              <Text style={[styles.heroLabel, { color: c.textSecondary }]}>
                Estimated spend · last {rollups.rangeDays}d
              </Text>
              <Text style={[styles.heroValue, { color: c.text }]}>{usd(totals!.estimatedUsd)}</Text>
              <View style={styles.heroSubRow}>
                <Text style={[styles.heroSub, { color: c.textSecondary }]}>
                  Provider-reported {usd(totals!.providerReportedUsd)}
                </Text>
                <Text style={[styles.heroSub, { color: c.textSecondary }]}>
                  Raw tokens {usd(totals!.rawTokenCostUsd)}
                </Text>
              </View>
            </View>

            {/* Daily bars — desktop DailyChart parity. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Daily spend</Text>
            <View style={styles.dailyWrap}>
              {daily.map((d) => {
                const pct = Math.max(2, (d.costUsd / maxDaily) * 100);
                return (
                  <View key={d.day} style={styles.dailyRow}>
                    <Text style={[styles.dailyLabel, { color: c.textSecondary }]}>{d.day.slice(5)}</Text>
                    <View style={[styles.dailyTrack, { backgroundColor: c.background }]}>
                      <View style={[styles.dailyBar, { width: `${pct}%`, backgroundColor: c.accent }]} />
                    </View>
                    <Text style={[styles.dailyValue, { color: c.text }]}>{usd(d.costUsd)}</Text>
                  </View>
                );
              })}
            </View>

            {/* Token stats — desktop StatsRow parity. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Tokens</Text>
            <View style={[styles.statsGrid, { backgroundColor: c.surface2, borderColor: c.border }]}>
              {[
                ['Processed', tokens(rollups.byKind.processedTokens)],
                ['Input', tokens(rollups.byKind.uncachedInputTokens)],
                ['Cached', tokens(rollups.byKind.cachedInputTokens)],
                ['Output', tokens(rollups.byKind.outputTokens)],
                ['Reasoning', tokens(rollups.byKind.reasoningTokens)],
                ['Responses', tokens(rollups.byKind.responses)],
              ].map(([label, value]) => (
                <View key={label} style={styles.statCell}>
                  <Text style={[styles.statValue, { color: c.text }]}>{value}</Text>
                  <Text style={[styles.statLabel, { color: c.textSecondary }]}>{label}</Text>
                </View>
              ))}
            </View>

            {/* Per-model breakdown — desktop ModelBreakdownTable parity. */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>By model</Text>
            <View style={[styles.table, { backgroundColor: c.surface2, borderColor: c.border }]}>
              <View style={styles.tHead}>
                <Text style={[styles.tCellHead, { flex: 1.6, color: c.textSecondary }]}>Model</Text>
                <Text style={[styles.tCellHead, styles.tRight, { color: c.textSecondary }]}>Tokens</Text>
                <Text style={[styles.tCellHead, styles.tRight, { color: c.textSecondary }]}>Cost</Text>
                <Text style={[styles.tCellHead, styles.tRight, { color: c.textSecondary }]}>Share</Text>
              </View>
              {rollups.perModel.slice(0, 20).map((m) => (
                <View key={m.modelKey} style={[styles.tRow, { borderBottomColor: c.border }]}>
                  <Text numberOfLines={1} style={[styles.tCell, { flex: 1.6, color: c.text }]}>
                    {m.displayName || m.modelKey}
                  </Text>
                  <Text style={[styles.tCell, styles.tRight, { color: c.textSecondary }]}>{tokens(m.tokens)}</Text>
                  <Text style={[styles.tCell, styles.tRight, { color: c.text }]}>{usd(m.costUsd)}</Text>
                  <Text style={[styles.tCell, styles.tRight, { color: c.textSecondary }]}>{m.sharePct.toFixed(0)}%</Text>
                </View>
              ))}
              {rollups.perModel.length === 0 && (
                <Text style={[styles.tEmpty, { color: c.textSecondary }]}>No model usage in this range.</Text>
              )}
            </View>

            {/* Per-project — desktop BudgetPanel parity (budgets when bound). */}
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>By project</Text>
            <View style={[styles.table, { backgroundColor: c.surface2, borderColor: c.border }]}>
              {rollups.perProject.length === 0 && (
                <Text style={[styles.tEmpty, { color: c.textSecondary }]}>No project spend in this range.</Text>
              )}
              {rollups.perProject.map((pj) => (
                <View key={pj.projectId} style={[styles.tRow, { borderBottomColor: c.border }]}>
                  <Text numberOfLines={1} style={[styles.tCell, { flex: 1, color: c.text }]}>
                    {pj.projectId}
                  </Text>
                  <Text style={[styles.tCell, styles.tRight, { color: c.textSecondary }]}>
                    ↑{tokens(pj.totalInputTokens)} ↓{tokens(pj.totalOutputTokens)}
                  </Text>
                  <Text style={[styles.tCell, styles.tRight, { color: c.text }]}>{usd(pj.totalCostUsd)}</Text>
                </View>
              ))}
            </View>

            <View style={styles.budgetHead}>
              <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Budgets</Text>
              <TouchableOpacity
                style={styles.budgetAdd}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Add budget"
                onPress={() => { setEditingBudget('new'); setBudgetUsd(''); setBudgetPct('100'); }}
              >
                <Ionicons name="add-circle-outline" size={15} color={c.accent} />
                <Text style={{ color: c.accent, fontSize: 12, fontWeight: '600' }}>Add</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.table, { backgroundColor: c.surface2, borderColor: c.border }]}>
              {budgets.length === 0 && (
                <Text style={[styles.tEmpty, { color: c.textSecondary }]}>
                  No project budgets — add a monthly cap to get spend alerts.
                </Text>
              )}
              {budgets.map((b) => (
                <View key={b.project_id} style={[styles.tRow, { borderBottomColor: c.border }]}>
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit budget for ${b.project_id}`}
                    onPress={() => {
                      setEditingBudget(b);
                      setBudgetUsd(String(b.monthly_usd));
                      setBudgetPct(String(b.threshold_pct));
                    }}
                  >
                    <Text numberOfLines={1} style={[styles.tCell, { color: c.text }]}>
                      {b.project_id}
                    </Text>
                    <Text style={[styles.tMeta, { color: c.textSecondary }]}>
                      alert at {b.threshold_pct}% of cap
                    </Text>
                  </TouchableOpacity>
                  <Text style={[styles.tCell, styles.tRight, { color: c.text }]}>
                    {usd(b.monthly_usd)}/mo
                  </Text>
                  <TouchableOpacity
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove budget for ${b.project_id}`}
                    onPress={() => removeBudget(b.project_id)}
                  >
                    <Ionicons name="trash-outline" size={15} color={c.error} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>

            <Text style={[styles.note, { color: c.textSecondary }]}>
              Cache savings {usd(rollups.costQuality.cacheSavingsUsd)} · unpriced {usd(totals!.unpricedUsd)}
            </Text>
          </>
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
              {editingId ? `Budget · ${editingId}` : 'Add budget'}
            </Text>
            {editingBudget === 'new' ? (
              <ScrollView style={styles.projectPicker} keyboardShouldPersistTaps="handled">
                {(rollups?.perProject ?? []).map((pj) => (
                  <TouchableOpacity
                    key={pj.projectId}
                    style={styles.projectPickRow}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Budget for ${pj.projectId}`}
                    onPress={() => {
                      setEditingBudget({ project_id: pj.projectId, monthly_usd: 0, threshold_pct: 100 });
                      setBudgetUsd('');
                    }}
                  >
                    <Text style={{ color: c.text, fontSize: 14 }}>{pj.projectId}</Text>
                    <Text style={{ color: c.textSecondary, fontSize: 12 }}>
                      {usd(pj.totalCostUsd)} this range
                    </Text>
                  </TouchableOpacity>
                ))}
                {(rollups?.perProject ?? []).length === 0 ? (
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  body: { padding: theme.spacing.md, paddingBottom: 40 },
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
  hero: {
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    padding: theme.spacing.lg,
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  },
  heroLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  heroValue: { fontSize: 40, fontWeight: '800', marginVertical: 6 },
  heroSubRow: { flexDirection: 'row', gap: theme.spacing.lg },
  heroSub: { fontSize: 11 },
  sectionTitle: {
    fontSize: theme.fontSize.xs, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.6, marginBottom: theme.spacing.sm, marginTop: theme.spacing.lg,
  },
  dailyWrap: { gap: 6 },
  dailyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dailyLabel: { width: 40, fontSize: 10, fontFamily: 'monospace' },
  dailyTrack: { flex: 1, height: 12, borderRadius: 6, overflow: 'hidden' },
  dailyBar: { height: 12, borderRadius: 6 },
  dailyValue: { width: 60, fontSize: 10, fontFamily: 'monospace', textAlign: 'right' },
  statsGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    borderRadius: theme.radius.lg, borderWidth: 1,
  },
  statCell: { width: '33.3%', alignItems: 'center', paddingVertical: 12 },
  statValue: { fontSize: 15, fontWeight: '700', fontFamily: 'monospace' },
  statLabel: { fontSize: 10, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  table: {
    borderRadius: theme.radius.lg, borderWidth: 1,
    paddingVertical: 4, paddingHorizontal: theme.spacing.md, marginBottom: 4,
  },
  tHead: { flexDirection: 'row', paddingVertical: 8 },
  tCellHead: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  tRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  tCell: { fontSize: 12 },
  tRight: { textAlign: 'right', marginLeft: 8 },
  tMeta: { fontSize: 10, marginTop: 1 },
  budgetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  budgetAdd: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  editorScrim: { flex: 1, justifyContent: 'center', padding: 20 },
  editor: { borderRadius: 16, padding: 18, gap: 12 },
  editorTitle: { fontSize: 16, fontWeight: '700' },
  editorInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  editorBtn: { borderRadius: theme.radius.pill, paddingVertical: 10, alignItems: 'center' },
  projectPicker: { maxHeight: 220 },
  projectPickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4 },
  tEmpty: { fontSize: 12, textAlign: 'center', paddingVertical: 14 },
  note: { fontSize: 11, textAlign: 'center', marginTop: theme.spacing.md },
});
