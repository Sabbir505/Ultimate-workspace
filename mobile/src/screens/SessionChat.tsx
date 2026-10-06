/**
 * SessionChat — the ChatGPT-app-style conversation screen for one session.
 *
 * Layout (top to bottom):
 *   Header      back · centered title (long-press to rename) · model chip
 *               (opens ModelSheet) · drawer menu button (AppDrawer)
 *   Messages    NORMAL top-down FlatList — oldest first, newest at the
 *               bottom, auto-scrolled to the newest content. Older pages
 *               load ONLY through the "Load older messages" button at the
 *               top of the list (listHeader → chat.loadMore); there is no
 *               onEndReached auto-pagination. User turns render as
 *               right-aligned bubbles; assistant turns render full-width
 *               as plain text with think/tool segments (MessageBubble).
 *               The live streaming turn renders in the footer at the bottom
 *               of the list (listFooter), with the first-load spinner.
 *   Approvals   pending ApprovalCards between the list and the composer.
 *   Plan card   live plan proposal pinned above the composer.
 *   Status      transient status pill (StatusBanner) + error banner.
 *   Composer    ChatComposer pill (send / stop / voice / attachments).
 *
 * `deleted` flips to a full-screen "This conversation was cleared" card
 * with a "Go back" button.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated,
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  TextInput,
  Modal,
  ActivityIndicator,
  RefreshControl,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const ArrowLeft = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="arrow-back" size={size} color={color} />;
const ChevronDown = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="chevron-down" size={size} color={color} />;
import { theme as themeMod } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import { tapLight } from '../lib/haptics';
// Shared token abbreviation (12480 → "12.5k") — same formatter the cost
// dashboard uses.
import { formatTokens as tokens , formatDuration } from '../lib/format';
import { screenCacheGet, screenCacheSet } from '../lib/screenCache';
import { onProjectList, type ProjectInfo } from '../hooks/useRelay';
import { useRelay, onConnectorList, onSessionConnectors, onSessionConnectorsSet, type ConnectorInfo, type SessionArtifact, type SessionChatAttachment, type SessionMessageRecord, onAcpAgentList, type AcpAgentInfo} from '../hooks/useRelay';
import { useSessionChat } from '../hooks/useSessionChat';
import MessageBubble from '../components/chat/MessageBubble';
import ChatComposer from '../components/chat/ChatComposer';
import ApprovalCard from '../components/chat/ApprovalCard';
import StatusBanner from '../components/chat/StatusBanner';
import PlanCard from '../components/chat/PlanCard';
import QuestionCard from '../components/chat/QuestionCard';
import ModelSheet from '../components/chat/ModelSheet';
import ActionSheet, { type ActionSheetItem } from '../components/chat/ActionSheet';
import ArtifactSheet, { extOf } from '../components/chat/ArtifactSheet';
import DiffSheet from '../components/chat/DiffSheet';
import ChatGitSheet from '../components/chat/ChatGitSheet';
import { useDrawerActions } from '../components/AppDrawer';
import * as Clipboard from 'expo-clipboard';

export default function SessionChat() {
  useScreenMountTiming('SessionChat');
  const navigation = useNavigation<any>();
  const { open: openSidebar } = useDrawerActions();
  const route = useRoute<any>();
  const session = route.params?.session as { id: string; title?: string; projectName?: string } | undefined;
  const sessionId: string | null = (route.params?.sessionId as string | undefined) ?? session?.id ?? null;

  const c = themeMod.colors;
  const { providers, harnesses, connected, transcribeAudio, startLocalModel, listConnectors, getSessionConnectors, setSessionConnectors, listAcpAgents } = useRelay();
  const chat = useSessionChat(sessionId);
  const insets = useSafeAreaInsets();

  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // ACP agents for the picker's Agents · ACP rail (desktop parity).
  const [acpAgents, setAcpAgents] = useState<AcpAgentInfo[]>([]);
  // Listener wiring is mount-scoped: the callbacks are stable module consts,
  // but under a render loop the effect could re-run per pass and fire a relay
  // query each time (measured ~60 ListAcpAgents/ListConnectors/
  // GetSessionConnectors per second — the storm that starved the desktop's DB
  // mutex). Ref-guards keep the fetch to once per (connected) / (session).
  const fetchedAcpFor = React.useRef<boolean | null>(null);
  React.useEffect(() => {
    if (!connected) { fetchedAcpFor.current = null; return; }
    if (fetchedAcpFor.current === true) return;
    fetchedAcpFor.current = true;
    listAcpAgents();
    const off = onAcpAgentList.on(({ agents }) => setAcpAgents(agents));
    return () => { fetchedAcpFor.current = null; off(); };
  }, [connected, listAcpAgents]);
  // Composer @-menu state for THIS session.
  const [connectorList, setConnectorList] = useState<ConnectorInfo[]>([]);
  const [attachedConnectors, setAttachedConnectors] = useState<string[]>([]);
  const fetchedConnectorsFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!connected || !sessionId) return;
    const key = `${sessionId}`;
    if (fetchedConnectorsFor.current === key) return;
    fetchedConnectorsFor.current = key;
    listConnectors();
    getSessionConnectors(sessionId);
    const offList = onConnectorList.on(({ connectors }) => setConnectorList(connectors));
    const offGet = onSessionConnectors.on(({ sessionId: sid, connectorIds }) => {
      if (sid === sessionId) setAttachedConnectors(connectorIds);
    });
    const offSet = onSessionConnectorsSet.on(({ sessionId: sid, connectorIds }) => {
      if (sid === sessionId) setAttachedConnectors(connectorIds);
    });
    return () => { fetchedConnectorsFor.current = null; offList(); offGet(); offSet(); };
  }, [connected, sessionId, listConnectors, getSessionConnectors]);
  const toggleConnector = React.useCallback((id: string) => {
    if (!sessionId) return;
    setAttachedConnectors((prev) => {
      const next = prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id];
      setSessionConnectors(sessionId, next);
      return next;
    });
  }, [sessionId, setSessionConnectors]);
  // --- Batch 1 surfaces: message actions, edit, chat menu, checkpoints ---
  const [actionTarget, setActionTarget] = useState<{ id: number; role: string; content: string } | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const listRef = useRef<FlatList>(null);
  const lastAutoScrollRef = useRef(0);

  const title = chat.meta?.title ?? session?.title ?? 'Chat';
  // Folder chip (desktop parity): the bound project's name, resolved from the
  // cached project list (kept fresh by the connect prefetch + drawer).
  const [projects, setProjects] = useState<ProjectInfo[]>(() =>
    screenCacheGet<ProjectInfo[]>('projects.list') ?? [],
  );
  useEffect(() => onProjectList.on(({ projects: list }) => {
    screenCacheSet('projects.list', list);
    setProjects(list);
  }), []);
  // Instant-then-correct: meta.projectName arrives with GetSessionMeta
  // (desktop resolves it), the route param carries it from the drawer, and
  // the cached project list is the last fallback.
  const projectName =
    chat.meta?.projectName ??
    session?.projectName ??
    (chat.meta?.projectId
      ? projects.find((p) => p.id === chat.meta?.projectId)?.name ?? null
      : null);

  // Diff peek (desktop DiffCard/PeekPanel parity): a file-edit activity row
  // opens the git diff for that path against the session's bound project.
  const [diffPath, setDiffPath] = useState<string | null>(null);
  // Chat-scoped git tool sheet (desktop GitToolsSidebar parity) — only for
  // project-bound chats; there is nothing git-shaped to show otherwise.
  const [gitSheetOpen, setGitSheetOpen] = useState(false);
  const handlePeekDiff = useCallback((path: string) => {
    if (!chat.meta?.projectId) return;
    setDiffPath(path);
  }, [chat.meta?.projectId]);

  // Compact token/cost line for the last completed turn (desktop composer
  // metrics parity). `tokens` comes from the shared formatTokens formatter.

  // A first message handed over from the new-chat composer (home screen):
  // send it through the normal composer path once mounted so the optimistic
  // bubble + stream state land in THIS hook, then clear the param so a
  // remount doesn't re-send.
  const firstMessage = route.params?.firstMessage as string | undefined;
  const firstAttachments = route.params?.firstAttachments as
    | { name: string; kind: 'text' | 'image' | 'doc'; text?: string; data?: string; media_type?: string; format?: string }[]
    | undefined;
  useEffect(() => {
    if (firstMessage && sessionId) {
      chat.send(firstMessage, firstAttachments);
      navigation.setParams({ firstMessage: undefined, firstAttachments: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMessage, sessionId]);

  // Auto-scroll to the newest content (normal top-down list → the end).
  // Throttled to one scroll per 100 ms so streaming tokens don't fight the
  // layout engine for the whole turn (PERFORMANCE_AUDIT.md M5).
  // Live turn timer (desktop "Working for Xs" parity): stamp when the turn
  // starts, tick once a second while streaming.
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (chat.streaming) {
      setStreamStartedAt((prev) => prev ?? Date.now());
      const t = setInterval(() => setNowTick(Date.now()), 1000);
      return () => clearInterval(t);
    }
    setStreamStartedAt(null);
  }, [chat.streaming]);

  // Scroll-to-bottom (desktop parity): track whether the user is at the
  // newest content. Away from the bottom, the auto-scroll stands down (it
  // must not yank the reader) and a floating button offers the jump back.
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const scrollBtnOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(scrollBtnOpacity, {
      toValue: atBottom ? 0 : 1,
      duration: 150,
      useNativeDriver: true,
    }).start();
  }, [atBottom, scrollBtnOpacity]);
  const handleListScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const nearBottom =
      layoutMeasurement.height + contentOffset.y >= contentSize.height - 140;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    }
  }, []);
  const scrollToLatest = useCallback(() => {
    tapLight();
    atBottomRef.current = true;
    setAtBottom(true);
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 100000, animated: true }));
  }, []);
  useEffect(() => {
    if (chat.messages.length === 0 && chat.streamingContent.length === 0) return;
    // The user scrolled up to read — do not yank them to the bottom on every
    // token; the floating button offers the jump instead.
    if (!atBottomRef.current) return;
    const scroll = () => {
      lastAutoScrollRef.current = Date.now();
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 100000, animated: true }));
    };
    const elapsed = Date.now() - lastAutoScrollRef.current;
    if (elapsed >= 100) {
      scroll();
      return;
    }
    const t = setTimeout(scroll, 100 - elapsed);
    return () => clearTimeout(t);
  }, [chat.messages.length, chat.streamingContent]);

  const openRename = useCallback(() => {
    setRenameValue(title);
    setRenameOpen(true);
  }, [title]);

  const handleRename = useCallback(() => {
    const next = renameValue.trim();
    setRenameOpen(false);
    if (next.length === 0 || next === title) return;
    chat.rename(next);
  }, [chat, renameValue, title]);

  // --- List chrome (memoized so streaming tokens don't rebuild it) ---
  // The list is a NORMAL top-down list (oldest first). The old inverted list
  // counter-flipped every row with scaleY:-1, which renders as scrambled,
  // overlapping glyphs on Android's new architecture.

  const listHeader = useMemo(() => (
    // TOP of the list: pagination — fetch the page of older messages.
    chat.hasMore ? (
      <TouchableOpacity
        onPress={chat.loadMore}
        disabled={chat.loading}
        style={[styles.loadMoreBtn, { backgroundColor: c.surface2, borderColor: c.border }]}
      >
        {chat.loading ? (
          <ActivityIndicator size="small" color={c.textSecondary} />
        ) : (
          <Text style={[styles.loadMoreText, { color: c.text }]}>Load older messages</Text>
        )}
      </TouchableOpacity>
    ) : null
  ), [chat.loading, chat.hasMore, chat.loadMore, c.textSecondary, c.surface2, c.border, c.text]);

  const listFooter = useMemo(() => (
    // BOTTOM of the list: first-load state + the live streaming turn.
    <View>
      {chat.loading && chat.messages.length === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={c.textSecondary} />
        </View>
      ) : null}
      {chat.streaming ? (
        <View style={styles.streamTail}>
          {/* Live turn timer (desktop "Working for Xs" parity) — ticks once a
              second from when the turn started. */}
          <Text style={[styles.workingLabel, { color: c.textSecondary }]}>
            Working for {formatDuration(Math.max(1, Math.floor((nowTick - (streamStartedAt ?? nowTick)) / 1000)))}
          </Text>
          <MessageBubble
            role="assistant"
            content={chat.streamingContent}
            streaming
            onPeekDiff={handlePeekDiff}
          />
        </View>
      ) : null}
    </View>
  ), [chat.loading, chat.hasMore, chat.messages.length, chat.streaming, chat.streamingContent, streamStartedAt, nowTick, handlePeekDiff, c.textSecondary, c.surface2, c.border]);

  const listEmpty = useMemo(() => (
    !chat.loading && !chat.streaming ? (
      <View style={styles.emptyRow}>
        <Text style={[styles.emptyText, { color: c.textSecondary }]}>
          Ask anything
        </Text>
      </View>
    ) : null
  ), [chat.loading, chat.streaming, c.textSecondary]);

  // Oldest first on screen. Real ids ascend with insertion order; the
  // ephemeral optimistic ids (negative, ever-decreasing) are NEWEST-first —
  // sorting them numerically put the just-sent bubble at the very top, so
  // they sink to the bottom instead (newest last), and among themselves
  // they keep newest-last.
  const displayMessages = useMemo(() => {
    const list = [...chat.messages];
    list.sort((a, b) => {
      const aOpt = a.id < 0;
      const bOpt = b.id < 0;
      if (aOpt && bOpt) return b.id - a.id;
      if (aOpt) return 1;
      if (bOpt) return -1;
      return a.id - b.id;
    });
    return list;
  }, [chat.messages]);

  const openArtifact = useCallback((path: string, filename: string) => {
    // Preview straight from a message chip — the same ArtifactSheet the
    // library uses, scoped to this session.
    setSheetArtifacts([{ path, filename, kind: extOf(filename) as 'jsx' | 'tsx' | undefined }]);
    setSheetInitialPath(path);
    setGalleryOpen(true);
  }, []);
  const [sheetArtifacts, setSheetArtifacts] = useState<SessionArtifact[]>([]);
  const [sheetInitialPath, setSheetInitialPath] = useState<string | undefined>(undefined);

  // `/compact` is a client-side command on the desktop, not text for the
  // model — intercept it here (the relay op runs the same summarizer).
  const handleSend = useCallback(
    (text: string, attachments?: SessionChatAttachment[]) => {
      const t = text.trim();
      if (/^\/compact(\s|$)/i.test(t)) {
        chat.compact();
        return;
      }
      chat.send(t, attachments ?? []);
    },
    [chat],
  );

  const renderItem = useCallback(({ item }: { item: SessionMessageRecord }) => {
    const paths = item.artifactPaths ?? [];
    // Turn duration (desktop turn-rail parity): process turns show it INSIDE
    // the collapsed "Worked for Xs" fold header; pure-text turns keep the
    // plain caption below the bubble.
    const workedForSec =
      item.role === 'assistant' && item.startedAt != null && item.completedAt != null
        ? Math.max(1, Math.floor(item.completedAt - item.startedAt))
        : null;
    const hasProcess = /<(think|tool)>/.test(item.content);
    const bubble = (
      <MessageBubble
        role={item.role as 'user' | 'assistant' | 'system'}
        content={item.content}
        onPeekDiff={handlePeekDiff}
        liveImages={item.id < 0 ? item.localAttachments : undefined}
        workedForSec={workedForSec}
      />
    );
    const worked =
      item.role === 'assistant' && !hasProcess && workedForSec != null
        ? formatDuration(workedForSec)
        : null;
    return (
      <TouchableOpacity
        activeOpacity={1}
        onLongPress={() =>
          setActionTarget({ id: item.id, role: item.role, content: item.content })
        }
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel={`Message options: ${item.content.slice(0, 40)}`}
      >
        {bubble}
        {worked ? (
          <Text style={[styles.workedLabel, { color: c.textSecondary }]}>
            Worked for {worked}
          </Text>
        ) : null}
        {paths.length > 0 ? (
          <View style={styles.artifactChips}>
            {paths.map((p) => {
              const name = p.split(/[\/]/).pop() || p;
              return (
                <TouchableOpacity
                  key={p}
                  style={[styles.artifactChip, { backgroundColor: c.surface2, borderColor: c.border }]}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Artifact ${name}`}
                  onPress={() => openArtifact(p, name)}
                >
                  <Ionicons name="document-text-outline" size={12} color={c.accent} />
                  <Text style={[styles.artifactChipText, { color: c.text }]} numberOfLines={1}>
                    {name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}
      </TouchableOpacity>
    );
  }, [openArtifact, handlePeekDiff]);

  // ---- Batch 1: derived sheet contents ----
  const PERMISSION_MODES: { value: string; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { value: 'plan', label: 'Plan', icon: 'map-outline' },
    { value: 'read_only', label: 'Read Only', icon: 'eye-outline' },
    { value: 'manual', label: 'Manual Approval', icon: 'hand-left-outline' },
    { value: 'auto_edit', label: 'Auto-Edit', icon: 'create-outline' },
    { value: 'full_auto', label: 'Full Auto', icon: 'flash-outline' },
  ];
  const currentMode = chat.meta?.permissionMode || 'manual';

  const messageActionItems: ActionSheetItem[] = actionTarget
    ? [
        {
          key: 'copy',
          label: 'Copy',
          icon: 'copy-outline',
          onPress: () => { void Clipboard.setStringAsync(actionTarget.content); },
        },
        ...(actionTarget.role === 'user' && actionTarget.id > 0
          ? [{
              key: 'edit',
              label: 'Edit & resend',
              icon: 'create-outline' as const,
              onPress: () => setEditing({ id: actionTarget.id, text: actionTarget.content }),
            }]
          : []),
        {
          key: 'regenerate',
          label: 'Regenerate response',
          icon: 'refresh-outline',
          onPress: () => {
            const lastUser = [...chat.messages]
              .filter((m) => m.role === 'user' && m.id > 0)
              .sort((a, b) => a.id - b.id)
              .pop();
            chat.regenerate(lastUser?.id);
          },
        },
        ...(actionTarget.id > 0
          ? [{
              key: 'delete',
              label: 'Delete message',
              icon: 'trash-outline' as const,
              destructive: true,
              onPress: () => chat.deleteMessage(actionTarget.id),
            }]
          : []),
      ]
    : [];

  const chatMenuItems: ActionSheetItem[] = [
    {
      key: 'regen',
      label: 'Regenerate last response',
      icon: 'refresh-outline',
      onPress: () => {
        const lastUser = [...chat.messages]
          .filter((m) => m.role === 'user' && m.id > 0)
          .sort((a, b) => a.id - b.id)
          .pop();
        chat.regenerate(lastUser?.id);
      },
    },
    {
      key: 'compact',
      label: 'Compact context',
      icon: 'contract-outline',
      onPress: () => chat.compact(),
    },
    {
      key: 'permission',
      label: `Permission: ${PERMISSION_MODES.find((m) => m.value === currentMode)?.label ?? currentMode}`,
      icon: 'shield-checkmark-outline',
      onPress: () => setPermissionOpen(true),
    },
    {
      key: 'artifacts',
      label: `Artifacts (${chat.artifacts.length})`,
      icon: 'folder-open-outline',
      onPress: () => {
        if (chat.artifacts.length > 0) {
          setSheetArtifacts(chat.artifacts);
          setSheetInitialPath(chat.artifacts[0]?.path);
          setGalleryOpen(true);
        }
      },
    },
    {
      key: 'checkpoints',
      label: 'Turn changes',
      icon: 'arrow-undo-outline',
      onPress: () => { setCheckpointsOpen(true); chat.refreshCheckpoints(); },
    },
    {
      key: 'delete-chat',
      label: 'Delete conversation',
      icon: 'trash-outline',
      destructive: true,
      onPress: () => chat.remove(),
    },
  ];

  const permissionItems: ActionSheetItem[] = PERMISSION_MODES.map((m) => ({
    key: m.value,
    label: m.label,
    icon: m.icon,
    selected: currentMode === m.value,
    onPress: () => chat.setPermissionMode(m.value),
  }));

  const checkpointItems: ActionSheetItem[] = [...chat.checkpoints]
    .reverse()
    .map((cp) => ({
      key: `cp-${cp.id}`,
      label: `${cp.files.length} file${cp.files.length === 1 ? '' : 's'} changed`,
      detail: new Date(cp.created_at * 1000).toLocaleString(),
      icon: 'git-branch-outline' as const,
      onPress: () => {
        // Restore files; long tail option lives in the message menu on
        // desktop — the phone restores files and keeps the conversation.
        chat.restoreCheckpoint(cp.id, false);
        setCheckpointsOpen(false);
      },
    }));

  // --- Deleted: full-screen cleared state ---

  if (!sessionId) {
    return (
      <SafeAreaView style={[styles.container, styles.center, { backgroundColor: c.background }]} edges={['top']}>
        <Text style={{ color: c.textSecondary }}>No session selected.</Text>
      </SafeAreaView>
    );
  }

  if (chat.deleted) {
    return (
      <SafeAreaView style={[styles.container, styles.center, { backgroundColor: c.background }]} edges={['top']}>
        <Text style={[styles.deletedText, { color: c.textSecondary }]}>
          This conversation was cleared
        </Text>
        <TouchableOpacity
          style={[styles.backBtn, { backgroundColor: c.surface2, borderColor: c.border }]}
          onPress={() => navigation.goBack()}
          activeOpacity={0.8}
        >
          <ArrowLeft size={18} color={c.text} />
          <Text style={[styles.backBtnText, { color: c.text }]}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Header */}
        <View style={[styles.header, { backgroundColor: c.background, borderBottomColor: c.border }]}>
          {/* Sidebar (desktop parity: the left rail is always reachable).
              Android back still pops the screen natively. */}
          <TouchableOpacity
            onPress={() => { tapLight(); openSidebar(); }}
            style={styles.headerBtn}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
            accessibilityLabel="Open sidebar"
          >
            <Ionicons name="menu" size={22} color={c.text} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.headerCenter}
            onLongPress={openRename}
            delayLongPress={400}
            activeOpacity={0.8}
            accessibilityLabel="Session title — long-press to rename"
          >
            <Text style={[styles.headerTitle, { color: c.text }]} numberOfLines={1}>
              {title}
            </Text>
            {projectName ? (
              <View style={styles.projectChip}>
                <Ionicons name="folder" size={10} color={c.accent} />
                <Text numberOfLines={1} style={[styles.projectChipText, { color: c.textSecondary }]}>
                  {projectName}
                </Text>
              </View>
            ) : null}
          </TouchableOpacity>

          {/* Model chip → ModelSheet */}
          <TouchableOpacity
            style={[styles.modelChip, { backgroundColor: c.surface2, borderColor: c.border }]}
            onPress={() => {
              setModelSheetOpen(true);
            }}
            activeOpacity={0.7}
            accessibilityLabel={`Model: ${chat.meta?.model ?? 'select'} — open picker`}
          >
            <Text style={[styles.modelChipText, { color: c.text }]} numberOfLines={1}>
              {chat.meta?.model ?? 'Model'}
            </Text>
            <ChevronDown size={13} color={c.textSecondary} />
          </TouchableOpacity>

          {/* Git tool sheet — only when the chat is bound to a project. */}
          {chat.meta?.projectId ? (
            <TouchableOpacity
              style={styles.headerBtn}
              onPress={() => { tapLight(); setGitSheetOpen(true); }}
              hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
              accessibilityLabel="Git tools for this project"
            >
              <Ionicons name="git-branch-outline" size={19} color={c.text} />
            </TouchableOpacity>
          ) : null}

          {/* Terminal (desktop pane parity) + Undo (turn checkpoints) + chat
              overflow menu. The terminal mirrors the session's live pane. */}
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={() => navigation.navigate('Terminal', { sessionId, title })}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
            accessibilityLabel="Open terminal view"
          >
            <Ionicons name="terminal-outline" size={19} color={c.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={() => { setCheckpointsOpen(true); chat.refreshCheckpoints(); }}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
            accessibilityLabel="Turn changes — files and undo"
          >
            <Ionicons name="arrow-undo-outline" size={19} color={c.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={() => setChatMenuOpen(true)}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
            accessibilityLabel="Chat menu"
          >
            <Ionicons name="ellipsis-horizontal" size={19} color={c.text} />
          </TouchableOpacity>
        </View>

        {/* Messages — normal top-down list (oldest first, newest at the
            bottom). The old inverted+scaleY-flip list rendered as scrambled
            glyphs on Android's new architecture. */}
        <FlatList
          ref={listRef}
          data={displayMessages}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.listContent}
          // Variable-height rows (markdown/code blocks) — no getItemLayout;
          // the batching props are the safe subset (PERFORMANCE_AUDIT.md M3).
          initialNumToRender={12}
          maxToRenderPerBatch={5}
          windowSize={7}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          ListEmptyComponent={listEmpty}
          renderItem={renderItem}
          onScroll={handleListScroll}
          scrollEventThrottle={100}
          refreshControl={
            <RefreshControl
              refreshing={chat.loading && chat.messages.length > 0}
              onRefresh={chat.refresh}
              tintColor={c.textSecondary}
              colors={[c.accent]}
            />
          }
        />

        {/* Scroll-to-latest (desktop parity) — fades in once the user is
            away from the bottom, vanishes when they get there. */}
        <Animated.View
          pointerEvents={atBottom ? 'none' : 'auto'}
          style={[styles.scrollDownBtn, { opacity: scrollBtnOpacity, backgroundColor: c.surface2, borderColor: c.border }]}
        >
          <TouchableOpacity
            onPress={scrollToLatest}
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest message"
          >
            <Ionicons name="chevron-down" size={20} color={c.text} />
          </TouchableOpacity>
        </Animated.View>

        {/* Pending approvals — between the list and the composer. */}
        {chat.pendingApprovals.map((a) => (
          <ApprovalCard
            key={a.pendingId}
            approval={{
              pendingId: a.pendingId,
              tool: a.tool,
              summary: a.summary,
              args: a.args,
              canAlwaysAllow: a.canAlwaysAllow,
            }}
            onApprove={(alwaysAllow) => chat.approve(a.pendingId, alwaysAllow)}
            onDeny={() => chat.deny(a.pendingId)}
          />
        ))}

        {/* Live plan proposal — pinned above the composer. */}
        {chat.planProposal ? (
          <PlanCard
            pendingId={chat.planProposal.pendingId}
            title={chat.planProposal.title}
            plan={chat.planProposal.plan}
            onApprove={() => chat.resolvePlan(chat.planProposal!.pendingId, true)}
            onRevise={(feedback) => chat.resolvePlan(chat.planProposal!.pendingId, false, feedback)}
          />
        ) : null}

        {/* Error banner with retry + dismiss. */}
        {chat.error ? (
          <View style={[styles.errorBanner, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <View style={[styles.errorDot, { backgroundColor: c.error }]} />
            <Text style={[styles.errorText, { color: c.error }]} numberOfLines={2}>
              {chat.error}
            </Text>
            <TouchableOpacity
              onPress={() => {
                chat.clearError();
                chat.refresh();
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={[styles.errorAction, { color: c.text }]}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={chat.clearError}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close" size={16} color={c.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Transient status banner ("Compacting…"). */}
        {chat.status ? <StatusBanner message={chat.status} /> : null}

        {/* Last turn's usage — desktop composer-metrics parity. */}
        {chat.lastUsage ? (
          <Text style={[styles.metricsRow, { color: c.textSecondary }]}>
            {`↑${tokens(chat.lastUsage.inputTokens)}  ↓${tokens(chat.lastUsage.outputTokens)}${
              chat.lastUsage.costUsd ? `  ·  $${chat.lastUsage.costUsd.toFixed(4)}` : ''}`}
          </Text>
        ) : null}

        {/* Composer — send while idle, stop while streaming. Send gating
            lives in useSessionChat.send (not-connected error surfaced there). */}
        {/* Queued follow-ups (sent when the running turn ends). Desktop
            queue-row parity: Steer interrupts the running turn with THIS
            message; the close button removes it from the queue. */}
        {chat.queued.length > 0 ? (
          <View style={styles.queueWrap}>
            {chat.queued.map((q, i) => (
              <View
                key={`${i}-${q.slice(0, 12)}`}
                style={[styles.queueChip, { backgroundColor: c.surface2, borderColor: c.border }]}
              >
                <Ionicons name="time-outline" size={12} color={c.textSecondary} />
                <Text style={[styles.queueText, { color: c.textSecondary }]} numberOfLines={1}>
                  Queued: {q}
                </Text>
                <TouchableOpacity
                  onPress={() => chat.steerQueued(q)}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Send now, interrupting the current turn: ${q.slice(0, 30)}`}
                >
                  <Ionicons name="flash-outline" size={14} color={c.accent} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => chat.cancelQueued(q)}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove queued message: ${q.slice(0, 30)}`}
                >
                  <Ionicons name="close-circle" size={14} color={c.textSecondary} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : null}

        {/* A harness question parks the turn until answered (desktop
            QuestionCard parity) — the phone must be able to unblock it. */}
        {chat.questionRequest ? (
          <QuestionCard
            pendingId={chat.questionRequest.pendingId}
            questions={chat.questionRequest.questions}
            onAnswer={chat.answerQuestion}
          />
        ) : null}

        {/* Bottom clearance: the SafeAreaView above only claims the TOP edge,
            so the composer sat against the gesture bar (measured 26px to the
            screen edge). Reserve the real inset plus breathing room. */}
        <View style={{ paddingBottom: Math.max(insets.bottom, 12) + 14 }}>
          <ChatComposer
            connectors={{ list: connectorList, attached: attachedConnectors, onToggle: toggleConnector }}
            onSend={handleSend}
            onTranscribe={transcribeAudio}
            onCancel={chat.cancel}
            streaming={chat.streaming}
            disabled={!connected}
            placeholder={connected ? 'Message' : 'Not connected to desktop'}
          />
        </View>

        {/* Rename modal (long-press the header title). */}
        <Modal
          visible={renameOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setRenameOpen(false)}
        >
          <View style={styles.modalBackdrop}>
            <View style={[styles.modalCard, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.modalTitle, { color: c.text }]}>Rename chat</Text>
              <TextInput
                value={renameValue}
                onChangeText={setRenameValue}
                placeholder="Title"
                placeholderTextColor={c.textSecondary}
                style={[styles.modalInput, { color: c.text, borderColor: c.border, backgroundColor: c.surface2 }]}
                autoFocus
                onSubmitEditing={handleRename}
              />
              <View style={styles.modalActions}>
                <TouchableOpacity onPress={() => setRenameOpen(false)} style={styles.modalBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={{ color: c.textSecondary }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleRename} style={styles.modalBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={{ color: c.accent, fontWeight: '600' }}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Message actions (long-press) — desktop MessageBubble menu. */}
        <ActionSheet
          visible={actionTarget != null}
          title={actionTarget ? `Message #${actionTarget.id} (${actionTarget.role})` : undefined}
          items={messageActionItems}
          onClose={() => setActionTarget(null)}
        />

        {/* Chat overflow menu. */}
        <ActionSheet
          visible={chatMenuOpen}
          title="Conversation"
          items={chatMenuItems}
          onClose={() => setChatMenuOpen(false)}
        />

        {/* Permission posture. */}
        <ActionSheet
          visible={permissionOpen}
          title="Permission mode"
          items={permissionItems}
          onClose={() => setPermissionOpen(false)}
        />

        {/* Turn checkpoints (Undo). */}
        <ActionSheet
          visible={checkpointsOpen}
          title="Turn changes · undo"
          items={checkpointItems.length > 0 ? checkpointItems : [{
            key: 'none',
            label: 'No checkpoints yet',
            icon: 'information-circle-outline',
            disabled: true,
            onPress: () => {},
          }]}
          onClose={() => setCheckpointsOpen(false)}
        />

        {/* In-chat artifact gallery (message chip / chat menu entry). */}
        <ArtifactSheet
          visible={galleryOpen}
          onClose={() => setGalleryOpen(false)}
          artifacts={sheetArtifacts}
          sessionId={sessionId}
          initialPath={sheetInitialPath}
        />

        {/* Diff peek — git diff for a file-edit activity row (needs a bound
            project; the Diff button is hidden without one). */}
        <DiffSheet
          visible={diffPath != null}
          path={diffPath}
          projectId={chat.meta?.projectId ?? null}
          onClose={() => setDiffPath(null)}
        />

        {/* Chat git tool sheet — status / changes / commit / push / branches /
            log for the bound project; changed files open the DiffSheet. */}
        <ChatGitSheet
          visible={gitSheetOpen}
          projectId={chat.meta?.projectId ?? null}
          projectName={projectName}
          onPeekFile={(path) => setDiffPath(path)}
          onClose={() => setGitSheetOpen(false)}
        />

        {/* Edit & resend (edit-to-fork). */}
        <Modal visible={editing != null} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
          <View style={[styles.modalScrim, { backgroundColor: c.scrim }]}>
            <View style={[styles.editCard, { backgroundColor: c.elevated, borderColor: c.border }]}>
              <Text style={[styles.editTitle, { color: c.text }]}>Edit message</Text>
              <TextInput
                style={[styles.editInput, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
                multiline
                value={editing?.text ?? ''}
                onChangeText={(t) => setEditing((e) => (e ? { ...e, text: t } : e))}
                autoFocus
              />
              <View style={styles.editActions}>
                <TouchableOpacity
                  onPress={() => setEditing(null)}
                  style={[styles.editBtn, { backgroundColor: c.surface2 }]}
                  accessibilityLabel="Cancel edit"
                >
                  <Text style={[styles.editBtnText, { color: c.text }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    if (editing) chat.editMessage(editing.id, editing.text);
                    setEditing(null);
                  }}
                  style={[styles.editBtn, { backgroundColor: c.accent }]}
                  accessibilityLabel="Save and resend"
                >
                  <Text style={[styles.editBtnText, { color: c.white }]}>Save & resend</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Model picker popover (desktop AgentModelPicker parity). */}
        <ModelSheet
          visible={modelSheetOpen}
          onClose={() => setModelSheetOpen(false)}
          providers={providers}
          harnesses={harnesses}
        acpAgents={acpAgents}
          currentProvider={chat.meta?.provider ?? null}
          currentModel={chat.meta?.model ?? null}
          effort={chat.meta?.effort ?? ''}
          onEffortChange={chat.setEffort}
          onSelect={chat.setModel}
          onStartLocal={startLocalModel}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  headerBtn: { padding: 6 },
  headerCenter: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 4,
  },
  headerTitle: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '600',
    textAlign: 'center',
  },
  queueWrap: { flexDirection: 'row', gap: 6, paddingHorizontal: themeMod.spacing.md, paddingBottom: 6 },
  queueChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: themeMod.radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  queueText: { flex: 1, fontSize: 11 },
  artifactChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: themeMod.spacing.md,
    paddingBottom: 6,
  },
  artifactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 220,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: themeMod.radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  artifactChipText: { fontSize: 11 },
  modalScrim: { flex: 1, justifyContent: 'center', padding: 20 },
  editCard: {
    borderRadius: themeMod.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: themeMod.spacing.lg,
    gap: themeMod.spacing.md,
  },
  editTitle: { ...themeMod.type.title, fontSize: 16 },
  editInput: {
    minHeight: 120,
    maxHeight: 260,
    borderRadius: themeMod.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  editBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: themeMod.radius.pill,
  },
  editBtnText: { fontSize: 14, fontWeight: '600' },
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: themeMod.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 150,
  },
  modelChipText: {
    fontSize: 12,
    lineHeight: 16,
    flexShrink: 1,
  },
  listContent: {
    paddingTop: 8,
    paddingBottom: 12,
  },
  loadingRow: { padding: 24, alignItems: 'center' },
  emptyRow: { paddingVertical: 48, alignItems: 'center' },
  emptyText: { fontSize: 15 },
  loadMoreBtn: {
    margin: 16,
    paddingVertical: 10,
    borderRadius: themeMod.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  loadMoreText: { fontSize: 13, fontWeight: '500' },
  metricsRow: {
    fontSize: 10,
    fontFamily: 'monospace',
    textAlign: 'center',
    letterSpacing: 0.4,
    paddingBottom: 2,
  },
  projectChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    alignSelf: 'center', marginTop: 2, maxWidth: '100%',
  },
  projectChipText: { fontSize: 10 },
  scrollDownBtn: {
    position: 'absolute',
    right: 16,
    bottom: 110,
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    zIndex: 20,
  },
  workingLabel: { fontSize: 11, marginBottom: 4, paddingLeft: 2 },
  workedLabel: { fontSize: 11, marginTop: 4, paddingLeft: 2 },
  streamTail: { paddingTop: 6 },
    errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: themeMod.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: themeMod.spacing.md,
    marginTop: 4,
  },
  errorDot: { width: 7, height: 7, borderRadius: 4 },
  errorText: {
    ...themeMod.type.secondary,
    flex: 1,
  },
  errorAction: {
    ...themeMod.type.secondary,
    fontWeight: '600',
  },
  deletedText: {
    fontSize: 16,
    marginBottom: 16,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: themeMod.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  backBtnText: { fontSize: 14, fontWeight: '600' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: themeMod.colors.scrim,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: themeMod.radius.md,
    padding: 16,
  },
  modalTitle: { fontSize: 15, fontWeight: '600', marginBottom: 12 },
  modalInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: themeMod.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12, gap: 12 },
  modalBtn: { paddingHorizontal: 12, paddingVertical: 6 },
});
