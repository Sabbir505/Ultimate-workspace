/**
 * SkillsScreen — the phone mirror of the desktop Skills & Loops library:
 * list installed skills/loops (with their source harness), read and edit the
 * Markdown body, create new entries, delete, and globalize (mirror
 * single-harness entries into both harness dirs). All ops hit the same
 * installed_skills commands the desktop library uses.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import {
  useRelay, onInstalledSkillList, onInstalledSkillContent, onInstalledSkillAck,
  type InstalledSkillInfo,
} from '../hooks/useRelay';
import { useRelayList } from '../hooks/useRelayList';
import { screenCacheGet, screenCacheSet, screenCacheHas } from '../lib/screenCache';
import MarkdownText from '../components/chat/MarkdownText';
import { ActivityIndicator } from 'react-native';
import { ScreenLoading, FadeIn } from '../components/ScreenFeedback';
import { tapLight } from '../lib/haptics';
import DomainErrorBar from '../components/DomainErrorBar';

type Kind = 'skill' | 'loop';

export default function SkillsScreen() {
  useScreenMountTiming('SkillsScreen');
  const navigation = useNavigation<any>();
  const c = theme.colors;
  const {
    listInstalledSkills, readInstalledSkill, saveInstalledSkill,
    createInstalledSkill, deleteInstalledSkill, makeInstalledSkillsGlobal,
  } = useRelay();
  const [kind, setKind] = useState<Kind>('skill');
  const [skills, setSkills] = useState<InstalledSkillInfo[]>(() =>
    screenCacheGet<InstalledSkillInfo[]>('skills.installed') ?? [],
  );
  const [loaded, setLoaded] = useState(() => screenCacheHas('skills.installed'));
  const [editing, setEditing] = useState<InstalledSkillInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  // Reader-first: opening a skill renders its README as markdown; the raw
  // editor is one tap away (a TextInput inside the ScrollView read badly).
  const [editMode, setEditMode] = useState(false);
  // The InstalledSkillList reply does NOT echo which kind it is for: a
  // single-row LOOPS reply used to merge into the open SKILLS list, so the
  // toggle looked like it did nothing. Mounts and kind switches REPLACE;
  // only create-replies merge.
  const replaceNextRef = useRef(true);

  // Fetch on mount, on the kind toggle, and on every reconnect — a fetch
  // fired before the socket pairs is silently dropped, so the reconnect
  // refetch is what un-sticks the empty list.
  useRelayList(() => listInstalledSkills(kind), [kind]);

  useEffect(() => {
    const offList = onInstalledSkillList.on(({ skills: list }) => {
      // A create reply carries just the new row — merge it in (append when
      // the slug is new, replace in place when it exists) instead of letting
      // a single-row list wipe every other entry. Multi-row lists are full
      // ListInstalledSkills refreshes and replace wholesale.
      setSkills((prev) => {
        if (list.length !== 1) return list;
        return prev.some((p) => p.slug === list[0].slug)
          ? prev.map((p) => (p.slug === list[0].slug ? list[0] : p))
          : [...prev, list[0]];
      });
      // Only a full list refresh counts as loaded (and is worth caching) —
      // a single-row merge reply rides on data we already have.
      if (list.length !== 1) {
        screenCacheSet('skills.installed', list);
        setLoaded(true);
      }
    });
    const offContent = onInstalledSkillContent.on(({ content }) => {
      setDraft(content);
      setEditing((e) => (e ? { ...e, content } : e));
    });
    const offAck = onInstalledSkillAck.on(({ mirrored }) => {
      if (mirrored > 0) setMessage(`Mirrored ${mirrored} ${kind}${mirrored === 1 ? '' : 's'} to both harnesses`);
      listInstalledSkills(kind);
    });
    return () => { offList(); offContent(); offAck(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, listInstalledSkills]);

  const open = (s: InstalledSkillInfo) => {
    tapLight();
    setEditing(s);
    setDraft('');
    setEditMode(false);
    readInstalledSkill(s.slug, s.kind);
  };

  const confirmDelete = (s: InstalledSkillInfo) => {
    Alert.alert(`Delete “${s.name}”?`, 'It disappears from every harness.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteInstalledSkill(s.slug, s.kind) },
    ]);
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
        <View style={styles.kindToggle}>
          {(['skill', 'loop'] as Kind[]).map((k) => (
            <TouchableOpacity
              key={k}
              style={[styles.kindChip, kind === k && { backgroundColor: c.accent }]}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Show ${k}s`}
              onPress={() => { setKind(k); setEditing(null); setCreating(false); }}
            >
              <Text style={{ color: kind === k ? c.white : c.textSecondary, fontSize: 12, fontWeight: '700' }}>
                {k === 'skill' ? 'Skills' : 'Loops'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          onPress={() => { setCreating(true); setNewName(''); setDraft(''); }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={`New ${kind}`}
        >
          <Ionicons name="add" size={24} color={c.accent} />
        </TouchableOpacity>
      </View>

      <DomainErrorBar domains={['skills', 'chat-skills']} />

      {message ? (
        <TouchableOpacity style={[styles.messageBar, { backgroundColor: c.surface2 }]} onPress={() => setMessage(null)}>
          <Text style={{ color: c.accent, fontSize: 12 }}>{message} · tap to dismiss</Text>
        </TouchableOpacity>
      ) : null}

      {editing && !editMode && !creating ? (
        // README reader — rendered markdown, desktop parity.
        <View style={[styles.editor, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={styles.cardHead}>
            <Text style={[styles.editorTitle, { color: c.text }]}>{editing.name}</Text>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: c.accent }]}
              onPress={() => { tapLight(); setEditMode(true); }}
              accessibilityRole="button"
              accessibilityLabel="Edit skill body"
            >
              <Text style={{ color: c.white, fontWeight: '700', fontSize: 13 }}>Edit</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.readmeScroll} nestedScrollEnabled>
            {draft.trim() ? (
              <MarkdownText content={draft} />
            ) : (
              <ActivityIndicator size="small" color={c.textSecondary} style={{ padding: 16 }} />
            )}
          </ScrollView>
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.ghostBtn}
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setEditing(null)}
            >
              <Text style={{ color: c.textSecondary, fontWeight: '600', fontSize: 13 }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {(editing && editMode) || creating ? (
        <View style={[styles.editor, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[styles.editorTitle, { color: c.text }]}>
            {creating ? `New ${kind}` : editing?.name}
          </Text>
          {creating ? (
            <TextInput
              style={[styles.input, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
              placeholder="Name"
              placeholderTextColor={c.textSecondary}
              value={newName}
              onChangeText={setNewName}
              accessibilityLabel={`New ${kind} name`}
            />
          ) : null}
          <TextInput
            style={[styles.input, styles.body, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
            placeholder={'# Markdown body\nDescribe what this should do…'}
            placeholderTextColor={c.textSecondary}
            value={draft}
            onChangeText={setDraft}
            multiline
            accessibilityLabel={`${kind} body`}
          />
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: c.accent }]}
              accessibilityRole="button"
              accessibilityLabel="Save"
              onPress={() => {
                if (creating) {
                  if (newName.trim() && draft.trim()) {
                    createInstalledSkill(newName.trim(), kind, draft);
                    setCreating(false);
                    setDraft('');
                  }
                } else if (editing && draft.trim()) {
                  saveInstalledSkill(editing.slug, editing.kind, draft);
                  setEditing(null);
                }
              }}
            >
              <Text style={{ color: c.white, fontWeight: '700', fontSize: 13 }}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.ghostBtn}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={() => {
                if (creating) setCreating(false);
                else setEditMode(false);
              }}
            >
              <Text style={{ color: c.textSecondary, fontWeight: '600', fontSize: 13 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <ScrollView style={styles.list}>
        {!loaded ? (
          <ScreenLoading label={kind === 'skill' ? 'Loading skills' : 'Loading loops'} />
        ) : skills.length === 0 ? (
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            No {kind}s installed yet. Create one above — it becomes a `/{'skill' === kind ? 'slug' : 'loop'}` command in the composer.
          </Text>
        ) : (
          <FadeIn>
        {skills.map((s) => (
          <TouchableOpacity
            key={s.slug}
            style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${s.name}`}
            onPress={() => open(s)}
          >
            <View style={styles.cardHead}>
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>{s.name}</Text>
              <Text style={[styles.source, { color: c.textSecondary }]}>{s.source}</Text>
            </View>
            {s.description ? (
              <Text style={[styles.desc, { color: c.textSecondary }]} numberOfLines={2}>
                {s.description}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.rowBtn}
                accessibilityRole="button"
                accessibilityLabel={`Globalize ${s.name}`}
                onPress={() => makeInstalledSkillsGlobal(kind)}
              >
                <Ionicons name="git-compare-outline" size={14} color={c.textSecondary} />
                <Text style={{ color: c.textSecondary, fontSize: 12, fontWeight: '600' }}>Globalize all</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.rowBtn}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${s.name}`}
                onPress={() => confirmDelete(s)}
              >
                <Ionicons name="trash-outline" size={14} color={c.error} />
                <Text style={{ color: c.error, fontSize: 12, fontWeight: '600' }}>Delete</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        ))}
          </FadeIn>
        )}
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
  kindToggle: { flexDirection: 'row', gap: 6 },
  kindChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: theme.radius.pill, backgroundColor: 'transparent' },
  messageBar: { margin: 10, padding: 8, borderRadius: 8 },
  editor: { margin: 10, padding: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 10 },
  editorTitle: { fontSize: 15, fontWeight: '700' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, fontSize: 14 },
  body: { minHeight: 160, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  primaryBtn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: theme.radius.pill },
  ghostBtn: { paddingHorizontal: 14, paddingVertical: 9 },
  rowBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4 },
  readmeScroll: { maxHeight: 320 },
  list: { padding: 10, gap: 10, paddingBottom: 40 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 6 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  name: { fontSize: 15, fontWeight: '600', flex: 1 },
  source: { fontSize: 11, fontWeight: '700' },
  desc: { fontSize: 12.5, lineHeight: 18 },
  empty: { textAlign: 'center', paddingVertical: 48, paddingHorizontal: 24, fontSize: 13 },
});
