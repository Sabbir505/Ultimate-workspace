/**
 * BotsScreen — the phone's mirror of the desktop Bots view
 * (docs/architecture/BOTS.md).
 *
 * Two jobs, in order of importance:
 *   1. **Approvals.** A background bot run never executes a write-class tool:
 *      it queues the call for the owner. The phone is where the owner usually
 *      is, so this screen lists what is waiting, and one tap approves or
 *      denies it (the desktop replays the stored call on approve).
 *   2. **The roster.** Every bot with its dot state (working / waiting / off),
 *      job count and pet, and a tap-through to its conversation.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import {
  useRelay,
  onBotsList,
  onBotApprovalsList,
  onBotApprovalResolved,
  type BotInfo,
  type BotApprovalInfo,
} from '../hooks/useRelay';
import { useRelayList } from '../hooks/useRelayList';
import { screenCacheGet, screenCacheSet, screenCacheHas } from '../lib/screenCache';
import { timeAgo } from '../lib/format';
import { tapLight } from '../lib/haptics';
import ScreenHeader from '../components/ScreenHeader';

const CACHE_KEY = 'bots';
const APPROVALS_CACHE_KEY = 'bot-approvals';

const PET_EMOJI: Record<string, string> = {
  cat: '🐱',
  fox: '🦊',
  panda: '🐼',
  dragon: '🐲',
  axolotl: '🦎',
  robot: '🤖',
};

export default function BotsScreen() {
  const { listBots, listBotApprovals, resolveBotApproval, connected } = useRelay();
  const [bots, setBots] = useState<BotInfo[]>(() => screenCacheGet<BotInfo[]>(CACHE_KEY) ?? []);
  const [approvals, setApprovals] = useState<BotApprovalInfo[]>(
    () => screenCacheGet<BotApprovalInfo[]>(APPROVALS_CACHE_KEY) ?? [],
  );
  const [loaded, setLoaded] = useState(() => screenCacheHas(CACHE_KEY));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  useScreenMountTiming('Bots');

  const refresh = useCallback(() => {
    listBots();
    listBotApprovals();
  }, [listBotApprovals, listBots]);
  useRelayList(refresh);

  useEffect(() => {
    const offBots = onBotsList.on(({ bots: next }) => {
      setBots(next);
      setLoaded(true);
      screenCacheSet(CACHE_KEY, next);
    });
    const offApprovals = onBotApprovalsList.on(({ approvals: next }) => {
      setApprovals(next);
      screenCacheSet(APPROVALS_CACHE_KEY, next);
    });
    // Resolving from the phone (or the desktop, over the same relay) converges
    // the list — a stale "pending" row would be the worst possible lie here.
    const offResolved = onBotApprovalResolved.on(() => refresh());
    return () => {
      offBots();
      offApprovals();
      offResolved();
    };
  }, [refresh]);

  const pending = useMemo(
    () => approvals.filter((a) => a.status === 'pending'),
    [approvals],
  );
  const recent = useMemo(
    () => approvals.filter((a) => a.status !== 'pending').slice(0, 5),
    [approvals],
  );

  const resolve = useCallback(
    (id: string, approve: boolean) => {
      tapLight();
      setBusyId(id);
      resolveBotApproval(id, approve);
      // The ack event triggers the refetch; this just unblocks the buttons if
      // the desktop is slow.
      setTimeout(() => setBusyId(null), 1500);
    },
    [resolveBotApproval],
  );

  const dotColor = (bot: BotInfo): string => {
    if (bot.pending_approvals > 0) return theme.colors.warning;
    if (!bot.enabled) return theme.colors.textSecondary;
    if (bot.running) return theme.colors.accent;
    return theme.colors.textSecondary;
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScreenHeader
        title="Bots"
        errorDomains={['projects']}
        right={
          <TouchableOpacity onPress={refresh} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel="Refresh">
            <Ionicons name="refresh" size={18} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        {!connected && loaded && (
          <Text style={styles.footnote}>Offline — showing the last state this phone saw.</Text>
        )}
        {!loaded && (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        )}

        {loaded && pending.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Needs approval ({pending.length})</Text>
            {pending.map((a) => (
              <View key={a.id} style={[styles.card, styles.approvalCard]}>
                <View style={styles.approvalHead}>
                  <Ionicons name="alert-circle" size={16} color={theme.colors.warning} />
                  <Text style={styles.approvalBot}>{a.bot_name || 'A bot'}</Text>
                  <Text style={styles.meta}>{timeAgo(a.created_at)}</Text>
                </View>
                <Text style={styles.approvalSummary}>{a.summary}</Text>
                <TouchableOpacity onPress={() => setExpanded(expanded === a.id ? null : a.id)}>
                  <Text style={styles.link}>
                    {expanded === a.id ? 'Hide arguments' : `Arguments (${a.tool_name})`}
                  </Text>
                </TouchableOpacity>
                {expanded === a.id && (
                  <Text style={styles.args} numberOfLines={12}>
                    {a.args_json}
                  </Text>
                )}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.button, styles.approveButton]}
                    disabled={busyId === a.id}
                    onPress={() => resolve(a.id, true)}
                  >
                    <Text style={styles.approveText}>
                      {busyId === a.id ? 'Working…' : 'Approve'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.button, styles.denyButton]}
                    disabled={busyId === a.id}
                    onPress={() => resolve(a.id, false)}
                  >
                    <Text style={styles.denyText}>Deny</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {loaded && bots.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No bots yet</Text>
            <Text style={styles.emptyBody}>
              Create one in Relay's Bots view on your desktop — pick a pet, give it a persona, and
              it will show up here.
            </Text>
          </View>
        )}

        {bots.map((bot) => (
          <View key={bot.id} style={styles.card}>
            <View style={styles.botRow}>
              <View style={[styles.dot, { backgroundColor: dotColor(bot) }]} />
              <Text style={styles.pet}>{PET_EMOJI[bot.pet] ?? bot.emoji}</Text>
              <View style={styles.botText}>
                <Text style={styles.botName} numberOfLines={1}>
                  {bot.name}
                  {!bot.enabled ? '  ·  awaiting approval' : ''}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {bot.description || 'No description'}
                </Text>
                <Text style={styles.meta}>
                  {bot.jobs} job{bot.jobs === 1 ? '' : 's'}
                  {bot.running ? ' · working now' : ''}
                  {bot.pending_approvals > 0 ? ` · ${bot.pending_approvals} waiting` : ''}
                </Text>
              </View>
            </View>
          </View>
        ))}

        {recent.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Recently resolved</Text>
            {recent.map((a) => (
              <View key={a.id} style={styles.card}>
                <Text style={styles.meta}>
                  {a.status} · {a.bot_name} · {a.summary}
                </Text>
              </View>
            ))}
          </View>
        )}

        {pending.length === 0 && bots.length > 0 && (
          <Text style={styles.footnote}>
            Nothing waiting. Writes a standing job wants are queued here instead of running
            unattended.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  headerBtn: { padding: 8 },
  screen: { flex: 1, backgroundColor: theme.colors.background },
  body: { padding: 12, paddingBottom: 40, gap: 10 },
  center: { paddingTop: 40, alignItems: 'center' },
  section: { gap: 8 },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: 12,
    gap: 6,
  },
  approvalCard: { borderColor: theme.colors.warning },
  approvalHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  approvalBot: { color: theme.colors.text, fontWeight: '600', flex: 1 },
  approvalSummary: { color: theme.colors.text, fontSize: 14, lineHeight: 20 },
  link: { color: theme.colors.accent, fontSize: 12 },
  args: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontFamily: 'monospace',
    backgroundColor: theme.colors.background,
    borderRadius: 6,
    padding: 8,
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  button: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  approveButton: { backgroundColor: theme.colors.accent },
  approveText: { color: '#fff', fontWeight: '600' },
  denyButton: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  denyText: { color: theme.colors.text },
  botRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pet: { fontSize: 22 },
  botText: { flex: 1, gap: 1 },
  botName: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: theme.colors.textSecondary, fontSize: 12 },
  empty: { padding: 20, alignItems: 'center', gap: 6 },
  emptyTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  emptyBody: { color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  footnote: { color: theme.colors.textSecondary, fontSize: 11, paddingHorizontal: 4, paddingTop: 6 },
});
