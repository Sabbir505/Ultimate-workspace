import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Inbox, AlertTriangle, GitBranch, ChevronRight } from 'lucide-react-native';
import { useRelay, type Session } from '../hooks/useRelay';
import { theme, useTheme } from '../theme';
import ConnectionIndicator from '../components/ConnectionIndicator';

function timeAgo(timestamp: number): string {
  const s = Math.floor((Date.now() - timestamp) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Live sessions paused on something the user must do — answer a question,
 *  approve a prompt, or review a diff. Derived from the same ListSessions
 *  feed the Home tab uses, so this is always current within one poll. */
function AttentionCard({ session, onPress }: { session: Session; onPress: () => void }) {
  const waiting = session.status === 'waiting';
  const color = waiting ? theme.colors.warning : theme.colors.blue;
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardIconCol}>
        {waiting ? (
          <AlertTriangle size={18} color={color} />
        ) : (
          <GitBranch size={18} color={color} />
        )}
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>{session.title}</Text>
        <Text style={styles.cardSubtitle} numberOfLines={1}>
          {session.projectName} · {session.provider} · {timeAgo(session.lastActivity)}
        </Text>
        <View style={[styles.statusPill, { backgroundColor: waiting ? 'rgba(255, 152, 0, 0.12)' : 'rgba(33, 150, 243, 0.12)' }]}>
          <Text style={[styles.statusPillText, { color }]}>
            {waiting ? 'Waiting for input' : 'Diff ready for review'}
          </Text>
        </View>
      </View>
      <ChevronRight size={18} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  );
}

export default function ApprovalsScreen() {
  const { connected, sessions, connect, spawnSession } = useRelay();
  const navigation = useNavigation<any>();
  useTheme();
  const c = theme.colors;
  const [refreshing, setRefreshing] = React.useState(false);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    connect();
    setTimeout(() => setRefreshing(false), 1000);
  }, [connect]);

  const openSession = React.useCallback((session: Session) => {
    if (!session.isLive) spawnSession(session.id);
    // SessionDetail lives in the Home tab's stack, not this tab's. Navigate to
    // the Home tab and tell its nested stack to push SessionDetail — this works
    // from any tab (including deep-linked notification opens), whereas a bare
    // navigate('SessionDetail') only resolves inside the Home stack and throws
    // "The action 'NAVIGATE' ... was not handled by any navigator" here.
    navigation.navigate('Home', {
      screen: 'SessionDetail',
      params: { session: { ...session, isLive: true } },
    });
  }, [navigation, spawnSession]);

  // Only live sessions can be waiting/diff_ready; idle ones are inert.
  const waiting = sessions.filter(s => s.isLive && s.status === 'waiting');
  const diffs = sessions.filter(s => s.isLive && s.status === 'diff_ready');
  const totalItems = waiting.length + diffs.length;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <View style={styles.headerLeft}>
          <Inbox size={22} color={theme.colors.primary} />
          <Text style={styles.headerTitle}>Inbox</Text>
        </View>
        <View style={styles.headerRight}>
          <ConnectionIndicator connected={connected} size={10} />
          {totalItems > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{totalItems}</Text>
            </View>
          )}
        </View>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {totalItems === 0 ? (
          <View style={styles.emptyState}>
            <Inbox size={48} color={theme.colors.border} />
            <Text style={styles.emptyTitle}>All Caught Up</Text>
            <Text style={styles.emptySubtitle}>
              {connected
                ? 'No sessions waiting for input or review right now.'
                : 'Connect to your desktop to receive items.'}
            </Text>
          </View>
        ) : (
          <>
            {waiting.length > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <AlertTriangle size={16} color={theme.colors.warning} />
                  <Text style={styles.sectionTitle}>Needs Input</Text>
                  <View style={[styles.sectionBadge, { backgroundColor: 'rgba(255, 152, 0, 0.12)' }]}>
                    <Text style={[styles.sectionBadgeText, { color: theme.colors.warning }]}>{waiting.length}</Text>
                  </View>
                </View>
                {waiting.map((s) => (
                  <AttentionCard key={s.id} session={s} onPress={() => openSession(s)} />
                ))}
              </View>
            )}

            {diffs.length > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <GitBranch size={16} color={theme.colors.blue} />
                  <Text style={styles.sectionTitle}>Diffs to Review</Text>
                  <View style={[styles.sectionBadge, { backgroundColor: 'rgba(33, 150, 243, 0.12)' }]}>
                    <Text style={[styles.sectionBadgeText, { color: theme.colors.blue }]}>{diffs.length}</Text>
                  </View>
                </View>
                {diffs.map((s) => (
                  <AttentionCard key={s.id} session={s} onPress={() => openSession(s)} />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.surface, borderBottomWidth: 1, borderBottomColor: theme.colors.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { fontSize: theme.fontSize['2xl'], fontWeight: '800', color: theme.colors.text },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { backgroundColor: theme.colors.error, borderRadius: 12, minWidth: 24, height: 24, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6 },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  scrollView: { flex: 1 },
  scrollContent: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 80, gap: 16 },
  emptyTitle: { fontSize: theme.fontSize.xl, fontWeight: '700', color: theme.colors.textSecondary },
  emptySubtitle: { fontSize: theme.fontSize.md, color: theme.colors.textSecondary, textAlign: 'center', paddingHorizontal: 40 },
  section: { marginBottom: theme.spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: theme.spacing.md, paddingHorizontal: theme.spacing.sm },
  sectionTitle: { fontSize: theme.fontSize.lg, fontWeight: '700', color: theme.colors.text, flex: 1 },
  sectionBadge: { borderRadius: 10, minWidth: 24, height: 24, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8 },
  sectionBadgeText: { fontSize: 12, fontWeight: '700' },
  card: {
    backgroundColor: theme.colors.surface, borderRadius: theme.borderRadius.lg,
    borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing.md,
    marginBottom: theme.spacing.sm, flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  cardIconCol: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: theme.colors.background,
    justifyContent: 'center', alignItems: 'center',
  },
  cardBody: { flex: 1, gap: 3 },
  cardTitle: { fontSize: theme.fontSize.md, fontWeight: '700', color: theme.colors.text },
  cardSubtitle: { fontSize: theme.fontSize.sm, color: theme.colors.textSecondary },
  statusPill: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginTop: 4 },
  statusPillText: { fontSize: 11, fontWeight: '700' },
});
