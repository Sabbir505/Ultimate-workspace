import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import {
  Alert, Animated, BackHandler, Easing, Modal, Pressable,
  FlatList, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. This wrapper preserves the lucide call-site's (size, color) props.
const PencilSquare = ({ size, color }: { size?: number; color?: string }) =>
  <Ionicons name="create-outline" size={size} color={color} />;
import { getRelayUrl, onSearchResults, onSessionCreated, useRelay, type ChatSearchHit, type Session } from '../hooks/useRelay';
import { useProjects } from '../hooks/useProjects';
import { theme, useTheme } from '../theme';
import { timeAgo } from '../lib/format';
import { openChatById } from '../lib/navigation';
import ConnectionIndicator from './ConnectionIndicator';
import { tapLight, tapMedium } from '../lib/haptics';
import { beginScreenTiming } from '../lib/screenTiming';
import DomainErrorBar from './DomainErrorBar';
import ProjectManager from './ProjectManager';

// ---------------------------------------------------------------------------
// Drawer context — the provider wraps the whole app so ANY screen can call
// useDrawer().open(); the overlay itself renders above the navigator (it is
// mounted as a sibling of the Tab.Navigator inside the NavigationContainer).
// ---------------------------------------------------------------------------

/** Actions only — a STABLE object. Screens that merely open the drawer
 *  (HomeScreen) consume this, so opening/closing it never re-renders them.
 *
 *  Why the split: the provider wraps the whole app, so every state change
 *  used to re-render every useDrawer() consumer. Tapping a drawer row fires
 *  open/close state updates in the same batch as the navigation, which meant
 *  the screen being left behind re-rendered at the exact moment the next one
 *  mounted — two screens' worth of work inside one navigation frame.
 */
export interface DrawerActions {
  open: () => void;
  close: () => void;
  closeNow: () => void;
  openNewChat: () => void;
  closeNewChat: () => void;
  /** @internal — <AppDrawer> registers the real implementation. */
  register: (impl: DrawerImpl | null) => void;
}

/** The real drawer behaviour, implemented by <AppDrawer>. */
export interface DrawerImpl {
  open: () => void;
  close: () => void;
  closeNow: () => void;
  openNewChat: () => void;
  closeNewChat: () => void;
}

const DrawerActionsContext = createContext<DrawerActions>({
  open: () => {},
  close: () => {},
  closeNow: () => {},
  openNewChat: () => {},
  closeNewChat: () => {},
  register: () => {},
});

export function DrawerProvider({ children }: { children: ReactNode }) {
  // The provider holds ONLY stable callbacks; all drawer state lives inside
  // <AppDrawer>, which renders as a sibling of the navigator. Opening or
  // closing the drawer therefore re-renders exactly one component instead of
  // every useDrawerActions() consumer in the tree — and, critically, closing
  // it to navigate no longer puts a state update in the same React batch as
  // the navigation itself.
  //
  // <AppDrawer> registers its real implementation here; until it mounts the
  // callbacks are harmless no-ops.
  const impl = useRef<DrawerImpl | null>(null);
  const call = useCallback((k: keyof DrawerImpl) => () => impl.current?.[k](), []);

  const api = useMemo<DrawerActions>(() => ({
    open: call('open'),
    close: call('close'),
    closeNow: call('closeNow'),
    openNewChat: call('openNewChat'),
    closeNewChat: call('closeNewChat'),
    register: (i: DrawerImpl | null) => { impl.current = i; },
  }), [call]);

  return <DrawerActionsContext.Provider value={api}>{children}</DrawerActionsContext.Provider>;
}

/** Drawer actions — stable for the app's lifetime, so consuming this never
 *  re-renders the consumer. */
export function useDrawerActions(): DrawerActions {
  return useContext(DrawerActionsContext);
}

/** @deprecated use useDrawerActions() — same stable object. */
export const useDrawer = useDrawerActions;

// ---------------------------------------------------------------------------
// Shared helpers (also used by HomeScreen's quick-start rows)
// ---------------------------------------------------------------------------

/** Agent (harness) choices for new sessions — labels for the picker chips. */
export const HARNESS_OPTIONS: { label: string; value: string }[] = [
  { label: 'Claude', value: 'claude_code' },
  { label: 'Kimi', value: 'kimi_code' },
  { label: 'OpenCode', value: 'opencode' },
];

export function harnessLabel(value: string): string {
  return HARNESS_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export interface ProjectSummary { id: string; name: string; provider: string; }

/** Unique projects seen in the session list, newest activity first.
 *  Project-less chats (the desktop default) are skipped — synthesizing an
 *  'unknown' project here once filled the picker with a fake row. */
export function collectProjects(sessions: Session[]): ProjectSummary[] {
  const byKey = new Map<string, { id: string; name: string; provider: string; last: number }>();
  for (const s of sessions) {
    if (!s.projectId && !s.projectName) continue;
    const key = s.projectId || s.projectName;
    const prev = byKey.get(key);
    if (!prev || s.lastActivity > prev.last) {
      byKey.set(key, {
        id: s.projectId || s.projectName || '',
        name: s.projectName || s.projectId || 'Untitled project',
        provider: s.provider || 'claude_code',
        last: s.lastActivity,
      });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.last - a.last)
    .map(({ id, name, provider }) => ({ id, name, provider }));
}

function statusDotColor(status: Session['status']): string {
  const c = theme.colors;
  return status === 'working' ? c.success
    : status === 'waiting' ? c.warning
    : status === 'diff_ready' ? c.accent
    : c.gray;
}

type TimeBucket = 'Today' | 'Yesterday' | 'This week' | 'Earlier';
const BUCKETS: TimeBucket[] = ['Today', 'Yesterday', 'This week', 'Earlier'];

function bucketSessions(sessions: Session[]): { label: TimeBucket; items: Session[] }[] {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const bounds = [dayStart, dayStart - 86_400_000, dayStart - 6 * 86_400_000];
  // Starred pins first inside each bucket (desktop sidebar: starred DESC,
  // then most recent).
  const sorted = [...sessions].sort((a, b) =>
    (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.lastActivity - a.lastActivity);
  const groups = BUCKETS.map((label) => ({ label, items: [] as Session[] }));
  for (const s of sorted) {
    const idx = s.lastActivity >= bounds[0] ? 0
      : s.lastActivity >= bounds[1] ? 1
      : s.lastActivity >= bounds[2] ? 2
      : 3;
    groups[idx].items.push(s);
  }
  return groups.filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------------------
// Create-session flow — fire CreateSession over the relay WS, listen for the
// matching SessionCreated event (one-shot), nudge a spawn, and open the chat.
// A 15s timeout keeps a silent desktop from leaving a dangling listener.
// ---------------------------------------------------------------------------

export function useCreateSessionFlow() {
  const { createSession, spawnSession } = useRelay();
  const navigation = useNavigation<any>();
  const unsubRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  useEffect(() => clear, [clear]);

  return useCallback((
    projectId: string,
    harness: string,
    firstMessage?: string,
    provider?: string,
    model?: string,
    firstAttachments?: { name: string; kind: 'text' | 'image' | 'doc'; text?: string; data?: string; media_type?: string; format?: string }[],
    effort?: string,
    connectors?: string[],
  ) => {
    clear();
    // createSession returns false when the socket isn't OPEN — surface that
    // instead of waiting the full 15s for an event that can never arrive.
    if (!createSession(projectId, harness, provider, model, effort, connectors)) {
      Alert.alert(
        "Can't reach your desktop",
        'Check that Relay is running and your phone is connected, then try again.',
      );
      return;
    }
    unsubRef.current = onSessionCreated.on((s) => {
      if (s.projectId !== projectId || s.provider !== harness) return;
      clear();
      // The desktop auto-spawns on create; nudge again in case that event was
      // missed, then open live so the chat polls instead of showing "idle".
      spawnSession(s.id);
      navigation.navigate('SessionDetail', {
        session: { ...s, isLive: true },
        sessionId: s.id,
        // The chat screen sends this through the normal composer path once
        // mounted (optimistic bubble + stream — not a blind frame).
        firstMessage: firstMessage?.trim() || undefined,
        firstAttachments: firstAttachments && firstAttachments.length > 0 ? firstAttachments : undefined,
      });
    });
    timerRef.current = setTimeout(() => {
      clear();
      Alert.alert(
        'No response from desktop',
        "The session wasn't created. Make sure your desktop is online and try again.",
      );
    }, 15_000);
  }, [createSession, spawnSession, navigation, clear]);
}

// ---------------------------------------------------------------------------
// New chat picker — inline modal sheet: project list + agent chips + start.
// ---------------------------------------------------------------------------

function NewChatModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { sessions, connected, harnesses } = useRelay();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  useTheme();
  const c = theme.colors;
  const start = useCreateSessionFlow();
  // Real project list from the desktop (ListProjects) — the session-derived
  // list missed projects that have no chats yet. Session-derived entries
  // still fill in the default agent per project. The listProjects send +
  // ProjectList/Upserted/Removed merge live in the shared useProjects hook
  // (same subscription ProjectManager uses).
  const serverProjects = useProjects(visible);

  const projects = useMemo(() => {
    const fromSessions = collectProjects(sessions);
    const rows = serverProjects.map((p) => ({
      id: p.id,
      name: p.name,
      provider: fromSessions.find((s) => s.id === p.id)?.provider ?? '',
    }));
    for (const s of fromSessions) {
      if (!rows.some((r) => r.id === s.id)) rows.push(s);
    }
    return rows;
  }, [sessions, serverProjects]);
  const [manageOpen, setManageOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [harness, setHarness] = useState('claude_code');

  // The project list arrives asynchronously; if the sheet is already open,
  // nothing was selected and Start created a project-less chat.
  React.useEffect(() => {
    if (!visible || projectId != null || projects.length === 0) return;
    setProjectId(projects[0].id);
    if (projects[0].provider) setHarness(projects[0].provider);
  }, [visible, projectId, projects]);

  // Agent chips mirror the desktop's agent picker: the harness list the
  // desktop advertises (installed state included). Static fallback for a
  // desktop that hasn't sent the list yet.
  const agentOptions = useMemo(
    () => (harnesses.length > 0
      ? harnesses.map((h) => ({ label: h.display_name, value: h.id, installed: h.installed }))
      : HARNESS_OPTIONS.map((o) => ({ ...o, installed: true }))),
    [harnesses],
  );

  // Fresh selection every time the sheet opens.
  useEffect(() => {
    if (visible) {
      setProjectId(projects[0]?.id ?? null);
      setHarness(projects[0]?.provider ?? 'claude_code');
    }
    // `projects` is derived from sessions; re-seeding on every list refresh
    // would clobber the user's mid-flow selection, so only key on `visible`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const canStart = connected;

  const handleStart = () => {
    if (!connected) return;
    onClose();
    // Land on the chat home while the desktop creates the session (the
    // SessionCreated listener in `start` opens the chat itself). No project
    // picked → project-less chat, bindable on the desktop later.
    navigation.navigate('HomeMain');
    start(projectId ?? '', harness);
  };

  return (
    <>
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalScrim, { backgroundColor: c.scrim }]}>
        <Pressable
          style={styles.modalScrimTap}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close new chat"
        />
        <View
          style={[styles.sheet, { backgroundColor: c.background, paddingBottom: insets.bottom + theme.spacing.lg }]}
        >
          <View style={[styles.sheetHandle, { backgroundColor: c.border }]} />
          <Text style={[styles.sheetTitle, { color: c.text }, theme.type.title]}>New chat</Text>
          <Text style={[styles.sheetSubtitle, { color: c.textSecondary }, theme.type.secondary]}>
            Pick a project and an agent to start with.
          </Text>

          {projects.length === 0 && (
            <Text style={[styles.sheetEmpty, { color: c.textSecondary }, theme.type.secondary]}>
              No project picked — the chat starts project-less; bind one on the desktop anytime.
            </Text>
          )}
          {projects.length > 0 && (
            <ScrollView style={styles.projectList}>
                {projects.map((p) => {
                  const selected = p.id === projectId;
                  return (
                    <TouchableOpacity
                      key={p.id || p.name}
                      style={[
                        styles.projectRow,
                        { borderColor: selected ? c.accent : c.border },
                        selected && { backgroundColor: c.surface2 },
                      ]}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityState={selected ? { selected: true } : {}}
                      accessibilityLabel={`Project ${p.name}`}
                      onPress={() => { tapLight(); setProjectId(p.id); setHarness(p.provider); }}
                    >
                      <View style={[styles.projectIcon, { backgroundColor: c.bubble }]}>
                        <Ionicons name="folder-outline" size={16} color={c.accent} />
                      </View>
                      <View style={styles.projectText}>
                        <Text
                          numberOfLines={1}
                          style={[styles.projectName, { color: c.text }, theme.type.body]}
                        >
                          {p.name}
                        </Text>
                        <Text
                          numberOfLines={1}
                          style={[{ color: c.textSecondary }, theme.type.secondary]}
                        >
                          Continue with {harnessLabel(p.provider)}
                        </Text>
                      </View>
                      {selected && <Ionicons name="checkmark" size={18} color={c.accent} />}
                    </TouchableOpacity>
                  );
                })}
          </ScrollView>
          )}
              <TouchableOpacity
                style={styles.manageRow}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Manage projects"
                onPress={() => { tapLight(); setManageOpen(true); }}
              >
                <Ionicons name="options-outline" size={15} color={c.textSecondary} />
                <Text style={[{ color: c.textSecondary }, theme.type.secondary]}>
                  Manage projects
                </Text>
              </TouchableOpacity>

              <Text style={[styles.sheetLabel, { color: c.textSecondary }, theme.type.label]}>AGENT</Text>
              <View style={styles.chipRow}>
                {agentOptions.map((opt) => {
                  const selected = harness === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[
                        styles.chip,
                        {
                          borderColor: selected ? c.accent : c.border,
                          backgroundColor: selected ? c.accent : 'transparent',
                        },
                      ]}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityState={selected ? { selected: true } : {}}
                      accessibilityLabel={`Agent ${opt.label}`}
                      onPress={() => { tapLight(); setHarness(opt.value); }}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          theme.type.label,
                          { color: selected ? c.white : c.textSecondary },
                          !opt.installed && !selected ? { opacity: 0.55 } : null,
                        ]}
                      >
                        {opt.label}{opt.installed ? '' : ' ·'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {!connected && (
                <Text style={[styles.sheetOffline, { color: c.textSecondary }, theme.type.secondary]}>
                  Connect to your desktop to start a chat.
                </Text>
              )}
              <TouchableOpacity
                style={[
                  styles.startButton,
                  { backgroundColor: c.accent, opacity: canStart ? 1 : 0.4 },
                ]}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Start chat"
                accessibilityState={canStart ? {} : { disabled: true }}
                disabled={!canStart}
                onPress={handleStart}
              >
                <PencilSquare size={18} color={c.white} />
                <Text style={[styles.startButtonText, theme.type.body, { color: c.white }]}>
                  Start chat
                </Text>
              </TouchableOpacity>
        </View>
      </View>
    </Modal>
      <ProjectManager visible={manageOpen} onClose={() => setManageOpen(false)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// The drawer overlay. Render ONCE inside the NavigationContainer, as a
// sibling AFTER the navigator so it stacks above every screen.
// ---------------------------------------------------------------------------

export default function AppDrawer() {
  const { close, closeNow, openNewChat, closeNewChat, register } = useDrawer();
  // Drawer state lives HERE, not in the provider: the overlay is a sibling of
  // the navigator, so its state changes re-render only this component.
  const [isOpen, setIsOpen] = React.useState(false);
  const [newChatOpen, setNewChatOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  const { sessions, connected, deleteSession, spawnSession, setSessionStarred, searchChatMessages } = useRelay();
  // Full-text message search (desktop command-palette parity). The title
  // filter below still runs; this adds the message-body hits the desktop
  // palette finds through SQLite FTS.
  const [hits, setHits] = React.useState<ChatSearchHit[]>([]);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    const off = onSearchResults.on(({ results }) => setHits(results));
    return off;
  }, []);
  const onSearchChange = React.useCallback((text: string) => {
    setQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (text.trim().length < 2) {
      setHits([]);
      return;
    }
    searchTimer.current = setTimeout(() => searchChatMessages(text.trim(), 30), 300);
  }, [searchChatMessages]);
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  useTheme(); // subscribe so theme.colors is reactive
  const c = theme.colors;

  const panelWidth = Math.min(Math.round(winWidth * 0.82), 380);
  const progress = useRef(new Animated.Value(0)).current;

  // `mounted` comes from the provider so a closeNow() teardown lands in the
  // SAME commit as the navigation. A plain close() still slides, and the
  // panel stays up until the animation settles.
  // No slide for taps that immediately push a full screen: the destination
  // covers the panel anyway, and a JS-driven 250ms close would compete with
  // the incoming screen's render.
  const snapRef = React.useRef(false);
  React.useEffect(() => {
    register({
      open: () => { tapMedium(); snapRef.current = false; setMounted(true); setIsOpen(true); },
      close: () => { tapLight(); setIsOpen(false); },
      closeNow: () => { tapLight(); snapRef.current = true; setIsOpen(false); setMounted(false); },
      openNewChat: () => { setIsOpen(false); setNewChatOpen(true); },
      closeNewChat: () => { setNewChatOpen(false); },
    });
    return () => register(null);
  }, [register]);

  React.useEffect(() => {
    if (snapRef.current) {
      snapRef.current = false;
      progress.setValue(0);
      return;
    }
    Animated.timing(progress, {
      toValue: isOpen ? 1 : 0,
      duration: 250,
      easing: isOpen ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !isOpen) setMounted(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, progress]);

  // Android hardware back closes the drawer instead of leaving the app/screen.
  useEffect(() => {
    if (!isOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [isOpen, close]);

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visibleSessions = useMemo(
    () => (q
      ? sessions.filter((s) =>
          (s.title || '').toLowerCase().includes(q) ||
          (s.projectName || '').toLowerCase().includes(q))
      : sessions),
    [sessions, q],
  );
  const groups = useMemo(() => bucketSessions(visibleSessions), [visibleSessions]);
  // One flat row stream (headers interleaved with sessions) so FlatList can
  // virtualize it. Rendering every session inside a plain ScrollView mounted
  // all ~200 rows on each drawer open — a 250ms+ main-thread block that made
  // every subsequent navigation feel slow, since the tap that opens a screen
  // always pays for the drawer it came from.
  type HistoryRow =
    | { kind: 'header'; key: string; label: TimeBucket }
    | { kind: 'session'; key: string; session: Session };
  const historyRows = useMemo<HistoryRow[]>(() => {
    const out: HistoryRow[] = [];
    for (const g of groups) {
      out.push({ kind: 'header', key: `h:${g.label}`, label: g.label });
      for (const s of g.items) out.push({ kind: 'session', key: s.id, session: s });
    }
    return out;
  }, [groups]);

  const confirmClear = useCallback((session: Session) => {
    Alert.alert(
      session.title || 'Untitled',
      undefined,
      [
        {
          text: session.starred ? 'Unstar' : 'Star',
          onPress: () => setSessionStarred(session.id, !session.starred),
        },
        { text: 'Clear conversation', style: 'destructive', onPress: () => deleteSession(session.id) },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [deleteSession, setSessionStarred]);

  const openSession = useCallback((s: Session) => {
    close();
    if (s.isLive) {
      navigation.navigate('SessionDetail', { session: s, sessionId: s.id });
    } else {
      // Inactive session — spawn it on the desktop first so the chat opens
      // in live mode instead of showing "session is not running".
      spawnSession(s.id);
      navigation.navigate('SessionDetail', { session: { ...s, isLive: true }, sessionId: s.id });
    }
  }, [close, navigation, spawnSession]);

  const goToSettings = useCallback(() => {
    beginScreenTiming();
    closeNow();
    navigation.navigate('Settings');
  }, [close, navigation]);

  // Once the close animation is DONE, drop the panel's entire subtree. It
  // only needs to survive the 250ms slide; keeping the session list mounted
  // behind the screen the user just navigated to meant two full trees
  // rendering at once, which showed up as ~150ms of extra paint latency on
  // every push.
  if (!mounted)
    return (
      <>
        <NewChatModal visible={newChatOpen} onClose={closeNewChat} />
      </>
    );

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-panelWidth - 24, 0] });
  const scrimOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  // Never render the pairing token fragment on screen.
  const rawUrl = getRelayUrl();
  const host = rawUrl ? rawUrl.split('#')[0] : 'Not paired — add your desktop';

  return (
    <>
      <Animated.View
        pointerEvents={isOpen ? 'auto' : 'none'}
        style={[styles.scrim, { opacity: scrimOpacity }]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        >
          <View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} />
        </Pressable>
      </Animated.View>

      {/* pointerEvents follows `isOpen`, NOT `mounted`: the panel stays
          mounted through its 250ms close animation, and without this the
          sliding-out drawer kept intercepting every touch on the screen the
          user just navigated to — a dead zone over 80% of the width. */}
      <Animated.View
        pointerEvents={isOpen ? 'auto' : 'none'}
        style={[
          styles.panel,
          {
            width: panelWidth,
            backgroundColor: c.background,
            paddingTop: insets.top + theme.spacing.md,
            paddingBottom: Math.max(insets.bottom, theme.spacing.md),
            transform: [{ translateX }],
          },
        ]}
      >
        {/* Header: app name + connection state */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: c.text }, theme.type.title]}>Relay</Text>
          <ConnectionIndicator size={8} showLabel />
        </View>
        <DomainErrorBar domains={['sessions', 'search', 'acp-agents']} />

        {/* New chat */}
        <TouchableOpacity
          style={[styles.newChatRow, { backgroundColor: c.surface2 }]}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={() => { tapMedium(); openNewChat(); }}
        >
          <View style={[styles.newChatIcon, { backgroundColor: c.bubble }]}>
            <PencilSquare size={16} color={c.accent} />
          </View>
          <Text style={[styles.newChatLabel, { color: c.text }, theme.type.body]}>New chat</Text>
        </TouchableOpacity>

        {/* Search */}
        <View style={[styles.searchField, { backgroundColor: c.surface2, borderColor: c.border }]}>
          <Ionicons name="search" size={16} color={c.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: c.text }, theme.type.body]}
            value={query}
            onChangeText={onSearchChange}
            placeholder="Search chats and messages"
            placeholderTextColor={c.textSecondary}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query.length > 0 && (
            <TouchableOpacity
              // Route through onSearchChange, not setQuery('') — the handler
              // also clears the debounced hit list and the pending timer.
              onPress={() => onSearchChange('')}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Ionicons name="close-circle" size={16} color={c.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {/* Message-body hits (full-text) — desktop command-palette parity. */}
        {hits.length > 0 && (
          <View style={styles.group}>
            <Text style={[styles.groupLabel, { color: c.textSecondary }, theme.type.label]}>
              In messages
            </Text>
            {hits.map((h) => (
              <TouchableOpacity
                key={`${h.chat_session_id}-${h.message_id ?? h.created_at}`}
                style={[styles.historyRow, { backgroundColor: c.surface2 }]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Message result: ${(h.snippet || h.session_title || 'result').slice(0, 40)}`}
                onPress={() => {
                  tapLight();
                  const sid = h.chat_session_id;
                  if (!sid) return;
                  setHits([]);
                  setQuery('');
                  close();
                  // The hit's chat is INACTIVE on the desktop — spawn it so
                  // the chat opens live and follow-up sends land.
                  openChatById(navigation, spawnSession, sid, {
                    title: h.session_title || 'Chat',
                    lastActivity: h.created_at * 1000,
                  });
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: c.text }, theme.type.body]} numberOfLines={1}>
                    {h.session_title || 'Chat'}
                  </Text>
                  <Text style={[{ color: c.textSecondary }, theme.type.secondary]} numberOfLines={2}>
                    {h.snippet || ''}
                  </Text>
                </View>
                {h.role ? (
                  <Text style={[{ color: c.textSecondary }, theme.type.label]}>
                    {h.role.slice(0, 1).toUpperCase()}
                  </Text>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* History grouped by time — virtualized: a nested ScrollView here
            would defeat the FlatList's windowing and reintroduce the
            mount-everything cost this replaced. */}
        <FlatList
            data={historyRows}
            keyExtractor={(r) => r.key}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={14}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews
            style={styles.history}
            ListEmptyComponent={
              <View style={styles.historyEmpty}>
                <Text style={[{ color: c.textSecondary }, theme.type.body]}>
                  {sessions.length === 0 ? 'No chats yet' : 'No matching chats'}
                </Text>
                <Text style={[styles.historyEmptySub, { color: c.textSecondary }, theme.type.secondary]}>
                  {sessions.length === 0
                    ? 'Start a session on your desktop, or tap New chat.'
                    : 'Try a different search.'}
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              if (item.kind === 'header') {
                return (
                  <View style={styles.group}>
                    <Text style={[styles.groupLabel, { color: c.textSecondary }, theme.type.label]}>
                      {item.label}
                    </Text>
                  </View>
                );
              }
              const s = item.session;
              return (
                <TouchableOpacity
                  style={styles.historyRow}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={`Open chat: ${s.title || 'Untitled'}`}
                  // close() (via openSession) already fires the tap haptic.
                  onPress={() => openSession(s)}
                  onLongPress={() => confirmClear(s)}
                >
                  <View style={[styles.statusDot, { backgroundColor: statusDotColor(s.status) }]} />
                  <View style={styles.historyText}>
                    <View style={styles.historyTitleRow}>
                      {s.starred && (
                        <Ionicons name="star" size={11} color={c.accent} />
                      )}
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.historyTitle,
                          { color: c.text },
                          theme.type.body,
                          s.unread && styles.historyTitleUnread,
                        ]}
                      >
                        {s.title || 'Untitled'}
                      </Text>
                      {s.unread && <View style={[styles.unreadDot, { backgroundColor: c.accent }]} />}
                    </View>
                    <View style={styles.historyMeta}>
                      <Text
                        numberOfLines={1}
                        style={[styles.historyProject, { color: c.textSecondary }, theme.type.secondary]}
                      >
                        {s.projectName || s.provider}
                      </Text>
                      <Text style={[{ color: c.textSecondary }, theme.type.secondary]}>
                        {' · '}{timeAgo(s.lastActivity)}
                      </Text>
                    </View>
                  </View>
                </TouchableOpacity>
              );
          }}
        />

        {/* Footer: the drawer is for navigation, not a settings index.
            Automations / Notifications / Memory / Skills / Git moved into
            Settings, where they sit next to the rest of the app's controls
            instead of crowding the primary navigation. */}
        <View style={[styles.footer, { borderTopColor: c.border }]}>
          <TouchableOpacity
            style={styles.footerRow}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="Artifacts"
            onPress={() => { beginScreenTiming(); closeNow(); navigation.navigate('Artifacts'); }}
          >
            <Ionicons name="folder-open-outline" size={18} color={c.textSecondary} />
            <Text style={[styles.footerLabel, { color: c.text }, theme.type.body]}>Artifacts</Text>
            <Ionicons name="chevron-forward" size={16} color={c.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.footerRow}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={goToSettings}
          >
            <Ionicons name="settings-outline" size={18} color={c.textSecondary} />
            <Text style={[styles.footerLabel, { color: c.text }, theme.type.body]}>Settings</Text>
            <Ionicons name="chevron-forward" size={16} color={c.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.footerRow}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={`Connection: ${connected ? 'connected' : 'offline'}`}
            onPress={goToSettings}
          >
            <ConnectionIndicator size={8} />
            <View style={styles.footerConnText}>
              <Text style={[{ color: c.text }, theme.type.body]}>
                {connected ? 'Connected' : 'Offline'}
              </Text>
              <Text numberOfLines={1} style={[{ color: c.textSecondary }, theme.type.secondary]}>
                {host}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={c.textSecondary} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <NewChatModal visible={newChatOpen} onClose={closeNewChat} />
    </>
  );
}

const styles = StyleSheet.create({
  // overlay
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderTopRightRadius: theme.radius.sheet,
    borderBottomRightRadius: theme.radius.sheet,
    // soft depth so the panel reads as above the screen
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 16,
  },
  // header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.md,
  },
  headerTitle: { flexShrink: 1 },
  // new chat
  newChatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 2,
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.md,
    padding: theme.spacing.sm + 2,
    borderRadius: theme.radius.md,
  },
  newChatIcon: {
    width: 30,
    height: 30,
    borderRadius: theme.radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  newChatLabel: { fontWeight: '600' },
  // search
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
  },
  searchInput: { flex: 1, padding: 0 },
  // history
  history: { flex: 1 },
  historyEmpty: {
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl,
  },
  historyEmptySub: { textAlign: 'center' },
  group: { marginTop: theme.spacing.sm },
  groupLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 2,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 10,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  historyText: { flex: 1 },
  historyTitle: { flexShrink: 1 },
  historyTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  historyTitleUnread: { fontWeight: '700' },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginLeft: 4,
  },
  historyMeta: { flexDirection: 'row', alignItems: 'center' },
  historyProject: { flexShrink: 1 },
  // footer
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: theme.spacing.xs,
    gap: 2,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 2,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 10,
  },
  footerLabel: { flex: 1 },
  footerConnText: { flex: 1 },
  // new chat sheet
  modalScrim: { flex: 1, justifyContent: 'flex-end' },
  modalScrimTap: { flex: 1 },
  sheet: {
    paddingTop: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: theme.spacing.md,
  },
  sheetTitle: { marginBottom: 2 },
  sheetSubtitle: { marginBottom: theme.spacing.md },
  sheetEmpty: { paddingVertical: theme.spacing.xl, textAlign: 'center' },
  manageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  sheetLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  projectList: { maxHeight: 260 },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 2,
    padding: theme.spacing.sm + 2,
    marginBottom: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: 1,
  },
  projectIcon: {
    width: 28,
    height: 28,
    borderRadius: theme.radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  projectText: { flex: 1 },
  projectName: { fontWeight: '500' },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  chip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
  },
  chipText: { textTransform: 'none' },
  sheetOffline: { marginBottom: theme.spacing.sm, textAlign: 'center' },
  startButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingVertical: 13,
    borderRadius: theme.radius.pill,
  },
  startButtonText: { fontWeight: '600' },
});
