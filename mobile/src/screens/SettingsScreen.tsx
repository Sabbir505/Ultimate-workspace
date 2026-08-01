import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Settings, Moon, DollarSign, Wifi, Monitor, ChevronRight, Cpu } from 'lucide-react-native';
import { useRelay, type CostDetails, type DailyCostEntry, type ProjectCostEntry, type LocalModelUsageEntry } from '../hooks/useRelay';
import { theme, useTheme } from '../theme';
import { useUseChatSession, setUseChatSession } from '../lib/featureFlags';
import ConnectionIndicator from '../components/ConnectionIndicator';

// Distinct warm palette for local-model bars — same colors the desktop
// CostDashboard uses, cycled per model.
const MODEL_COLORS = [
  '#C15F3C', '#D4A574', '#8B9A6B', '#A67B5B',
  '#6B8E9F', '#C4A77D', '#7D6B5D', '#B8A07A',
];

function usd(n: number): string {
  return `$${n.toFixed(n >= 10 ? 2 : 5)}`;
}
function tokens(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// SettingRow — a row with icon, title, subtitle, and optional switch or arrow
// ---------------------------------------------------------------------------

interface SettingRowProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  value?: boolean;
  onValueChange?: (value: boolean) => void;
  onPress?: () => void;
  showArrow?: boolean;
}

function SettingRow({ icon, title, subtitle, value, onValueChange, onPress, showArrow }: SettingRowProps) {
  const c = theme.colors;
  const inner = (
    <View style={[styles.row, { backgroundColor: c.surface }]}>
      <View style={[styles.rowIcon, { backgroundColor: c.background }]}>{icon}</View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: c.text }]}>{title}</Text>
        {subtitle ? <Text style={[styles.rowSubtitle, { color: c.textSecondary }]}>{subtitle}</Text> : null}
      </View>
      {onValueChange !== undefined && (
        <Switch
          value={value}
          onValueChange={onValueChange}
          trackColor={{ false: c.border, true: c.primaryLight }}
          thumbColor={value ? c.primary : '#f4f3f4'}
          style={styles.switchControl}
        />
      )}
      {showArrow && <ChevronRight size={18} color={c.textSecondary} />}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.6}>
        {inner}
      </TouchableOpacity>
    );
  }
  return inner;
}

// ---------------------------------------------------------------------------
// Cost-dashboard charts (mirror the desktop CostDashboard)
// ---------------------------------------------------------------------------

/** Horizontal daily-spend bars over the last 14 days. Plain View-based bars,
 *  no SVG dependency. Each bar's width is its share of the max day. */
function DailySpendChart({ data }: { data: DailyCostEntry[] }) {
  const c = theme.colors;
  const recent = data.slice(-14);
  if (recent.length === 0) {
    return (
      <View style={[styles.emptyBlock, { backgroundColor: c.background, borderColor: c.border }]}>
        <Text style={[styles.emptyText, { color: c.textSecondary }]}>No spend recorded yet.</Text>
      </View>
    );
  }
  const max = Math.max(...recent.map(d => d.cost_usd), 0.0001);
  return (
    <View style={styles.dailyChartWrap}>
      {recent.map((d) => {
        const pct = Math.max(2, (d.cost_usd / max) * 100);
        return (
          <View key={d.day} style={styles.dailyRow}>
            <Text style={[styles.dailyLabel, { color: c.textSecondary }]}>{d.day.slice(5)}</Text>
            <View style={[styles.dailyTrack, { backgroundColor: c.background }]}>
              <View style={[styles.dailyBar, { width: `${pct}%`, backgroundColor: c.primary }]} />
            </View>
            <Text style={[styles.dailyValue, { color: c.text }]}>{usd(d.cost_usd)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Per-project totals: each row shows project name, token counts, and cost. */
function ProjectTotals({ data }: { data: ProjectCostEntry[] }) {
  const c = theme.colors;
  if (data.length === 0) {
    return (
      <View style={[styles.emptyBlock, { backgroundColor: c.background, borderColor: c.border }]}>
        <Text style={[styles.emptyText, { color: c.textSecondary }]}>No cost events recorded yet.</Text>
      </View>
    );
  }
  const totalAll = data.reduce((sum, p) => sum + p.total_cost_usd, 0);
  return (
    <View>
      {data.map((row) => (
        <View key={row.project_id} style={[styles.tableRow, { borderBottomColor: c.border }]}>
          <Text style={[styles.cellName, { color: c.text }]} numberOfLines={1}>{row.project_name}</Text>
          <Text style={[styles.cellMono, { color: c.textSecondary }]}>{tokens(row.total_input_tokens)}</Text>
          <Text style={[styles.cellMono, { color: c.textSecondary }]}>{tokens(row.total_output_tokens)}</Text>
          <Text style={[styles.cellMono, { color: c.text }]}>{usd(row.total_cost_usd)}</Text>
        </View>
      ))}
      <View style={[styles.tableRow, { borderBottomWidth: 0 }]}>
        <Text style={[styles.cellName, { color: c.text, fontWeight: '700' }]}>Total</Text>
        <Text style={styles.cellMono}> </Text>
        <Text style={styles.cellMono}> </Text>
        <Text style={[styles.cellMono, { color: c.text, fontWeight: '700' }]}>{usd(totalAll)}</Text>
      </View>
    </View>
  );
}

/** Aggregate totals across all local models — total input, output, and
 *  combined token counts, plus total messages. Hidden when there's no
 *  local usage (the empty state in LocalModelList covers that). */
function LocalModelTotals({ data }: { data: LocalModelUsageEntry[] }) {
  const c = theme.colors;
  if (data.length === 0) return null;
  const inT = data.reduce((s, u) => s + u.input_tokens, 0);
  const outT = data.reduce((s, u) => s + u.output_tokens, 0);
  const total = inT + outT;
  const msgs = data.reduce((s, u) => s + u.message_count, 0);
  return (
    <View style={[styles.totalsRow, { backgroundColor: c.background, borderColor: c.border }]}>
      <View style={styles.totalsItem}>
        <Text style={[styles.totalsLabel, { color: c.textSecondary }]}>Input</Text>
        <Text style={[styles.totalsValue, { color: c.text }]}>{tokens(inT)}</Text>
      </View>
      <View style={[styles.totalsDivider, { backgroundColor: c.border }]} />
      <View style={styles.totalsItem}>
        <Text style={[styles.totalsLabel, { color: c.textSecondary }]}>Output</Text>
        <Text style={[styles.totalsValue, { color: c.text }]}>{tokens(outT)}</Text>
      </View>
      <View style={[styles.totalsDivider, { backgroundColor: c.border }]} />
      <View style={styles.totalsItem}>
        <Text style={[styles.totalsLabel, { color: c.primary }]}>Total</Text>
        <Text style={[styles.totalsValue, { color: c.primary }]}>{tokens(total)}</Text>
      </View>
      <View style={[styles.totalsDivider, { backgroundColor: c.border }]} />
      <View style={styles.totalsItem}>
        <Text style={[styles.totalsLabel, { color: c.textSecondary }]}>Messages</Text>
        <Text style={[styles.totalsValue, { color: c.text }]}>{tokens(msgs)}</Text>
      </View>
    </View>
  );
}

/** Per-local-model token usage with a horizontal bar (input + output tokens)
 *  and a stat line. Same data shape as the desktop's local model table. */
function LocalModelList({ data }: { data: LocalModelUsageEntry[] }) {
  const c = theme.colors;
  if (data.length === 0) {
    return (
      <View style={[styles.emptyBlock, { backgroundColor: c.background, borderColor: c.border }]}>
        <Text style={[styles.emptyText, { color: c.textSecondary }]}>
          No local model usage yet — chat with a local GGUF model to see stats.
        </Text>
      </View>
    );
  }
  const max = Math.max(...data.map(u => u.input_tokens + u.output_tokens), 1);
  return (
    <View>
      {data.map((u, i) => {
        const pct = Math.max(2, ((u.input_tokens + u.output_tokens) / max) * 100);
        const color = MODEL_COLORS[i % MODEL_COLORS.length];
        return (
          <View key={u.model} style={[styles.modelRow, { borderBottomColor: c.border }]}>
            <View style={styles.modelHead}>
              <View style={[styles.modelSwatch, { backgroundColor: color }]} />
              <Text style={[styles.modelName, { color: c.text }]} numberOfLines={1}>{u.model}</Text>
              <Text style={[styles.modelLast, { color: c.textSecondary }]}>{u.last_used}</Text>
            </View>
            <View style={[styles.modelTrack, { backgroundColor: c.background }]}>
              <View style={[styles.modelBar, { width: `${pct}%`, backgroundColor: color }]} />
            </View>
            <View style={styles.modelStats}>
              <Text style={[styles.modelStat, { color: c.textSecondary }]}>
                {u.message_count} msgs · {tokens(u.input_tokens)} in · {tokens(u.output_tokens)} out
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const { connected, costSummary, costDetails, connect, disconnect } = useRelay();
  const { isDark, toggle: toggleDarkMode } = useTheme();
  const chatSession = useUseChatSession();
  const c = theme.colors;

  // Relay URL override — the phone needs the desktop's LAN IP, not 127.0.0.1.
  const [relayUrl, setRelayUrl] = useState('');

  // 5-tap easter egg on the version row to reveal the developer toggle.
  const [tapCount, setTapCount] = useState(0);
  const [devVisible, setDevVisible] = useState(chatSession);

  const handleConnect = useCallback(() => {
    connect(relayUrl.trim() || undefined);
  }, [connect, relayUrl]);

  const handleVersionTap = useCallback(() => {
    setTapCount(prev => {
      const next = prev + 1;
      if (next >= 5) {
        setDevVisible(v => !v);
        return 0;
      }
      return next;
    });
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <Settings size={22} color={theme.colors.primary} />
        <Text style={[styles.headerTitle, { color: c.text }]}>Settings</Text>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* ---- Desktop Connection ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Desktop Connection</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            {/* Status row */}
            <View style={styles.connectionRow}>
              <Monitor size={20} color={c.textSecondary} />
              <View style={styles.connectionText}>
                <Text style={[styles.connectionLabel, { color: c.textSecondary }]}>Status</Text>
                <Text style={[styles.connectionValue, { color: connected ? c.success : c.error }]}>
                  {connected ? 'Connected to desktop' : 'Desktop unreachable'}
                </Text>
              </View>
              <ConnectionIndicator connected={connected} size={12} />
            </View>

            {/* URL input — shown when disconnected so user can enter desktop LAN IP */}
            {!connected && (
              <TextInput
                style={[styles.urlInput, { backgroundColor: c.background, borderColor: c.border, color: c.text }]}
                placeholder="ws://192.168.1.100:64499"
                placeholderTextColor={c.textSecondary}
                value={relayUrl}
                onChangeText={setRelayUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            )}

            {/* Connect / Disconnect */}
            <View style={styles.connectionActions}>
              {!connected ? (
                <TouchableOpacity style={[styles.connectButton, { backgroundColor: c.primary }]} onPress={handleConnect} activeOpacity={0.7}>
                  <Wifi size={16} color="#fff" />
                  <Text style={styles.connectButtonText}>Connect</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={[styles.disconnectButton, { borderColor: 'rgba(229, 57, 53, 0.2)' }]} onPress={disconnect} activeOpacity={0.7}>
                  <Text style={[styles.disconnectButtonText, { color: c.error }]}>Disconnect</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        {/* ---- Cost ---- (live from the desktop's cost ledger, refreshed
             with the 5s session poll) */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Cost</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            <View style={styles.costRow}>
              <View style={styles.costItem}>
                <DollarSign size={20} color={theme.colors.success} />
                <View>
                  <Text style={[styles.costLabel, { color: c.textSecondary }]}>Today</Text>
                  <Text style={[styles.costValue, { color: c.text }]}>${costSummary.today.toFixed(2)}</Text>
                </View>
              </View>
              <View style={[styles.costDivider, { backgroundColor: c.border }]} />
              <View style={styles.costItem}>
                <DollarSign size={20} color={theme.colors.primary} />
                <View>
                  <Text style={[styles.costLabel, { color: c.textSecondary }]}>This Week</Text>
                  <Text style={[styles.costValue, { color: c.text }]}>${costSummary.week.toFixed(2)}</Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* ---- Daily spend (last 14 days) ---- mirrors the desktop
             CostDashboard's daily bar chart. */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Daily Spend (last 14 days)</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, padding: theme.spacing.md }]}>
            <Text style={[styles.estimateNote, { color: c.textSecondary }]}>
              Best-effort estimate parsed from harness output.
            </Text>
            <DailySpendChart data={costDetails.daily} />
          </View>
        </View>

        {/* ---- Per-project totals ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Per-Project Totals</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, padding: theme.spacing.md }]}>
            <View style={[styles.tableRow, { borderBottomWidth: 0, paddingBottom: 4 }]}>
              <Text style={[styles.cellHead, styles.cellName, { color: c.textSecondary }]}>Project</Text>
              <Text style={[styles.cellHead, styles.cellMono, { color: c.textSecondary }]}>In</Text>
              <Text style={[styles.cellHead, styles.cellMono, { color: c.textSecondary }]}>Out</Text>
              <Text style={[styles.cellHead, styles.cellMono, { color: c.textSecondary }]}>Cost</Text>
            </View>
            <ProjectTotals data={costDetails.per_project} />
          </View>
        </View>

        {/* ---- Local model usage ---- per-model token totals, same shape as
             the desktop's "Local model usage" section. */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Local Model Usage</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, padding: theme.spacing.md }]}>
            <View style={styles.localHead}>
              <Cpu size={16} color={theme.colors.primary} />
              <Text style={[styles.estimateNote, { color: c.textSecondary, flex: 1 }]}>
                Token counts per local GGUF model.
              </Text>
            </View>
            <LocalModelTotals data={costDetails.local_models} />
            <LocalModelList data={costDetails.local_models} />
          </View>
        </View>

        {/* ---- Appearance ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Appearance</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            <SettingRow
              icon={<Moon size={20} color={theme.colors.blue} />}
              title="Dark Mode"
              subtitle={isDark ? 'Dark theme active' : 'Light theme active'}
              value={isDark}
              onValueChange={toggleDarkMode}
            />
          </View>
        </View>

        {/* ---- About ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>About</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            <TouchableOpacity style={styles.aboutRow} onPress={handleVersionTap} activeOpacity={0.6}>
              <Text style={[styles.aboutLabel, { color: c.text }]}>Version</Text>
              <Text style={[styles.aboutValue, { color: c.textSecondary }]}>1.0.0</Text>
            </TouchableOpacity>
            <View style={[styles.divider, { backgroundColor: c.border }]} />
            <View style={styles.aboutRow}>
              <Text style={[styles.aboutLabel, { color: c.text }]}>App</Text>
              <Text style={[styles.aboutValue, { color: c.textSecondary }]}>Conduit Mobile</Text>
            </View>
          </View>
        </View>

        {devVisible && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Developer</Text>
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <View style={styles.aboutRow}>
                <Text style={[styles.aboutLabel, { color: c.text }]}>Chat session UI</Text>
                <Text style={[styles.aboutValue, { color: chatSession ? c.success : c.textSecondary }]}>
                  {chatSession ? 'ON' : 'OFF'}
                </Text>
              </View>
              <View style={[styles.divider, { backgroundColor: c.border }]} />
              <View style={styles.connectionActions}>
                <TouchableOpacity
                  style={[styles.connectButton, { backgroundColor: c.primary }]}
                  onPress={() => setUseChatSession(!chatSession)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.connectButtonText}>
                    {chatSession ? 'Disable' : 'Enable'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.surface, borderBottomWidth: 1, borderBottomColor: theme.colors.border,
  },
  headerTitle: { fontSize: theme.fontSize['2xl'], fontWeight: '800', color: theme.colors.text },
  scrollView: { flex: 1 },
  scrollContent: { padding: theme.spacing.md, paddingBottom: 60 },
  section: { marginBottom: theme.spacing.lg },
  sectionTitle: {
    fontSize: theme.fontSize.sm, fontWeight: '700', color: theme.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: theme.spacing.sm, marginLeft: theme.spacing.sm,
  },
  card: {
    backgroundColor: theme.colors.surface, borderRadius: theme.borderRadius.lg,
    borderWidth: 1, borderColor: theme.colors.border, overflow: 'hidden',
  },
  connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: theme.spacing.md },
  connectionText: { flex: 1 },
  connectionLabel: {
    fontSize: theme.fontSize.xs, color: theme.colors.textSecondary, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  connectionValue: { fontSize: theme.fontSize.md, fontWeight: '600', marginTop: 2 },
  connected: { color: theme.colors.success },
  disconnected: { color: theme.colors.error },
  urlInput: {
    marginHorizontal: theme.spacing.md, marginBottom: theme.spacing.md,
    backgroundColor: theme.colors.background, borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing.md, paddingVertical: 10,
    fontSize: theme.fontSize.sm, color: theme.colors.text, fontFamily: 'monospace',
    borderWidth: 1, borderColor: theme.colors.border,
  },
  connectionActions: {
    flexDirection: 'row', padding: theme.spacing.md, paddingTop: 0, gap: theme.spacing.md,
  },
  connectButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.colors.primary, paddingVertical: 14, borderRadius: theme.borderRadius.md, gap: 8,
  },
  connectButtonText: { color: '#fff', fontWeight: '600', fontSize: theme.fontSize.md },
  disconnectButton: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(229, 57, 53, 0.08)', paddingVertical: 14,
    borderRadius: theme.borderRadius.md, borderWidth: 1, borderColor: 'rgba(229, 57, 53, 0.2)',
  },
  disconnectButtonText: { color: theme.colors.error, fontWeight: '600', fontSize: theme.fontSize.md },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: theme.spacing.md, gap: 12 },
  rowIcon: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: theme.colors.background,
    justifyContent: 'center', alignItems: 'center',
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: theme.fontSize.md, fontWeight: '600', color: theme.colors.text },
  rowSubtitle: { fontSize: theme.fontSize.sm, color: theme.colors.textSecondary, marginTop: 2 },
  switchControl: { marginLeft: 4 },
  divider: { height: 1, backgroundColor: theme.colors.border, marginLeft: 60 },
  costRow: { flexDirection: 'row', padding: theme.spacing.md, gap: theme.spacing.md },
  costItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  costDivider: { width: 1, backgroundColor: theme.colors.border },
  costLabel: {
    fontSize: theme.fontSize.xs, color: theme.colors.textSecondary, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  costValue: { fontSize: theme.fontSize.xl, fontWeight: '700', color: theme.colors.text, marginTop: 2 },
  aboutRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: theme.spacing.md,
  },
  aboutLabel: { fontSize: theme.fontSize.md, color: theme.colors.text },
  aboutValue: { fontSize: theme.fontSize.md, color: theme.colors.textSecondary, fontWeight: '500' },
  // ---- cost dashboard additions ----
  estimateNote: {
    fontSize: theme.fontSize.xs, lineHeight: 16,
  },
  localHead: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10,
  },
  emptyBlock: {
    paddingVertical: 24, paddingHorizontal: 12, borderRadius: theme.borderRadius.md,
    borderWidth: 1, borderStyle: 'dashed', alignItems: 'center',
  },
  emptyText: { fontSize: theme.fontSize.sm, textAlign: 'center' },
  // daily chart
  dailyChartWrap: { gap: 8, marginTop: 8 },
  dailyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dailyLabel: { width: 36, fontSize: 10, fontFamily: 'monospace' },
  dailyTrack: { flex: 1, height: 14, borderRadius: 7, overflow: 'hidden' },
  dailyBar: { height: 14, borderRadius: 7 },
  dailyValue: { width: 64, fontSize: 10, fontFamily: 'monospace', textAlign: 'right' },
  // project totals table
  tableRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1,
  },
  cellHead: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  cellName: { flex: 1, fontSize: theme.fontSize.sm, fontWeight: '600', paddingRight: 6 },
  cellMono: { width: 72, fontSize: 11, fontFamily: 'monospace', textAlign: 'right' },
  // local model list
  modelRow: { paddingVertical: 12, borderBottomWidth: 1 },
  modelHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  modelSwatch: { width: 10, height: 10, borderRadius: 3 },
  modelName: { flex: 1, fontSize: theme.fontSize.sm, fontWeight: '600' },
  modelLast: { fontSize: 10, fontFamily: 'monospace' },
  modelTrack: { height: 10, borderRadius: 5, overflow: 'hidden', marginBottom: 4 },
  modelBar: { height: 10, borderRadius: 5 },
  modelStats: { flexDirection: 'row' },
  modelStat: { fontSize: 10, fontFamily: 'monospace' },
  // local model totals row
  totalsRow: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderRadius: theme.borderRadius.md,
    paddingVertical: 12, paddingHorizontal: 8, marginBottom: 12,
  },
  totalsItem: { flex: 1, alignItems: 'center', gap: 2 },
  totalsDivider: { width: 1, alignSelf: 'stretch' },
  totalsLabel: {
    fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5,
  },
  totalsValue: { fontSize: theme.fontSize.lg, fontWeight: '700', fontFamily: 'monospace' },
});