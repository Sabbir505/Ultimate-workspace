import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Zap, FolderOpen, Activity, ChevronDown, ChevronRight, Plus } from 'lucide-react-native';
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

  // Group sessions by project name
  const grouped = sessions.reduce<Record<string, Session[]>>((acc, s) => {
    const key = s.projectName || 'No Project';
    (acc[key] ??= []).push(s);
    return acc;
  }, {});
  const entries = Object.entries(grouped);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <View style={styles.headerLeft}>
          <Zap size={24} color={theme.colors.primary} fill={theme.colors.primary} />
          <Text style={[styles.headerTitle, { color: c.text }]}>Conduit</Text>
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

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={entries.length === 0 ? styles.emptyScroll : styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {entries.length === 0 ? (
          <View style={styles.emptyState}>
            <Activity size={48} color={c.border} />
            <Text style={[styles.emptyTitle, { color: c.textSecondary }]}>No sessions yet</Text>
            <Text style={[styles.emptySubtitle, { color: c.textSecondary }]}>
              {connected ? 'Start a CLI session on your desktop — it will appear here.' : 'Connect to your desktop to monitor sessions.'}
            </Text>
          </View>
        ) : (
          entries.map(([projectName, projectSessions]) => {
            const isCollapsed = collapsed[projectName] ?? false;
            const currentHarness = selectedHarness[projectName] || 'claude_code';
            return (
              <View key={projectName} style={[styles.projectGroup, { backgroundColor: c.surface, borderColor: c.border }]}>
                {/* Project header — tap to collapse/expand */}
                <TouchableOpacity
                  style={styles.projectHeader}
                  onPress={() => toggleCollapse(projectName)}
                  activeOpacity={0.6}
                >
                  {isCollapsed ? (
                    <ChevronRight size={18} color={c.textSecondary} />
                  ) : (
                    <ChevronDown size={18} color={c.textSecondary} />
                  )}
                  <FolderOpen size={16} color={theme.colors.primary} />
                  <Text style={[styles.projectName, { color: c.text }]}>{projectName}</Text>
                  <View style={styles.sessionCountBadge}>
                    <Text style={styles.sessionCountText}>{projectSessions.length}</Text>
                  </View>
                </TouchableOpacity>

                {/* Harness picker + create button */}
                {!isCollapsed && (
                  <View style={styles.harnessRow}>
                    {HARNESS_OPTIONS.map(opt => (
                      <TouchableOpacity
                        key={opt.value}
                        style={[
                          styles.harnessChip,
                          currentHarness === opt.value && { backgroundColor: theme.colors.primary },
                        ]}
                        onPress={() => setSelectedHarness(prev => ({ ...prev, [projectName]: opt.value }))}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.harnessChipText,
                            currentHarness === opt.value && { color: '#fff', fontWeight: '700' },
                          ]}
                        >
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      style={styles.createBtn}
                      onPress={() => handleCreate(projectName, projectSessions[0]?.projectId || projectName)}
                      activeOpacity={0.7}
                    >
                      <Plus size={14} color="#fff" />
                    </TouchableOpacity>
                  </View>
                )}

                {/* Session cards — hidden when collapsed */}
                {!isCollapsed && projectSessions.map((session) => (
                  <TouchableOpacity
                    key={session.id}
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
                ))}
              </View>
            );
          })
        )}
      </ScrollView>
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
  scrollContent: { padding: theme.spacing.md, paddingBottom: 60, gap: theme.spacing.md },
  emptyScroll: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyState: { alignItems: 'center', paddingVertical: 60, gap: 16, paddingHorizontal: 40 },
  emptyTitle: { fontSize: theme.fontSize.xl, fontWeight: '700' },
  emptySubtitle: { fontSize: theme.fontSize.md, textAlign: 'center', lineHeight: 22 },
  projectGroup: {
    borderRadius: theme.borderRadius.lg, borderWidth: 1, overflow: 'hidden',
  },
  projectHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: theme.spacing.md, paddingVertical: 14,
  },
  projectName: { fontSize: theme.fontSize.md, fontWeight: '700', flex: 1 },
  sessionCountBadge: {
    backgroundColor: 'rgba(193, 95, 60, 0.12)', borderRadius: 10,
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
    backgroundColor: 'rgba(193, 95, 60, 0.08)',
    borderWidth: 1, borderColor: 'rgba(193, 95, 60, 0.2)',
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
