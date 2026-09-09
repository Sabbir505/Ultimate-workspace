/**
 * ArtifactSheet — bottom sheet listing a session's artifacts with an inline
 * preview of the selected one.
 *
 * Contract (self-contained; the chip and screens only pass data):
 *   <ArtifactSheet visible onClose artifacts={SessionArtifact[]} sessionId initialPath? />
 *
 * Preview routing by file kind:
 * - jsx/tsx inline payloads (`artifact.inline.code`) render directly, no fetch.
 * - text-ish extensions → mono ScrollView preview, fetched over the relay via
 *   `useRelay().readArtifact` + the `onArtifactContent` event bus; shows a
 *   cap note when the desktop truncated the payload.
 * - images (png/jpg/jpeg/gif/webp) → base64 data-URI Image, contain fit.
 * - everything else (pdf, docx, …) → a "Save / share" card explaining the
 *   phone can't preview it; writes to the cache directory via expo-file-system
 *   and opens expo-sharing (graceful Alert when the share sheet is missing).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Image,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { theme } from '../../theme';
import { useRelay, onArtifactContent, type SessionArtifact } from '../../hooks/useRelay';
import { tapLight } from '../../lib/haptics';

export interface ArtifactSheetProps {
  visible: boolean;
  onClose: () => void;
  artifacts: SessionArtifact[];
  /** Session id — required to fetch file contents over the relay. */
  sessionId?: string;
  /** Artifact to select when the sheet opens (defaults to the first). */
  initialPath?: string;
}

/** Extensions previewable as monospace text. */
const TEXT_EXTS = new Set([
  'md', 'txt', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'html', 'css',
  'csv', 'log', 'yaml', 'yml', 'toml', 'xml', 'svg', 'sh',
]);

/** Image extensions → mime for the base64 data URI. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Uppercase extension of a path/filename ('' when it has none). */
export function extOf(pathOrName: string): string {
  const base = pathOrName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function mimeFor(a: SessionArtifact): string {
  const ext = extOf(a.filename || a.path);
  return IMAGE_MIME[ext] ?? 'application/octet-stream';
}

type PreviewMode = 'inline' | 'text' | 'image' | 'binary';

function previewModeOf(a: SessionArtifact): PreviewMode {
  if (a.inline) return 'inline';
  const ext = extOf(a.filename || a.path);
  if (IMAGE_MIME[ext] || a.kind === 'image') return 'image';
  if (TEXT_EXTS.has(ext) || a.kind === 'text') return 'text';
  return 'binary';
}

/** Fetched ArtifactContent payload, as delivered by the relay event bus. */
interface ArtifactContent {
  text?: string;
  dataBase64?: string;
  truncated: boolean;
}

/** How long to wait for the desktop's ArtifactContent before showing an error. */
const FETCH_TIMEOUT_MS = 12_000;

export function ArtifactSheet({ visible, onClose, artifacts, sessionId, initialPath }: ArtifactSheetProps): JSX.Element {
  const c = theme.colors;
  const { connected, readArtifact } = useRelay();

  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selected artifact: explicit tap, else the initial path, else the first.
  const selected = useMemo(
    () => artifacts.find((a) => a.path === selectedPath) ?? artifacts[0] ?? null,
    [artifacts, selectedPath],
  );
  const mode = selected ? previewModeOf(selected) : null;

  const select = useCallback((path: string) => {
    tapLight();
    setSelectedPath(path);
  }, []);

  // Re-seed the selection each time the sheet opens.
  useEffect(() => {
    if (visible) setSelectedPath(initialPath ?? artifacts[0]?.path ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialPath]);

  // Fetch the selected artifact's content over the relay and wait for the
  // matching ArtifactContent event (subscription lives inside the effect so
  // stale responses for a previous selection can't land).
  useEffect(() => {
    if (!visible || !selected || mode === 'inline') {
      setContent(null);
      setError(null);
      setLoading(false);
      return;
    }
    setContent(null);
    setError(null);
    if (!sessionId) {
      setError('No session context — reopen this artifact from the chat.');
      return;
    }
    if (!connected) {
      setError('Not connected to the desktop. Reconnect in Settings and try again.');
      return;
    }
    let done = false;
    setLoading(true);
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        setLoading(false);
        setError('The desktop didn’t respond — it may be busy. Try again.');
      }
    }, FETCH_TIMEOUT_MS);
    const off = onArtifactContent.on((p) => {
      if (done || p.sessionId !== sessionId || p.path !== selected.path) return;
      done = true;
      clearTimeout(timeout);
      setLoading(false);
      if (p.text == null && p.dataBase64 == null) {
        setError('The desktop returned no content for this file.');
        return;
      }
      setContent({ text: p.text, dataBase64: p.dataBase64, truncated: !!p.truncated });
    });
    readArtifact(sessionId, selected.path);
    return () => {
      done = true;
      clearTimeout(timeout);
      off();
    };
  }, [visible, selected, mode, sessionId, connected, readArtifact]);

  // ---- Save / share (binary kinds) ----
  const handleShare = useCallback(async () => {
    if (!selected || !content) return;
    const rawName = selected.filename || selected.path.split(/[\\/]/).pop() || 'artifact';
    // Keep cache writes predictable across platforms.
    const safeName = rawName.replace(/[^A-Za-z0-9._ -]/g, '_') || 'artifact';
    try {
      const file = new File(Paths.cache, safeName);
      if (file.exists) file.delete();
      if (!file.exists) file.create();
      if (content.dataBase64) file.write(content.dataBase64, { encoding: 'base64' });
      else if (content.text != null) file.write(content.text);
      else throw new Error('no content');
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert(
          'Sharing unavailable',
          'This device has no share sheet. The file was saved to the app’s cache directory.',
        );
        return;
      }
      await Sharing.shareAsync(file.uri, { mimeType: mimeFor(selected), dialogTitle: rawName });
    } catch {
      Alert.alert('Couldn’t save file', 'Saving or sharing this file failed on this device.');
    }
  }, [selected, content]);

  const filename = selected ? (selected.filename || selected.path.split(/[\\/]/).pop() || selected.path) : '';

  // ---- Preview body per kind ----
  let body: JSX.Element;
  if (!selected) {
    body = (
      <View style={styles.centered}>
        <Text style={[styles.emptyText, { color: c.textSecondary }]}>No artifacts yet.</Text>
      </View>
    );
  } else if (mode === 'inline') {
    body = (
      <ScrollView style={styles.previewScroll} showsVerticalScrollIndicator>
        <View style={[styles.codeBox, { backgroundColor: c.surface2 }]}>
          <Text style={[styles.codeText, { color: c.text }]} selectable>
            {selected.inline!.code}
          </Text>
        </View>
      </ScrollView>
    );
  } else if (error) {
    body = (
      <View style={styles.centered}>
        <Text style={[styles.errorText, { color: c.error }]}>{error}</Text>
      </View>
    );
  } else if (loading || !content) {
    body = (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={c.accent} />
        <Text style={[styles.loadingText, { color: c.textSecondary }]}>Loading…</Text>
      </View>
    );
  } else if (mode === 'image' && content.dataBase64) {
    body = (
      <View style={[styles.imageWrap, { backgroundColor: c.surface2 }]}>
        <Image
          source={{ uri: `data:${mimeFor(selected)};base64,${content.dataBase64}` }}
          style={styles.image}
          resizeMode="contain"
        />
      </View>
    );
  } else if (mode === 'text' && content.text != null) {
    body = (
      <View style={{ flex: 1 }}>
        <ScrollView style={styles.previewScroll} showsVerticalScrollIndicator>
          <View style={[styles.codeBox, { backgroundColor: c.surface2 }]}>
            <Text style={[styles.codeText, { color: c.text }]} selectable>
              {content.text.length > 0 ? content.text : '(empty file)'}
            </Text>
          </View>
        </ScrollView>
        {content.truncated ? (
          <View style={[styles.capNote, { borderTopColor: c.border }]}>
            <Text style={[styles.capNoteText, { color: c.textSecondary }]}>
              Preview truncated — open on desktop for the full file
            </Text>
          </View>
        ) : null}
      </View>
    );
  } else {
    // binary (pdf, docx, …) — no phone preview; offer save/share.
    body = (
      <View style={[styles.binaryCard, { backgroundColor: c.surface2, borderColor: c.border }]}>
        <Text style={[styles.binaryTitle, { color: c.text }]}>Preview isn’t supported on your phone</Text>
        <Text style={[styles.binaryText, { color: c.textSecondary }]}>
          PDF, Office and other binary files open best on desktop. Save a copy to
          share it or open it in another app.
        </Text>
        <TouchableOpacity
          style={[styles.shareButton, { backgroundColor: c.accent }]}
          onPress={() => {
            tapLight();
            void handleShare();
          }}
          activeOpacity={0.7}
        >
          <Text style={[styles.shareButtonText, { color: c.white }]}>Save / share</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Scrim — tap to dismiss. */}
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={[styles.scrim, { backgroundColor: c.scrim }]}>
          <TouchableWithoutFeedback onPress={() => { /* keep taps inside the sheet */ }}>
            <View style={[styles.sheet, { backgroundColor: c.elevated, maxHeight: '80%' }]}>
              <View style={[styles.grabber, { backgroundColor: c.border }]} />
              <View style={styles.header}>
                <View style={styles.headerText}>
                  <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
                    {artifacts.length > 1 ? 'Artifacts' : filename}
                  </Text>
                  {selected ? (
                    <Text style={[styles.pathText, { color: c.textSecondary }]} numberOfLines={1}>
                      {selected.path}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  style={[styles.closeButton, { backgroundColor: c.surface2 }]}
                  onPress={() => {
                    tapLight();
                    onClose();
                  }}
                  hitSlop={{ top: 8, left: 8, right: 8, bottom: 8 }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.closeGlyph, { color: c.textSecondary }]}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* Artifact list — horizontal pills when there's more than one. */}
              {artifacts.length > 1 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.listRow}
                  contentContainerStyle={styles.listRowContent}
                >
                  {artifacts.map((a) => {
                    const active = selected?.path === a.path;
                    const badge = a.inline ? a.inline.kind.toUpperCase() : (extOf(a.filename || a.path) || 'file');
                    return (
                      <TouchableOpacity
                        key={a.path}
                        style={[
                          styles.pill,
                          { backgroundColor: c.surface2, borderColor: active ? c.accent : c.border },
                        ]}
                        onPress={() => select(a.path)}
                        activeOpacity={0.7}
                      >
                        <View style={[styles.pillBadge, { backgroundColor: c.bubble }]}>
                          <Text style={[styles.pillBadgeText, { color: c.accent }]}>{badge.slice(0, 4)}</Text>
                        </View>
                        <Text
                          style={[styles.pillName, { color: active ? c.text : c.textSecondary }]}
                          numberOfLines={1}
                        >
                          {a.filename || a.path.split(/[\\/]/).pop() || a.path}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              ) : null}

              <View style={styles.previewArea}>{body}</View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.lg,
    height: '80%',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: theme.spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { ...theme.type.title, fontSize: theme.fontSize.lg },
  pathText: { ...theme.type.secondary, marginTop: 1 },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeGlyph: { fontSize: 13, lineHeight: 16 },
  listRow: { flexGrow: 0, marginBottom: theme.spacing.sm },
  listRowContent: { paddingHorizontal: theme.spacing.md, gap: theme.spacing.sm },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill,
    paddingLeft: 4,
    paddingRight: theme.spacing.sm,
    paddingVertical: 4,
    gap: 6,
    maxWidth: 220,
  },
  pillBadge: {
    borderRadius: theme.radius.pill,
    minWidth: 34,
    paddingHorizontal: 6,
    paddingVertical: 3,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pillBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  pillName: { fontSize: theme.fontSize.sm, flexShrink: 1 },
  previewArea: { flex: 1, paddingHorizontal: theme.spacing.md },
  previewScroll: { flex: 1 },
  codeBox: {
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  codeText: { ...theme.type.mono, fontSize: theme.fontSize.sm, lineHeight: 19 },
  imageWrap: {
    flex: 1,
    borderRadius: theme.radius.sm,
    marginBottom: theme.spacing.sm,
    overflow: 'hidden',
  },
  image: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.sm },
  loadingText: { ...theme.type.secondary },
  errorText: { ...theme.type.secondary, textAlign: 'center', paddingHorizontal: theme.spacing.md },
  emptyText: { ...theme.type.secondary },
  capNote: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: theme.spacing.sm,
  },
  capNoteText: { ...theme.type.secondary, textAlign: 'center' },
  binaryCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  binaryTitle: { ...theme.type.title, fontSize: theme.fontSize.md, marginBottom: theme.spacing.xs },
  binaryText: { ...theme.type.secondary, marginBottom: theme.spacing.md },
  shareButton: {
    alignSelf: 'flex-start',
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
  },
  shareButtonText: { fontSize: theme.fontSize.sm, fontWeight: '600' },
});

export default ArtifactSheet;
