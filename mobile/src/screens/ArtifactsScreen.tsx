import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import { onArtifactLibrary, onArtifactPreview, getCachedArtifactPreview, useRelay, type ArtifactLibraryEntry, type ArtifactPreview, type SessionArtifact } from '../hooks/useRelay';
import ArtifactSheet, { extOf } from '../components/chat/ArtifactSheet';
import MarkdownText from '../components/chat/MarkdownText';
import { tapLight } from '../lib/haptics';
import DomainErrorBar from '../components/DomainErrorBar';

/**
 * Artifact library — the phone mirror of the desktop ArtifactLibrary: a GRID
 * of cards whose upper half is a per-type preview (image thumbnail, rendered
 * markdown/text snippet, or a type icon), fetched lazily through the relay's
 * ReadArtifactPreview op and cached per path so scrolling never refetches.
 * Tapping a card opens the full ArtifactSheet.
 */

const KIND_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  html: 'globe-outline',
  code: 'code-slash-outline',
  csv: 'grid-outline',
  json: 'code-working-outline',
  docx: 'document-text-outline',
  xlsx: 'grid-outline',
  pptx: 'easel-outline',
  pdf: 'document-attach-outline',
  md: 'document-text-outline',
  markdown: 'document-text-outline',
  diagram: 'git-network-outline',
  office: 'document-outline',
  image: 'image-outline',
  binary: 'document-outline',
};

function useArtifactPreview(path: string | null) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(
    path ? getCachedArtifactPreview(path) ?? null : null,
  );
  const { readArtifactPreview } = useRelay();
  useEffect(() => {
    if (!path) return;
    const cached = getCachedArtifactPreview(path);
    if (cached) { setPreview(cached); return; }
    setPreview(null);
    readArtifactPreview(path);
    return onArtifactPreview.on(({ preview: p }) => {
      if (p.path === path) setPreview(p);
    });
  }, [path, readArtifactPreview]);
  return preview;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts * 1000) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ArtifactsScreen() {
  useScreenMountTiming('ArtifactsScreen');
  const navigation = useNavigation<any>();
  const { listArtifacts, connected } = useRelay();
  const c = theme.colors;
  const [entries, setEntries] = useState<ArtifactLibraryEntry[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    listArtifacts();
    const off = onArtifactLibrary.on(({ artifacts }) => setEntries(artifacts));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.filename.toLowerCase().includes(q));
  }, [entries, query]);

  const [preview, setPreview] = useState<ArtifactLibraryEntry | null>(null);
  const [sheetInitial, setSheetInitial] = useState<string | undefined>(undefined);
  const [sheetArtifacts, setSheetArtifacts] = useState<SessionArtifact[]>([]);

  const openEntry = useCallback((entry: ArtifactLibraryEntry) => {
    tapLight();
    setPreview(entry);
    setSheetInitial(entry.path);
    setSheetArtifacts([{ path: entry.path, filename: entry.filename, kind: entry.kind as 'jsx' | 'tsx' | undefined }]);
  }, []);

  const renderTile = useCallback(({ item }: { item: ArtifactLibraryEntry }) => (
    <ArtifactTile entry={item} onPress={() => openEntry(item)} />
  ), [openEntry]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: c.text }]}>Artifacts</Text>
        <TouchableOpacity
          onPress={() => listArtifacts()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Refresh artifacts"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="refresh" size={20} color={c.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
      <DomainErrorBar domains={['artifacts', 'preview']} />
        <View style={[styles.searchField, { backgroundColor: c.surface2, borderColor: c.border }]}>
          <Ionicons name="search" size={15} color={c.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: c.text }]}
            value={query}
            onChangeText={setQuery}
            placeholder="Search artifacts"
            placeholderTextColor={c.textSecondary}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item, i) => `${item.path}-${i}`}
        numColumns={2}
        columnWrapperStyle={filtered.length > 0 ? styles.column : undefined}
        contentContainerStyle={styles.grid}
        renderItem={renderTile}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: c.textSecondary }}>
              {connected ? 'No artifacts yet.' : 'Connect to your desktop to see artifacts.'}
            </Text>
          </View>
        }
      />

      {preview ? (
        <ArtifactSheet
          visible
          onClose={() => setPreview(null)}
          artifacts={sheetArtifacts}
          sessionId={preview.chat_session_id ?? '__library__'}
          initialPath={sheetInitial}
          initialPreview={getCachedArtifactPreview(sheetInitial ?? '')}
        />
      ) : null}
    </SafeAreaView>
  );
}

function ArtifactTile({ entry, onPress }: { entry: ArtifactLibraryEntry; onPress: () => void }) {
  const c = theme.colors;
  const preview = useArtifactPreview(entry.path);
  const kind = preview?.kind ?? entry.kind;
  const isImage = kind === 'image' && !!preview?.data_uri;
  const snippet = preview?.text?.slice(0, 320);
  const isMarkdown = kind === 'markdown' || extOf(entry.filename) === 'md';

  return (
    <TouchableOpacity
      style={[styles.tile, { backgroundColor: c.surface, borderColor: c.border }]}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Artifact ${entry.filename}`}
      onPress={onPress}
    >
      {/* pointerEvents none: preview content (text/markdown/images) must not
          swallow the card's press — the whole tile is one tap target. */}
      <View pointerEvents="none" style={[styles.thumb, { backgroundColor: c.surface2 }]}>
        {isImage ? (
          <Image
            source={{ uri: preview.data_uri! }}
            style={styles.thumbImg}
            resizeMode="cover"
          />
        ) : snippet ? (
          <View style={styles.snippetBox}>
            {isMarkdown ? (
              <View style={styles.snippetClip}>
                <MarkdownText content={snippet} />
              </View>
            ) : (
              <Text style={[styles.snippetMono, { color: c.textSecondary }]} numberOfLines={5}>
                {snippet}
              </Text>
            )}
          </View>
        ) : (
          <Ionicons name={KIND_ICONS[kind] ?? 'document-outline'} size={30} color={c.textSecondary} />
        )}
        <View style={[styles.kindBadge, { backgroundColor: c.bubble }]}>
          <Text style={[styles.kindBadgeText, { color: c.accent }]}>
            {(preview?.ext || entry.kind || 'file').toUpperCase().slice(0, 5)}
          </Text>
        </View>
      </View>
      <View pointerEvents="none" style={styles.tileFooter}>
        <Text style={[styles.tileName, { color: c.text }]} numberOfLines={1}>
          {entry.filename}
        </Text>
        <Text style={[styles.tileMeta, { color: c.textSecondary }]}>{timeAgo(entry.created_at)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  searchWrap: { paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: theme.fontSize.sm, padding: 0 },
  grid: { paddingHorizontal: 10, paddingBottom: 40, gap: 10 },
  column: { gap: 10 },
  tile: {
    flex: 1,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  thumb: {
    height: 118,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImg: { width: '100%', height: '100%' },
  snippetBox: { padding: 8, width: '100%', height: '100%', overflow: 'hidden' },
  snippetClip: { transform: [{ scale: 0.62 }], width: '162%' },
  snippetMono: { fontSize: 8, fontFamily: 'monospace', lineHeight: 11 },
  kindBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  kindBadgeText: { fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  tileFooter: { paddingHorizontal: 10, paddingVertical: 8, gap: 1 },
  tileName: { fontSize: 12, fontWeight: '600' },
  tileMeta: { fontSize: 9 },
  empty: { paddingVertical: 48, alignItems: 'center' },
});
