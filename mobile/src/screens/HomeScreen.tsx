import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const Zap = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="flash" size={size} color={color} />;
const FolderOpen = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="folder-open" size={size} color={color} />;
const Activity = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="pulse" size={size} color={color} />;
const ChevronDown = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="chevron-down" size={size} color={color} />;
const ChevronRight = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="chevron-forward" size={size} color={color} />;
const Plus = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="add" size={size} color={color} />;
import { useRelay, onSessionCreated, type Session } from '../hooks/useRelay';
import { theme, useTheme } from '../theme';
import ConnectionIndicator from '../components/ConnectionIndicator';

function timeAgo(timestamp: number): string {
  const s = Math.floor((Date.now() - timestamp) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function statusColor(status: Session['status']): string {
  return status === 'working' ? theme.colors.green
    : status === 'waiting' ? theme.colors.yellow
    : status === 'diff_ready' ? theme.colors.blue
    : theme.colors.gray;
}

function statusLabel(status: Session['status']): string {
  return status === 'working' ? 'Working'
    : status === 'waiting' ? 'Waiting'
    : status === 'diff_ready' ? 'Diff ready'
    : 'Idle';
}

const HARNESS_OPTIONS: { label: string; value: string }[] = [
  { label: 'Claude', value: 'claude_code' },
  { label: 'Kimi', value: 'kimi_code' },
  { label: 'OpenCode', value: 'opencode' },
];

export default function HomeScreen() {
  const { connected, sessions, connect, createSession, spawnSession } = useRelay();
  const navigation = useNavigation<any>();
  useTheme();
  const c = theme.colors;
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedHarness, setSelectedHarness] = useState<Record<string, string>>({});

  useEffect(() => { connect(); }, [connect]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    connect();
    setTimeout(() => setRefreshing(false), 1000);
  }, [connect]);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleCreate = useCallback((projectName: string, projectId: string) => {
    const harness = selectedHarness[projectName] || 'claude_code';
    createSession(projectId, harness);
    // Listen for the SessionCreated event and navigate to it.
    const unsub = onSessionCreated.on((s) => {
      if (s.projectId === projectId && s.provider === harness) {
        unsub();
        // The desktop auto-opens + spawns the session when it's created, but
        // nudge a spawn too in case that event was missed — then open the
        // screen in live mode so it polls for terminal output right away
        // instead of showing "session is not running".
        spawnSession(s.id);
        navigation.navigate('SessionDetail', { session: { ...s, isLive: true } });
      }
    });
  }, [createSession, spawnSession, selectedHarness, navigation]);

  const handleTapSession = useCallback((session: Session) => {
    if (session.isLive) {
      navigation.navigate('SessionDetail', { session });
    } else {
      // Inactive session — spawn it on desktop first, then navigate in live
      // mode: the desktop spawns the pty moments later, and the SessionScreen
      // polls until the transcript arrives.
      spawnSession(session.id);
      navigation.navigate('SessionDetail', { session: { ...session, isLive: true } });
    }
  }, [navigation, spawnSession]);

  // Group sessions by project name (memoized — the FlatList row model below
  // depends on it and must not rebuild on every render).
  const entries = useMemo(() => {
    const grouped = sessions.reduce<Record<string, Session[]>>((acc, s) => {
      const key = s.projectName || 'No Project';
      (acc[key] ??= []).push(s);
      return acc;
    }, {});
    return Object.entries(grouped);
  }, [sessions]);

  // M2 (PERFORMANCE_AUDIT.md): FlatList over a FLATTENED row model instead of
  // ScrollView + nested .map() — the old tree mounted every session card of
  // every project on render; the flat list lets RN window off-screen rows.
  type Row =
    | { type: 'project'; key: string; projectName: string; count: number; isCollapsed: boolean; last: boolean }
    | { type: 'harness'; key: string; projectName: string; projectId: string; harness: string; last: boolean }
    | { type: 'session'; key: string; session: Session; last: boolean };
  const listData = useMemo(() => {
    const rows: Row[] = [];
    for (const [projectName, projectSessions] of entries) {
      const isCollapsed = collapsed[projectName] ?? false;
      rows.push({ type: 'project', key: `p:${projectName}`, projectName, count: projectSessions.length, isCollapsed, last: false });
      if (!isCollapsed) {
        rows.push({
          type: 'harness', key: `h:${projectName}`, projectName,
          projectId: projectSessions[0]?.projectId || projectName,
          harness: selectedHarness[projectName] || 'claude_code', last: false,
        });
        for (const session of projectSessions) {
          rows.push({ type: 'session', key: `s:${session.id}`, session, last: false });
        }
      }
    }
    // Mark each group's last row so it can round + close the card border.
    for (let i = 0; i < rows.length; i++) {
      rows[i].last = i === rows.length - 1 || rows[i + 1].type === 'project';
    }
    return rows;
  }, [entries, collapsed, selectedHarness]);

  const renderRow = useCallback(({ item }: { item: Row }) => {
    const groupStyle = [
      styles.groupRow,
      { backgroundColor: c.surface, borderColor: c.border },
      item.type === 'project' && styles.groupRowFirst,
      item.last && styles.groupRowLast,
    ];
    if (item.type === 'project') {
      return (
        <View style={groupStyle}>
          <TouchableOpacity
            style={styles.projectHeader}
            onPress={() => toggleCollapse(item.projectName)}
            activeOpacity={0.6}
          >
            {item.isCollapsed ? (
              <ChevronRight size={18} color={c.textSecondary} />
            ) : (
              <ChevronDown size={18} color={c.textSecondary} />
            )}
            <FolderOpen size={16} color={theme.colors.primary} />
            <Text style={[styles.projectName, { color: c.text }]}>{item.projectName}</Text>
            <View style={styles.sessionCountBadge}>
              <Text style={styles.sessionCountText}>{item.count}</Text>
            </View>
          </TouchableOpacity>
        </View>
      );
    }
    if (item.type === 'harness') {
      return (
        <View style={groupStyle}>
          <View style={styles.harnessRow}>
            {HARNESS_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.harnessChip,
                  item.harness === opt.value && { backgroundColor: theme.colors.primary },
                ]}
                onPress={() => setSelectedHarness(prev => ({ ...prev, [item.projectName]: opt.value }))}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.harnessChipText,
                    item.harness === opt.value && { color: '#fff', fontWeight: '700' },
                  ]}
                >
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.createBtn}
              onPress={() => handleCreate(item.projectName, item.projectId)}
              activeOpacity={0.7}
            >
              <Plus size={14} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    const session = item.session;
    return (
      <View style={groupStyle}>
        <TouchableOpacity
          style={[styles.sessionCard, { backgroundColor: c.background, borderColor: c.border }]}
          activeOpacity={0.7}
          onPress={() => handleTapSession(session)}
        >
          <View style={styles.sessionHeader}>
            <View style={styles.statusRow}>
              <View style={[
                styles.statusDot,
                { backgroundColor: session.isLive ? theme.colors.green : theme.colors.gray },
              ]} />
              <Text style={{ fontSize: theme.fontSize.xs, fontWeight: '600', color: c.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {session.isLive ? statusLabel(session.status) : 'Idle'}
              </Text>
            </View>
            <Text style={{ fontSize: theme.fontSize.xs, color: c.textSecondary }}>
              {timeAgo(session.lastActivity)}
            </Text>
          </View>
          <Text style={[styles.sessionTitle, { color: c.text }]} numberOfLines={2}>
            {session.title}
          </Text>
          <Text style={{ fontSize: theme.fontSize.sm, color: c.textSecondary, fontWeight: '500' }}>
            {session.provider} {session.model ? `/ ${session.model}` : ''}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }, [c, toggleCollapse, handleCreate, handleTapSession]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <View style={styles.headerLeft}>
          <Zap size={24} color={theme.colors.primary} />
          <Text style={[styles.headerTitle, { color: c.text }]}>Relay</Text>
        </View>
        <View style={styles.headerRight}>
          <ConnectionIndicator connected={connected} size={10} />
          <Text style={{ fontSize: theme.fontSize.sm, color: c.textSecondary, fontWeight: '500' }}>
            {connected ? 'Connected' : 'Offline'}
          </Text>
          {sessions.length > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{sessions.length}</Text>
            </View>
          )}
        </View>
      </View>

      <FlatList
        style={styles.scrollView}
        data={listData}
        renderItem={renderRow}
        keyExtractor={(row) => row.key}
        initialNumToRender={10}
        windowSize={5}
        contentContainerStyle={listData.length === 0 ? styles.emptyScroll : styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Activity size={48} color={c.border} />
            <Text style={[styles.emptyTitle, { color: c.textSecondary }]}>No sessions yet</Text>
            <Text style={[styles.emptySubtitle, { color: c.textSecondary }]}>
              {connected ? 'Start a CLI session on your desktop — it will appear here.' : 'Connect to your desktop to monitor sessions.'}
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { fontSize: theme.fontSize['2xl'], fontWeight: '800' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: {
    backgroundColor: theme.colors.primary, borderRadius: 10, minWidth: 20, height: 20,
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: theme.spacing.md, paddingBottom: 60 },
  emptyScroll: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyState: { alignItems: 'center', paddingVertical: 60, gap: 16, paddingHorizontal: 40 },
  emptyTitle: { fontSize: theme.fontSize.xl, fontWeight: '700' },
  emptySubtitle: { fontSize: theme.fontSize.md, textAlign: 'center', lineHeight: 22 },
  // M2: flattened group rows re-create the old `projectGroup` card look —
  // first row rounds/caps the top, last row rounds/closes the bottom, and
  // consecutive rows share the side borders (gap between groups comes from
  // the first row's marginTop).
  groupRow: { borderLeftWidth: 1, borderRightWidth: 1 },
  groupRowFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: theme.borderRadius.lg,
    borderTopRightRadius: theme.borderRadius.lg,
    marginTop: theme.spacing.md,
  },
  groupRowLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: theme.borderRadius.lg,
    borderBottomRightRadius: theme.borderRadius.lg,
  },
  projectHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: theme.spacing.md, paddingVertical: 14,
  },
  projectName: { fontSize: theme.fontSize.md, fontWeight: '700', flex: 1 },
  sessionCountBadge: {
    backgroundColor: 'rgba(0, 120, 168, 0.12)', borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  sessionCountText: { fontSize: theme.fontSize.xs, fontWeight: '700', color: theme.colors.primary },
  harnessRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm,
  },
  harnessChip: {
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: 'rgba(0, 120, 168, 0.08)',
    borderWidth: 1, borderColor: 'rgba(0, 120, 168, 0.2)',
  },
  harnessChipText: { fontSize: theme.fontSize.sm, color: theme.colors.primary, fontWeight: '500' },
  createBtn: {
    backgroundColor: theme.colors.primary,
    width: 28, height: 28, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
    marginLeft: 4,
  },
  sessionCard: {
    borderRadius: theme.borderRadius.md, padding: theme.spacing.md,
    marginHorizontal: theme.spacing.sm, marginBottom: theme.spacing.sm,
    borderWidth: 1,
  },
  sessionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  sessionTitle: { fontSize: theme.fontSize.md, fontWeight: '600', lineHeight: 21, marginBottom: 4 },
});
