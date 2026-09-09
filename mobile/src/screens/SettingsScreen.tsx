import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const Moon = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="moon" size={size} color={color} />;
const DollarSign = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="cash" size={size} color={color} />;
const Bell = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="notifications" size={size} color={color} />;
const Shield = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="shield" size={size} color={color} />;
const QrIcon = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="qr-code" size={size} color={color} />;
const Monitor = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="desktop" size={size} color={color} />;
const Cpu = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="hardware-chip" size={size} color={color} />;
import { useRelay, getRelayUrl, type CostDetails, type DailyCostEntry, type ProjectCostEntry, type LocalModelUsageEntry } from '../hooks/useRelay';
import { theme, useTheme, type ThemeMode } from '../theme';
import { useUseChatSession, setUseChatSession } from '../lib/featureFlags';
import { requestPushPermission, getPushTokenAsync, markTokenRegistered } from '../lib/notifications';
import { deviceCanAuthenticate, isAppLockEnabled, setAppLockEnabled } from '../lib/appLock';
import { tapLight } from '../lib/haptics';
import ConnectionIndicator from '../components/ConnectionIndicator';

/** Local flag mirroring the push switch across restarts. The desktop keeps
 *  the last registered token after a disable — acceptable, captioned below. */
const PUSH_FLAG_KEY = 'settings.pushEnabled';

// Categorical palette for local-model bars, derived from theme tokens so it
// adapts to dark mode (same idea as the desktop CostDashboard's per-model
// colors, cycled per model).
function modelColor(i: number): string {
  const c = theme.colors;
  const palette = [c.accent, c.blue, c.success, c.warning, c.gray, c.error];
  return palette[i % palette.length];
}

function usd(n: number): string {
  return `$${n.toFixed(n >= 10 ? 2 : 5)}`;
}
function tokens(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// QR scan modal (lazy camera — only imported when the user taps "Scan QR")
// ---------------------------------------------------------------------------

const QrScanModal = React.lazy(() => import('./QrScanModal'));

// ---------------------------------------------------------------------------
// SettingRow — a grouped-list row: icon, title, subtitle, optional switch
// ---------------------------------------------------------------------------

interface SettingRowProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  value?: boolean;
  onValueChange?: (value: boolean) => void;
  switchDisabled?: boolean;
  onPress?: () => void;
  /** Render the row at reduced opacity (unavailable states). */
  dimmed?: boolean;
}

function SettingRow({ icon, title, subtitle, value, onValueChange, switchDisabled, onPress, dimmed }: SettingRowProps) {
  const c = theme.colors;
  const inner = (
    <View style={[styles.row, dimmed && { opacity: 0.5 }]}>
      <View style={[styles.rowIcon, { backgroundColor: c.bubble }]}>{icon}</View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: c.text }]}>{title}</Text>
        {subtitle ? <Text style={[styles.rowSubtitle, { color: c.textSecondary }]}>{subtitle}</Text> : null}
      </View>
      {onValueChange !== undefined && (
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={switchDisabled}
          trackColor={{ false: c.border, true: c.accent }}
          thumbColor={c.white}
          style={styles.switchControl}
        />
      )}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        onPress={() => {
          tapLight();
          onPress();
        }}
        activeOpacity={0.6}
      >
        {inner}
      </TouchableOpacity>
    );
  }
  return inner;
}

/** Caption line under a row or control inside a card. */
function RowCaption({ children }: { children: React.ReactNode }) {
  const c = theme.colors;
  return <Text style={[styles.rowCaption, { color: c.textSecondary }]}>{children}</Text>;
}

// ---------------------------------------------------------------------------
// ModeSegmented — Auto / Light / Dark three-option segmented control
// ---------------------------------------------------------------------------

const MODE_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: 'system', label: 'Auto' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

function ModeSegmented({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  const c = theme.colors;
  return (
    <View style={[styles.segmented, { backgroundColor: c.background }]}>
      {MODE_OPTIONS.map((o) => {
        const active = mode === o.key;
        return (
          <TouchableOpacity
            key={o.key}
            style={[styles.segment, active && { backgroundColor: c.bubble }]}
            onPress={() => {
              tapLight();
              onChange(o.key);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.segmentText, { color: active ? c.text : c.textSecondary, fontWeight: active ? '600' : '500' }]}>
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
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
              <View style={[styles.dailyBar, { width: `${pct}%`, backgroundColor: c.accent }]} />
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
        <Text style={[styles.totalsLabel, { color: c.accent }]}>Total</Text>
        <Text style={[styles.totalsValue, { color: c.accent }]}>{tokens(total)}</Text>
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
        const color = modelColor(i);
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
  const { connected, costSummary, costDetails, connect, disconnect, refreshCostDetails, registerPushToken } = useRelay();
  const { mode, setMode } = useTheme();
  const chatSession = useUseChatSession();
  const c = theme.colors;

  // GetCostDetails is no longer part of the 5s relay poll (it's three SQL
  // aggregations under the desktop DB mutex). Refresh it when this screen
  // opens and whenever the connection (re)establishes.
  useEffect(() => {
    if (connected) refreshCostDetails();
  }, [connected, refreshCostDetails]);

  // Relay URL override. The desktop relay binds loopback only, so a physical
  // phone reaches it via `adb reverse tcp:<port> tcp:<port>` and
  // ws://localhost:<port> — or an explicit tunnel/LAN URL if the user runs
  // their own bridge. Entered URLs are persisted by useRelay on connect;
  // prefill the field with the current one. The token rides in the fragment
  // (`ws://host:port/#token`) and every frame is E2E-encrypted from the
  // pairing proof onward.
  const [relayUrl, setRelayUrl] = useState(() => getRelayUrl() ?? '');

  // QR scanner modal — shown when the user taps "Scan QR" on the Desktop
  // Connection card. The scanned payload is a `ws://host:port/#token` or
  // `wss://host/#token` URL emitted by the desktop's Remote settings panel.
  const [qrScanning, setQrScanning] = useState(false);

  // 5-tap easter egg on the version row to reveal the developer toggle.
  const [tapCount, setTapCount] = useState(0);
  const [devVisible, setDevVisible] = useState(chatSession);

  // ---- Push notifications ----
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);

  // ---- App lock ----
  const [canAuth, setCanAuth] = useState<boolean | null>(null);
  const [appLockOn, setAppLockOn] = useState(false);

  // Restore persisted switch states once.
  useEffect(() => {
    AsyncStorage.getItem(PUSH_FLAG_KEY).then((v) => setPushOn(v === 'true')).catch(() => {});
    deviceCanAuthenticate().then(setCanAuth).catch(() => setCanAuth(false));
    isAppLockEnabled().then(setAppLockOn).catch(() => {});
  }, []);

  const handleConnect = useCallback((url?: string) => {
    connect(url ?? relayUrl.trim() ?? undefined);
  }, [connect, relayUrl]);

  const handleQrScan = useCallback((scannedUrl: string) => {
    setRelayUrl(scannedUrl);
    setQrScanning(false);
    connect(scannedUrl);
  }, [connect]);

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

  // Push enable: permission → Expo token → register with the desktop. When
  // the token is unavailable (Expo Go / denied) the switch stays off and the
  // caption says so honestly. Disable only clears the local flag — the token
  // stays registered on the desktop (harmless; captioned).
  const handlePushToggle = useCallback((next: boolean) => {
    tapLight();
    setPushOn(next);
    if (!next) {
      void AsyncStorage.setItem(PUSH_FLAG_KEY, 'false').catch(() => {});
      setPushNote('Off on this phone — the token saved on your desktop is kept');
      return;
    }
    if (!connected) {
      setPushOn(false);
      setPushNote('Connect to the desktop first so it can store your token');
      return;
    }
    setPushBusy(true);
    setPushNote('Requesting permission…');
    void (async () => {
      try {
        const permitted = await requestPushPermission();
        if (!permitted) {
          setPushOn(false);
          setPushNote('Notifications are blocked — enable them for Relay in system settings');
          return;
        }
        const token = await getPushTokenAsync();
        if (!token) {
          setPushOn(false);
          setPushNote('Needs a development build — Expo Go can’t receive push');
          return;
        }
        registerPushToken(token, Platform.OS);
        void markTokenRegistered(token);
        void AsyncStorage.setItem(PUSH_FLAG_KEY, 'true').catch(() => {});
        setPushNote('Approvals and completions reach you when the app is closed');
      } finally {
        setPushBusy(false);
      }
    })();
  }, [connected, registerPushToken]);

  const handleAppLockToggle = useCallback((next: boolean) => {
    tapLight();
    setAppLockOn(next);
    void setAppLockEnabled(next);
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
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
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
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
                placeholder="ws://host:port/#token or wss://machine.tailnet.ts.net/#token"
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
                <>
                  <TouchableOpacity
                    style={[styles.secondaryButton, { borderColor: c.border }]}
                    onPress={() => {
                      tapLight();
                      setQrScanning(true);
                    }}
                    activeOpacity={0.7}
                  >
                    <QrIcon size={16} color={c.text} />
                    <Text style={[styles.secondaryButtonText, { color: c.text }]}>Scan QR</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.primaryButton, { backgroundColor: c.accent, flex: 1 }]}
                    onPress={() => handleConnect()}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.primaryButtonText, { color: c.white }]}>Connect</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={[styles.secondaryButton, { borderColor: c.error, flex: 1 }]}
                  onPress={() => {
                    tapLight();
                    disconnect();
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.secondaryButtonText, { color: c.error }]}>Disconnect</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        {/* ---- Appearance ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Appearance</Text>
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <View style={styles.appearanceRow}>
              <Moon size={20} color={c.blue} />
              <View style={[styles.appearanceControl, { flex: 1 }]}>
                <ModeSegmented mode={mode} onChange={setMode} />
                <RowCaption>Auto follows your phone</RowCaption>
              </View>
            </View>
          </View>
        </View>

        {/* ---- Notifications ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Notifications</Text>
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <SettingRow
              icon={<Bell size={20} color={c.accent} />}
              title="Push alerts"
              subtitle={pushNote ?? undefined}
              value={pushOn}
              onValueChange={handlePushToggle}
              switchDisabled={pushBusy}
            />
            {!pushNote ? (
              <RowCaption>
                <Text>
                  {pushOn
                    ? 'Approvals and completions reach you when the app is closed'
                    : 'Off — turn on to hear about approvals while away'}
                </Text>
              </RowCaption>
            ) : null}
          </View>
        </View>

        {/* ---- Security ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Security</Text>
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <SettingRow
              icon={<Shield size={20} color={c.success} />}
              title="App lock"
              subtitle={canAuth === false ? 'No biometrics enrolled' : undefined}
              value={canAuth === false ? false : appLockOn}
              onValueChange={handleAppLockToggle}
              switchDisabled={canAuth !== true}
              dimmed={canAuth === false}
            />
            <RowCaption>Require Face ID / fingerprint after 30s away</RowCaption>
          </View>
        </View>

        {/* ---- Cost ---- (live from the desktop's cost ledger, refreshed
             with the 5s session poll) */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Cost</Text>
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <View style={styles.costRow}>
              <View style={styles.costItem}>
                <DollarSign size={20} color={c.success} />
                <View>
                  <Text style={[styles.costLabel, { color: c.textSecondary }]}>Today</Text>
                  <Text style={[styles.costValue, { color: c.text }]}>${costSummary.today.toFixed(2)}</Text>
                </View>
              </View>
              <View style={[styles.costDivider, { backgroundColor: c.border }]} />
              <View style={styles.costItem}>
                <DollarSign size={20} color={c.accent} />
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
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border, padding: theme.spacing.md }]}>
            <Text style={[styles.estimateNote, { color: c.textSecondary }]}>
              Best-effort estimate parsed from harness output.
            </Text>
            <DailySpendChart data={costDetails.daily} />
          </View>
        </View>

        {/* ---- Per-project totals ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Per-Project Totals</Text>
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border, padding: theme.spacing.md }]}>
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
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border, padding: theme.spacing.md }]}>
            <View style={styles.localHead}>
              <Cpu size={16} color={c.accent} />
              <Text style={[styles.estimateNote, { color: c.textSecondary, flex: 1 }]}>
                Token counts per local GGUF model.
              </Text>
            </View>
            <LocalModelTotals data={costDetails.local_models} />
            <LocalModelList data={costDetails.local_models} />
          </View>
        </View>

        {/* ---- About ---- */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>About</Text>
          <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <TouchableOpacity
              style={styles.aboutRow}
              onPress={() => {
                tapLight();
                handleVersionTap();
              }}
              activeOpacity={0.6}
            >
              <Text style={[styles.aboutLabel, { color: c.text }]}>Version</Text>
              <Text style={[styles.aboutValue, { color: c.textSecondary }]}>1.0.0</Text>
            </TouchableOpacity>
            <View style={[styles.divider, { backgroundColor: c.border }]} />
            <View style={styles.aboutRow}>
              <Text style={[styles.aboutLabel, { color: c.text }]}>App</Text>
              <Text style={[styles.aboutValue, { color: c.textSecondary }]}>Relay Mobile</Text>
            </View>
          </View>
        </View>

        {devVisible && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Developer</Text>
            <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
              <View style={styles.aboutRow}>
                <Text style={[styles.aboutLabel, { color: c.text }]}>Chat session UI</Text>
                <Text style={[styles.aboutValue, { color: chatSession ? c.success : c.textSecondary }]}>
                  {chatSession ? 'ON' : 'OFF'}
                </Text>
              </View>
              <View style={[styles.divider, { backgroundColor: c.border }]} />
              <View style={styles.connectionActions}>
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: c.accent }]}
                  onPress={() => {
                    tapLight();
                    setUseChatSession(!chatSession);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.primaryButtonText, { color: c.white }]}>
                    {chatSession ? 'Disable' : 'Enable'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {/* QR scanner modal — lazy-loaded so expo-camera isn't on the cold-start
          path. The modal shows a live camera preview and calls onScanned when
          a barcode/QR is detected. */}
      <React.Suspense fallback={null}>
        <QrScanModal visible={qrScanning} onScanned={handleQrScan} onClose={() => setQrScanning(false)} />
      </React.Suspense>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: theme.fontSize['2xl'], fontWeight: '800', color: theme.colors.text },
  scrollView: { flex: 1 },
  scrollContent: { padding: theme.spacing.md, paddingBottom: 60 },
  section: { marginBottom: theme.spacing.lg },
  sectionTitle: {
    fontSize: theme.fontSize.sm, fontWeight: '600', color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm, marginLeft: theme.spacing.sm,
  },
  card: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: theme.spacing.sm,
    overflow: 'hidden',
  },
  connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: theme.spacing.sm },
  connectionText: { flex: 1 },
  connectionLabel: {
    fontSize: theme.fontSize.xs, color: theme.colors.textSecondary, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  connectionValue: { fontSize: theme.fontSize.md, fontWeight: '600', marginTop: 2 },
  urlInput: {
    marginHorizontal: theme.spacing.sm, marginBottom: theme.spacing.sm,
    backgroundColor: theme.colors.background, borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md, paddingVertical: 10,
    fontSize: theme.fontSize.sm, color: theme.colors.text, fontFamily: 'monospace',
    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border,
  },
  connectionActions: {
    flexDirection: 'row', padding: theme.spacing.sm, paddingTop: theme.spacing.xs, gap: theme.spacing.sm,
  },
  primaryButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, borderRadius: theme.radius.md, gap: 8,
  },
  secondaryButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, paddingHorizontal: theme.spacing.md, borderRadius: theme.radius.md,
    borderWidth: 1, gap: 8,
  },
  primaryButtonText: { fontWeight: '600', fontSize: theme.fontSize.md },
  secondaryButtonText: { fontWeight: '600', fontSize: theme.fontSize.md },
  appearanceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: theme.spacing.sm },
  appearanceControl: { gap: theme.spacing.sm },
  segmented: {
    flexDirection: 'row', borderRadius: theme.radius.sm, padding: 2, gap: 2,
  },
  segment: {
    flex: 1, paddingVertical: 7, borderRadius: theme.radius.sm - 2,
    alignItems: 'center', justifyContent: 'center',
  },
  segmentText: { fontSize: theme.fontSize.sm },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: theme.spacing.sm, gap: 12 },
  rowIcon: {
    width: 32, height: 32, borderRadius: theme.radius.sm,
    justifyContent: 'center', alignItems: 'center',
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: theme.fontSize.md, fontWeight: '600', color: theme.colors.text },
  rowSubtitle: { ...theme.type.secondary, marginTop: 2 },
  rowCaption: {
    ...theme.type.secondary, fontSize: theme.fontSize.xs, lineHeight: 15,
    paddingHorizontal: theme.spacing.sm, paddingBottom: theme.spacing.sm, paddingLeft: 52,
  },
  switchControl: { marginLeft: 4 },
  divider: { height: 1, backgroundColor: theme.colors.border, marginLeft: 52 },
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
    paddingVertical: 12, paddingHorizontal: theme.spacing.sm,
  },
  aboutLabel: { fontSize: theme.fontSize.md, color: theme.colors.text },
  aboutValue: { fontSize: theme.fontSize.md, color: theme.colors.textSecondary, fontWeight: '500' },
  // ---- cost dashboard ----
  estimateNote: {
    fontSize: theme.fontSize.xs, lineHeight: 16, marginBottom: 4,
  },
  localHead: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10,
  },
  emptyBlock: {
    paddingVertical: 24, paddingHorizontal: 12, borderRadius: theme.radius.md,
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
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cellHead: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  cellName: { flex: 1, fontSize: theme.fontSize.sm, fontWeight: '600', paddingRight: 6 },
  cellMono: { width: 72, fontSize: 11, fontFamily: 'monospace', textAlign: 'right' },
  // local model list
  modelRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
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
    borderWidth: 1, borderRadius: theme.radius.md,
    paddingVertical: 12, paddingHorizontal: 8, marginBottom: 12,
  },
  totalsItem: { flex: 1, alignItems: 'center', gap: 2 },
  totalsDivider: { width: 1, alignSelf: 'stretch' },
  totalsLabel: {
    fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5,
  },
  totalsValue: { fontSize: theme.fontSize.lg, fontWeight: '700', fontFamily: 'monospace' },
});
