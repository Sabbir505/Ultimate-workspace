/**
 * VaultScreen — phone mirror of the desktop's Vault (a desktop-bound
 * markdown notes folder, Obsidian-style). Browse the folder tree, read
 * notes as markdown, edit/create/delete notes — every mutation goes over
 * the E2E relay to the desktop, which owns the files.
 *
 * Unbound state: the vault folder is chosen on the desktop (Settings →
 * Vault → bind) — the phone can't pick desktop folders, so it shows a
 * pointer card instead of a broken picker.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Modal, ActivityIndicator,
  BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import { useNavigation } from '@react-navigation/native';
import {
  useRelay, onVaultState, onVaultTree, onVaultNote, onVaultAck, onVaultFileContent,
  type VaultNode, type VaultStateData,
} from '../hooks/useRelay';
import { useRelayList } from '../hooks/useRelayList';
import { tapLight } from '../lib/haptics';
import { screenCacheGet, screenCacheSet, screenCacheHas } from '../lib/screenCache';
import { ScreenLoading, FadeIn } from '../components/ScreenFeedback';
import ScreenHeader from '../components/ScreenHeader';
import PdfView from '../components/PdfView';
import MarkdownText from '../components/chat/MarkdownText';
import DomainErrorBar from '../components/DomainErrorBar';

export default function VaultScreen() {
  useScreenMountTiming('VaultScreen');
  const c = theme.colors;
  const navigation = useNavigation<any>();
  const {
    connected, getVaultState, getVaultTree, readVaultNote,
    createVaultNote, writeVaultNote, deleteVaultNote, readVaultFile,
  } = useRelay();
  const [state, setState] = useState<VaultStateData | null>(() =>
    screenCacheGet<VaultStateData>('vault.state') ?? null,
  );
  const [nodes, setNodes] = useState<VaultNode[]>(() =>
    screenCacheGet<VaultNode[]>('vault.tree') ?? [],
  );
  const [loaded, setLoaded] = useState(() => screenCacheHas('vault.tree'));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Reader/editor state. `current` is the open note; `draft` is the edit text.
  const [current, setCurrent] = useState<{ path: string; content: string } | null>(null);
  const [loadingNote, setLoadingNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  // Open PDF (binary vault files): requested per path, answered by
  // VaultFileContent; rendered with pdf.js in a WebView.
  const [pdf, setPdf] = useState<{ path: string; mime: string; dataBase64: string } | null>(null);
  const [pdfLoading, setPdfLoading] = useState<string | null>(null);
  useEffect(() => {
    const off = onVaultFileContent.on(({ path, mime, dataBase64 }) => {
      if (path !== pdfLoading) return;
      setPdf({ path, mime, dataBase64 });
      setPdfLoading(null);
      setLoadingNote(null);
    });
    return off;
  }, [pdfLoading]);
  const openPdf = useCallback((path: string) => {
    setPdfLoading(path);
    setLoadingNote(path); // row-level feedback while the payload streams
    readVaultFile(path);
  }, [readVaultFile]);
  const [newName, setNewName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => { getVaultState(); getVaultTree(); }, [getVaultState, getVaultTree]);
  useRelayList(refresh);

  // In-app back: an open note goes back to the tree first; the screen only
  // pops when the tree is showing (parity with the app-level back button).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (current) { setCurrent(null); setEditing(false); return true; }
      return false;
    });
    return () => sub.remove();
  }, [current]);

  useEffect(() => {
    const offState = onVaultState.on((s) => {
      screenCacheSet('vault.state', s);
      setState(s);
      setLoaded(true);
    });
    const offTree = onVaultTree.on(({ nodes: tree }) => {
      screenCacheSet('vault.tree', tree);
      setNodes(tree);
      setLoaded(true);
    });
    const offNote = onVaultNote.on(({ path, content }) => {
      if (path !== current?.path) return;
      setCurrent({ path, content });
      setLoadingNote(null);
    });
    const offAck = onVaultAck.on(({ op, ok, message }) => {
      if (op === 'read' && !ok) setLoadingNote(null);
      if (!ok) {
        setNotice(message ?? `${op} failed`);
        return;
      }
      if (op === 'create' || op === 'write' || op === 'delete') {
        setNotice(ok ? `Note ${op}d` : null);
        // Re-index lands server-side; refresh the tree to reflect it.
        getVaultTree();
      }
    });
    return () => { offState(); offTree(); offNote(); offAck(); };
  }, [current?.path, getVaultTree]);

  const openNote = useCallback((path: string) => {
    tapLight();
    setLoadingNote(path);
    setCurrent({ path, content: '' });
    setEditing(false);
    readVaultNote(path);
  }, [readVaultNote]);

  const toggleFolder = useCallback((path: string) => {
    tapLight();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const saveDraft = useCallback(() => {
    if (!current) return;
    writeVaultNote(current.path, draft);
    setCurrent({ ...current, content: draft });
    setEditing(false);
  }, [current, draft, writeVaultNote]);

  const confirmDelete = useCallback(() => {
    if (!current) return;
    deleteVaultNote(current.path);
    setCurrent(null);
  }, [current, deleteVaultNote]);

  const createNote = useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    const path = name.endsWith('.md') ? name : `${name}.md`;
    createVaultNote(path, `# ${name.replace(/\.md$/, '')}\n\n`);
    setCreating(false);
    setNewName('');
    openNote(path);
  }, [newName, createVaultNote, openNote]);

  /** Recursive tree rows with indent-per-depth and expand/collapse. */
  const renderNodes = useCallback((list: VaultNode[], depth: number): React.ReactNode[] =>
    list.map((node) => {
      if (node.kind === 'folder') {
        const open = expanded.has(node.path);
        return (
          <View key={node.path}>
            <TouchableOpacity
              style={[styles.row, { paddingLeft: 12 + depth * 16 }]}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel={`Folder ${node.name}`}
              onPress={() => toggleFolder(node.path)}
            >
              <Ionicons
                name={open ? 'folder-open-outline' : 'folder-outline'}
                size={16}
                color={c.accent}
              />
              <Text numberOfLines={1} style={[styles.rowName, { color: c.text }]}>{node.name}</Text>
              <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={c.textSecondary} />
            </TouchableOpacity>
            {open ? renderNodes(node.children, depth + 1) : null}
          </View>
        );
      }
      if (node.kind !== 'note' && node.kind !== 'file') return null;
      const isPdf = node.kind === 'file' && node.path.toLowerCase().endsWith('.pdf');
      if (node.kind === 'file' && !isPdf) return null;
      const isOpen = current?.path === node.path;
      return (
        <TouchableOpacity
          key={node.path}
          style={[
            styles.row,
            isOpen && { backgroundColor: c.surface2 },
            { paddingLeft: 12 + depth * 16 },
          ]}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`Open ${node.name}`}
          onPress={() => (isPdf ? openPdf(node.path) : openNote(node.path))}
        >
          <Ionicons
            name={isPdf ? 'document-outline' : 'document-text-outline'}
            size={15}
            color={c.textSecondary}
          />
          <Text numberOfLines={1} style={[styles.rowName, { color: c.text }]}>{node.name}</Text>
          {loadingNote === node.path ? <ActivityIndicator size="small" color={c.textSecondary} /> : null}
        </TouchableOpacity>
      );
    }), [expanded, toggleFolder, current?.path, loadingNote, openNote, openPdf, c]);

  const rootName = useMemo(() => state?.root?.split(/[\\/]/).filter(Boolean).pop() ?? null, [state?.root]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: c.background, borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => {
            tapLight();
            if (current) { setCurrent(null); setEditing(false); return; }
            navigation.goBack();
          }}
          style={styles.headerBtn}
          hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
          accessibilityRole="button"
          accessibilityLabel={current ? 'Back to vault' : 'Back'}
        >
          <Ionicons name="arrow-back" size={20} color={c.text} />
        </TouchableOpacity>
        <Text numberOfLines={1} style={[styles.headerTitle, { color: c.text }]}>
          {current ? current.path.split(/[\/]/).pop() : 'Vault'}
        </Text>
      </View>
      <DomainErrorBar domains={['vault']} />

      {!loaded ? (
        <ScreenLoading label="Opening vault" />
      ) : !state?.bound ? (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={[styles.unboundCard, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <Ionicons
              name={connected ? 'folder-outline' : 'cloud-offline-outline'}
              size={30}
              color={c.textSecondary}
            />
            <Text style={[styles.unboundTitle, { color: c.text }]}>
              {connected ? 'No vault bound' : 'Vault is offline'}
            </Text>
            <Text style={[styles.unboundBody, { color: c.textSecondary }]}>
              {connected
                ? 'On the desktop, open Settings → Vault and pick the folder that holds your notes. It syncs here — browse, read, and edit from your phone.'
                : 'Connect to your desktop to open the vault. A previously bound vault reappears once the connection is back.'}
            </Text>
          </View>
        </ScrollView>
      ) : current ? (
        <FadeIn style={styles.flex}>
          {/* Note header: back to tree, path, actions */}
          <View style={[styles.noteHeader, { borderBottomColor: c.border }]}>
            <Text numberOfLines={1} style={[styles.notePath, { color: c.textSecondary }]}>
              {current.path}
            </Text>
            <TouchableOpacity
              onPress={() => { tapLight(); setDraft(current.content); setEditing((v) => !v); }}
              style={styles.headerBtn}
              accessibilityRole="button"
              accessibilityLabel={editing ? 'Cancel editing' : 'Edit note'}
            >
              <Ionicons name={editing ? 'close' : 'create-outline'} size={19} color={c.text} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setNotice(null);
                setCurrent(null);
                setEditing(false);
                deleteVaultNote(current.path);
              }}
              style={styles.headerBtn}
              accessibilityRole="button"
              accessibilityLabel="Delete note"
            >
              <Ionicons name="trash-outline" size={18} color={c.error} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.noteBody}
            contentContainerStyle={{ paddingBottom: 64 }}
            keyboardShouldPersistTaps="handled"
          >
            {loadingNote === current.path ? (
              <ActivityIndicator size="small" color={c.accent} style={{ marginTop: 24 }} />
            ) : editing ? (
              <>
                <TextInput
                  style={[styles.editor, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
                  value={draft}
                  onChangeText={setDraft}
                  multiline
                  textAlignVertical="top"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  style={[styles.saveBtn, { backgroundColor: c.accent }]}
                  onPress={saveDraft}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Save note"
                >
                  <Text style={{ color: c.white, fontWeight: '700' }}>Save note</Text>
                </TouchableOpacity>
              </>
            ) : (
              <MarkdownText content={current.content || '*Empty note — tap the pencil to write.*'} />
            )}
          </ScrollView>
        </FadeIn>
      ) : (
        <>
          {/* Vault summary strip + new note */}
          {!connected ? (
            <Text style={[styles.offlineHint, { color: c.textSecondary }]}>
              Offline — showing the last synced vault. Edits need a connection.
            </Text>
          ) : null}
          <View style={styles.summaryRow}>
            <Text numberOfLines={1} style={[styles.summaryRoot, { color: c.textSecondary }]}>
              <Ionicons name="folder" size={11} color={c.accent} /> {rootName ?? 'vault'}
              {state?.notes != null ? ` · ${state.notes} notes` : ''}
            </Text>
            <TouchableOpacity
              style={[styles.newNoteBtn, { backgroundColor: c.accent }]}
              onPress={() => { tapLight(); setNewName(''); setCreating(true); }}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="New note"
            >
              <Ionicons name="add" size={15} color={c.white} />
              <Text style={{ color: c.white, fontSize: 12, fontWeight: '700' }}>Note</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {notice ? (
              <TouchableOpacity onPress={() => setNotice(null)}>
                <Text style={[styles.notice, { color: c.accent }]}>{notice} · tap to dismiss</Text>
              </TouchableOpacity>
            ) : null}
            {nodes.length === 0 ? (
              <Text style={[styles.empty, { color: c.textSecondary }]}>
                The bound folder has no notes yet. Create one, or add files on the desktop.
              </Text>
            ) : (
              <FadeIn>{renderNodes(nodes, 0)}</FadeIn>
            )}
          </ScrollView>

          {/* Full-screen PDF viewer (desktop PDF pane parity) */}
          <Modal
            visible={pdf != null}
            animationType="slide"
            onRequestClose={() => setPdf(null)}
          >
            <SafeAreaView style={[styles.pdfScreen, { backgroundColor: '#171614' }]} edges={['top', 'bottom']}>
              <View style={styles.pdfHeader}>
                <Text numberOfLines={1} style={[styles.pdfTitle, { color: c.text }]}>
                  {pdf?.path.split(/[\/]/).pop()}
                </Text>
                <TouchableOpacity
                  onPress={() => { tapLight(); setPdf(null); }}
                  style={styles.headerBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Close pdf"
                >
                  <Ionicons name="close" size={22} color={c.text} />
                </TouchableOpacity>
              </View>
              {pdf ? <PdfView base64={pdf.dataBase64} /> : null}
            </SafeAreaView>
          </Modal>

          {/* New-note sheet */}
          <Modal visible={creating} transparent animationType="slide" onRequestClose={() => setCreating(false)}>
            <View style={[styles.sheetScrim, { backgroundColor: c.scrim }]}>
              <View style={[styles.sheet, { backgroundColor: c.elevated }]}>
                <Text style={[styles.sheetTitle, { color: c.text }]}>New note</Text>
                <TextInput
                  style={[styles.sheetInput, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
                  placeholder="note name (folders with / allowed)"
                  placeholderTextColor={c.textSecondary}
                  value={newName}
                  onChangeText={setNewName}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  style={[styles.sheetBtn, { backgroundColor: c.accent }]}
                  onPress={createNote}
                  accessibilityRole="button"
                  accessibilityLabel="Create note"
                >
                  <Text style={{ color: c.white, fontWeight: '700' }}>Create</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetBtn}
                  onPress={() => setCreating(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                >
                  <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.sm },
  note: { fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  body: { padding: theme.spacing.md },
  unboundCard: {
    borderRadius: theme.radius.lg, borderWidth: 1,
    alignItems: 'center', gap: theme.spacing.sm,
    padding: theme.spacing.xl,
  },
  unboundTitle: { fontSize: 16, fontWeight: '700' },
  unboundBody: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  offlineHint: { fontSize: 11, textAlign: 'center', paddingBottom: 4 },
  summaryRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm, paddingBottom: 4,
  },
  summaryRoot: { fontSize: 12, flexShrink: 1 },
  newNoteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderRadius: theme.radius.pill, paddingHorizontal: 12, paddingVertical: 6,
  },
  list: { flex: 1, paddingBottom: 40 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 9, paddingRight: theme.spacing.md,
  },
  rowName: { flex: 1, fontSize: 14 },
  notice: { fontSize: 12, textAlign: 'center', paddingVertical: 6 },
  empty: { textAlign: 'center', paddingVertical: 48, paddingHorizontal: 24, fontSize: 13 },
  noteHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: theme.spacing.sm, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pdfScreen: { flex: 1 },
  pdfHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md, paddingVertical: 10,
  },
  pdfTitle: { flex: 1, fontSize: 13, fontFamily: 'monospace', marginRight: 8 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: theme.spacing.sm, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: '700' },
  notePath: { flex: 1, fontSize: 12, fontFamily: 'monospace', marginHorizontal: 4 },
  noteBody: { flex: 1, padding: theme.spacing.md, paddingBottom: 56 },
  editor: {
    minHeight: 320, borderRadius: theme.radius.md, borderWidth: 1,
    padding: theme.spacing.md, fontSize: 13, fontFamily: 'monospace',
  },
  saveBtn: {
    alignSelf: 'flex-end', marginTop: 10,
    borderRadius: theme.radius.pill, paddingHorizontal: 18, paddingVertical: 9,
  },
  sheetScrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg,
    padding: theme.spacing.lg, gap: theme.spacing.md,
  },
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  sheetInput: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
  },
  sheetBtn: {
    borderRadius: theme.radius.pill, paddingVertical: 11, alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent',
  },
});
