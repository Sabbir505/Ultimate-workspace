import React, { useState, useCallback, useEffect } from 'react';
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
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const Moon = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="moon" size={size} color={color} />;
const QrIcon = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="qr-code" size={size} color={color} />;
const Monitor = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="desktop" size={size} color={color} />;
import { useRelay, getRelayUrl } from '../hooks/useRelay';
import { theme, useTheme, type ThemeMode } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import { useAfterPaint } from '../lib/afterPaint';
import { tapLight } from '../lib/haptics';
import ConnectionIndicator from '../components/ConnectionIndicator';
import QrScanModal from './QrScanModal';

// Desktop SettingsView parity: the agent harness families, with install
// state — the same registry the desktop Settings → Harnesses panel lists.
function HarnessRow({ id, displayName, installed }: { id: string; displayName: string; installed: boolean }) {
  const c = theme.colors;
  return (
    <View style={styles.harnessRow}>
      <View style={[styles.harnessDot, { backgroundColor: installed ? c.success : c.border }]} />
      <Text style={[styles.harnessName, { color: c.text }]}>{displayName}</Text>
      <Text style={[styles.harnessState, { color: c.textSecondary }]}>{installed ? 'Installed' : 'Not installed'}</Text>
    </View>
  );
}

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

/** Navigation row — opens one of the screens that used to live in the
 *  drawer. Kept identical in shape to the settings rows so the card reads as
 *  one list rather than a mix of toggles and links. */
function NavRow({
  icon, label, detail, onPress,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onPress: () => void;
}) {
  const c = theme.colors;
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => { tapLight(); onPress(); }}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.rowIcon, { backgroundColor: c.bubble }]}>{icon}</View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: c.text }]}>{label}</Text>
        {detail ? (
          <Text style={[styles.rowSubtitle, { color: c.textSecondary }]} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={c.textSecondary} />
    </TouchableOpacity>
  );
}

/** Caption line under a row or control inside a card. */
function RowCaption({ children }: { children: React.ReactNode }) {
  const c = theme.colors;
  return <Text style={[styles.rowCaption, { color: c.textSecondary }]}>{children}</Text>;
}

/** Section header — desktop `settings-section-title` parity: uppercase
 *  label + one-line hint, exactly how SettingsView groups its panels. */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  const c = theme.colors;
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>{title}</Text>
      {hint ? <Text style={[styles.sectionHint, { color: c.textSecondary }]}>{hint}</Text> : null}
      <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>{children}</View>
    </View>
  );
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
// Screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  useScreenMountTiming('SettingsScreen');
  const navigation = useNavigation<any>();
    const { connected, connect, disconnect, harnesses } = useRelay();
  const { mode, setMode } = useTheme();
  const c = theme.colors;

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

  // Progressive render: the first paint carries the header plus the sections
  // that fit in the viewport; the rest arrive after that frame is on screen.
  // Settings is ~2x the node count of every other screen, and painting all of
  // it in one go was the single biggest contributor to its load time.
  const [showRest, setShowRest] = React.useState(false);
  useAfterPaint(() => setShowRest(true), [], 140);

  const handleConnect = useCallback((url?: string) => {
    connect(url ?? relayUrl.trim() ?? undefined);
  }, [connect, relayUrl]);

  const handleQrScan = useCallback((scannedUrl: string) => {
    setRelayUrl(scannedUrl);
    setQrScanning(false);
    connect(scannedUrl);
  }, [connect]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => { tapLight(); navigation.goBack(); }}
          hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
          style={styles.headerBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: c.text }]}>Settings</Text>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* ---- Desktop Connection (Remote) ---- */}
        <Section title="Desktop connection" hint="Pair this phone with the relay running on your desktop.">
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
        </Section>

        {/* ---- Manage: the destinations that used to crowd the drawer ---- */}
        <Section title="Manage" hint="Your workspace, on this phone.">
          <NavRow
            icon={<Ionicons name="flash-outline" size={18} color={c.textSecondary} />}
            label="Automations"
            onPress={() => navigation.navigate('Automations')}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <NavRow
            icon={<Ionicons name="git-branch-outline" size={18} color={c.textSecondary} />}
            label="Git"
            onPress={() => navigation.navigate('Git')}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <NavRow
            icon={<Ionicons name="bulb-outline" size={18} color={c.textSecondary} />}
            label="Memory"
            onPress={() => navigation.navigate('Memory')}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <NavRow
            icon={<Ionicons name="library-outline" size={18} color={c.textSecondary} />}
            label="Skills & loops"
            onPress={() => navigation.navigate('Skills')}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <NavRow
            icon={<Ionicons name="notifications-outline" size={18} color={c.textSecondary} />}
            label="Notifications"
            onPress={() => navigation.navigate('Notifications')}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <NavRow
            icon={<Ionicons name="cash-outline" size={18} color={c.textSecondary} />}
            label="Cost dashboard"
            onPress={() => navigation.navigate('CostDashboard')}
          />
        </Section>

        {showRest ? (
        <Section title="Appearance" hint="Theme & colors — Auto follows your phone.">
          <View style={styles.appearanceRow}>
            <Moon size={20} color={c.blue} />
            <View style={[styles.appearanceControl, { flex: 1 }]}>
              <ModeSegmented mode={mode} onChange={setMode} />
            </View>
          </View>
        </Section>
        ) : null}

        {showRest ? (
        <Section title="Agents" hint="CLI harnesses installed on your desktop.">
          {harnesses.length > 0 ? (
            harnesses.map((h) => (
              <HarnessRow key={h.id} id={h.id} displayName={h.display_name} installed={h.installed} />
            ))
          ) : (
            <Text style={[styles.emptyLine, { color: c.textSecondary }]}>
              {connected ? 'Connect to see the desktop’s agents.' : 'Connect to your desktop to see agents.'}
            </Text>
          )}
        </Section>
        ) : null}

        {/* ---- About ---- */}
        <Section title="About">
          <View style={styles.aboutRow}>
            <Text style={[styles.aboutLabel, { color: c.text }]}>Version</Text>
            <Text style={[styles.aboutValue, { color: c.textSecondary }]}>1.0.0</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <View style={styles.aboutRow}>
            <Text style={[styles.aboutLabel, { color: c.text }]}>App</Text>
            <Text style={[styles.aboutValue, { color: c.textSecondary }]}>Relay Mobile</Text>
          </View>
        </Section>
      </ScrollView>

      {/* Mount the scanner ONLY while it is open. QrScanModal calls
          useCameraPermissions() at the top of its render, so keeping it in
          the tree made every Settings mount kick off an async camera
          permission query (and pull expo-camera's module graph in) for a
          modal the user had not opened.
          (The import itself stays eager — a static import at the top of the
          file; the lazy-import rationale lives in App.tsx.) */}
      {qrScanning ? (
        <QrScanModal visible={qrScanning} onScanned={handleQrScan} onClose={() => setQrScanning(false)} />
      ) : null}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    // Back + title + spacer: the title stays optically centred.
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBack: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    flex: 1,
    fontSize: theme.fontSize['2xl'],
    fontWeight: '800',
    color: theme.colors.text,
    textAlign: 'center',
  },
  scrollView: { flex: 1 },
  scrollContent: { padding: theme.spacing.md, paddingBottom: 60 },
  section: { marginBottom: theme.spacing.lg },
  sectionTitle: {
    fontSize: theme.fontSize.sm, fontWeight: '600', color: theme.colors.textSecondary,
    marginBottom: 2, marginLeft: theme.spacing.sm,
  },
  sectionHint: {
    fontSize: theme.fontSize.xs, color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm, marginLeft: theme.spacing.sm,
  },
  card: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: theme.spacing.sm,
    overflow: 'hidden',
  },
  emptyLine: { fontSize: theme.fontSize.sm, padding: theme.spacing.sm },
  harnessRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border,
  },
  harnessDot: { width: 8, height: 8, borderRadius: 4 },
  harnessName: { flex: 1, fontSize: theme.fontSize.sm, fontWeight: '500' },
  harnessState: { fontSize: 11 },
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
  appearanceControl: { flex: 1 },
  segmented: {
    flexDirection: 'row', borderRadius: theme.radius.sm, padding: 2, gap: 2,
  },
  segment: {
    flex: 1, paddingVertical: 7, borderRadius: theme.radius.sm - 2,
    alignItems: 'center', justifyContent: 'center',
  },
  segmentText: { fontSize: theme.fontSize.sm },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: theme.spacing.sm, gap: 12 },
  rowIcon: {
    width: 28, height: 28, borderRadius: theme.radius.sm,
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
  costLabel: {
    fontSize: theme.fontSize.xs, color: theme.colors.textSecondary, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  aboutRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: theme.spacing.sm,
  },
  aboutLabel: { fontSize: theme.fontSize.md, color: theme.colors.text },
  aboutValue: { fontSize: theme.fontSize.md, color: theme.colors.textSecondary, fontWeight: '500' },
});
