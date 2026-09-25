/**
 * NotificationsScreen — the phone's notification center (desktop bell
 * parity). Lists the persisted journal of turn completions, failures,
 * approval requests, automation runs, and budget alerts; tapping a chat
 * notification opens that conversation. Mark-all-read + clear.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import {
  loadJournal, subscribeJournal, markAllRead, clearJournal, type JournalEntry, type NotificationKind,
} from '../lib/notificationJournal';
import { tapLight } from '../lib/haptics';

const KIND_ICON: Record<NotificationKind, keyof typeof Ionicons.glyphMap> = {
  turn_done: 'checkmark-circle-outline',
  turn_error: 'alert-circle-outline',
  approval: 'hand-left-outline',
  automation: 'flash-outline',
  budget: 'wallet-outline',
  artifact: 'document-text-outline',
};

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function NotificationsScreen() {
  useScreenMountTiming('NotificationsScreen');
  const navigation = useNavigation<any>();
  const c = theme.colors;
  const [entries, setEntries] = useState<JournalEntry[]>([]);

  useEffect(() => {
    void loadJournal().then(setEntries);
    return subscribeJournal(setEntries);
  }, []);

  const unread = entries.filter((e) => !e.read).length;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: c.text }]}>
          Notifications{unread > 0 ? ` · ${unread}` : ''}
        </Text>
        <View style={styles.headerActions}>
          {unread > 0 ? (
            <TouchableOpacity
              onPress={() => { tapLight(); void markAllRead(); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Mark all read"
            >
              <Ionicons name="checkmark-done" size={19} color={c.textSecondary} />
            </TouchableOpacity>
          ) : null}
          {entries.length > 0 ? (
            <TouchableOpacity
              onPress={() => { tapLight(); void clearJournal(); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Clear notifications"
            >
              <Ionicons name="trash-outline" size={18} color={c.error} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <ScrollView style={styles.list}>
        {entries.length === 0 ? (
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            Nothing yet. Turn completions, failures, approvals waiting, automation
            runs, and budget alerts land here — on any screen.
          </Text>
        ) : null}
        {entries.map((e) => (
          <TouchableOpacity
            key={e.id}
            style={[
              styles.row,
              { backgroundColor: e.read ? c.surface : c.surface2, borderColor: c.border },
            ]}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={`${e.title}: ${e.body}`}
            onPress={() => {
              tapLight();
              if (e.sessionId) navigation.navigate('SessionDetail', { sessionId: e.sessionId });
            }}
          >
            <Ionicons
              name={KIND_ICON[e.kind]}
              size={18}
              color={e.kind === 'turn_error' || e.kind === 'budget' ? c.error : c.accent}
            />
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>{e.title}</Text>
              {e.body ? (
                <Text style={[styles.body, { color: c.textSecondary }]} numberOfLines={2}>{e.body}</Text>
              ) : null}
            </View>
            <Text style={[styles.time, { color: c.textSecondary }]}>{ago(e.at)}</Text>
            {!e.read ? <View style={[styles.dot, { backgroundColor: c.accent }]} /> : null}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  list: { padding: 12, gap: 8, paddingBottom: 40 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12,
  },
  title: { fontSize: 14, fontWeight: '600' },
  body: { fontSize: 12, marginTop: 1 },
  time: { fontSize: 11 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  empty: { textAlign: 'center', paddingVertical: 56, paddingHorizontal: 28, fontSize: 13, lineHeight: 19 },
});
