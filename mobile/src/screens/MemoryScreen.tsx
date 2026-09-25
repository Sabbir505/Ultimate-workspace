/**
 * MemoryScreen — the phone mirror of the desktop Settings → Memory panel:
 * browse what the assistant remembers, edit entries (a user edit is ground
 * truth — the desktop pins origin to user_created and confidence to 1.0),
 * forget single entries, and purge the whole store. Reads and writes go
 * through the same desktop memory commands the panel uses.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import {
  useRelay, onMemoryList, onMemoryMutated, type MemoryInfo,
} from '../hooks/useRelay';
import { tapLight } from '../lib/haptics';
import DomainErrorBar from '../components/DomainErrorBar';

const STATUS_DIM: Record<string, string> = {
  active: '',
  superseded: 'superseded',
  retired: 'retired',
  flagged: 'flagged',
};

export default function MemoryScreen() {
  useScreenMountTiming('MemoryScreen');
  const navigation = useNavigation<any>();
  const c = theme.colors;
  const { listMemoryRecords, updateMemoryRecord, deleteMemoryRecord, purgeMemories } = useRelay();
  const [records, setRecords] = useState<MemoryInfo[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<MemoryInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  useEffect(() => {
    listMemoryRecords(includeInactive);
    const offList = onMemoryList.on(({ records: list }) => setRecords(list));
    const offMut = onMemoryMutated.on(() => listMemoryRecords(includeInactive));
    return () => { offList(); offMut(); };
  }, [includeInactive, listMemoryRecords]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = includeInactive ? records : records.filter((r) => r.status === 'active');
    const sorted = [...rows].sort((a, b) => (b.importance - a.importance) || (b.updated_at - a.updated_at));
    if (!q) return sorted;
    return sorted.filter(
      (r) => r.content.toLowerCase().includes(q) || r.keywords.some((k) => k.toLowerCase().includes(q)),
    );
  }, [records, query, includeInactive]);

  const confirmForget = (m: MemoryInfo) => {
    Alert.alert('Forget this memory?', 'The assistant stops using it in future chats.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => deleteMemoryRecord(m.id) },
    ]);
  };

  const confirmPurge = () => {
    Alert.alert(
      'Purge all memories?',
      'Every memory is deleted and the assistant starts fresh. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Purge everything', style: 'destructive', onPress: () => purgeMemories() },
      ],
    );
  };

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
        <Text style={[styles.headerTitle, { color: c.text }]}>Memory</Text>
        <TouchableOpacity
          onPress={confirmPurge}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Purge all memories"
        >
          <Ionicons name="trash-outline" size={19} color={c.error} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
      <DomainErrorBar domains={['memory']} />
        <View style={[styles.searchField, { backgroundColor: c.surface2, borderColor: c.border }]}>
          <Ionicons name="search" size={15} color={c.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: c.text }]}
            value={query}
            onChangeText={setQuery}
            placeholder="Search memories"
            placeholderTextColor={c.textSecondary}
            autoCorrect={false}
          />
        </View>
        <TouchableOpacity
          style={styles.toggle}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Toggle inactive memories"
          onPress={() => setIncludeInactive((v) => !v)}
        >
          <Text style={{ color: includeInactive ? c.accent : c.textSecondary, fontSize: 12 }}>
            {includeInactive ? 'Showing all' : 'Active only'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {filtered.length === 0 ? (
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            No memories match. The assistant learns facts from your chats — edit or forget
            anything here.
          </Text>
        ) : null}
        {filtered.map((m) => (
          <View
            key={m.id}
            style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}
          >
            <View style={styles.cardHead}>
              <Text style={[styles.kind, { color: c.accent }]}>
                {m.kind}
                {STATUS_DIM[m.status] ? ` · ${STATUS_DIM[m.status]}` : ''}
              </Text>
              <Text style={[styles.meta, { color: c.textSecondary }]}>
                importance {m.importance}/9 · {(m.confidence * 100).toFixed(0)}%
              </Text>
            </View>
            {editing?.id === m.id ? (
              <>
                <TextInput
                  style={[styles.editInput, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
                  value={draft}
                  onChangeText={setDraft}
                  multiline
                  accessibilityLabel="Edit memory"
                />
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: c.accent }]}
                    accessibilityRole="button"
                    accessibilityLabel="Save memory"
                    onPress={() => {
                      if (draft.trim()) updateMemoryRecord(m.id, draft.trim());
                      setEditing(null);
                    }}
                  >
                    <Text style={{ color: c.white, fontWeight: '700', fontSize: 12 }}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.actionBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel edit"
                    onPress={() => setEditing(null)}
                  >
                    <Text style={{ color: c.textSecondary, fontWeight: '600', fontSize: 12 }}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <Text style={[styles.content, { color: c.text }]}>{m.content}</Text>
                {m.keywords.length > 0 ? (
                  <Text style={[styles.keywords, { color: c.textSecondary }]} numberOfLines={1}>
                    {m.keywords.join(' · ')}
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.actionBtn}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Edit memory"
                    onPress={() => { tapLight(); setEditing(m); setDraft(m.content); }}
                  >
                    <Ionicons name="create-outline" size={14} color={c.textSecondary} />
                    <Text style={{ color: c.textSecondary, fontSize: 12, fontWeight: '600' }}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.actionBtn}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Forget memory"
                    onPress={() => confirmForget(m)}
                  >
                    <Ionicons name="close-circle-outline" size={14} color={c.error} />
                    <Text style={{ color: c.error, fontSize: 12, fontWeight: '600' }}>Forget</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
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
  searchWrap: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm },
  searchField: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: theme.radius.pill, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },
  toggle: { alignSelf: 'flex-end', paddingVertical: 6, paddingHorizontal: 4 },
  list: { padding: theme.spacing.md, gap: 10, paddingBottom: 40 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 8 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kind: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  meta: { fontSize: 11 },
  content: { fontSize: 14, lineHeight: 20 },
  keywords: { fontSize: 11 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: theme.radius.pill,
    backgroundColor: 'transparent',
  },
  editInput: {
    minHeight: 80, maxHeight: 220, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10, padding: 10, fontSize: 14, textAlignVertical: 'top',
  },
  empty: { textAlign: 'center', paddingVertical: 48, paddingHorizontal: 24, fontSize: 13 },
});
