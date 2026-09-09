import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import {
  Alert, Animated, BackHandler, Easing, Modal, Pressable,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
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
import { getRelayUrl, onSessionCreated, useRelay, type Session } from '../hooks/useRelay';
import { theme, useTheme } from '../theme';
import ConnectionIndicator from './ConnectionIndicator';
import { tapLight, tapMedium } from '../lib/haptics';

// ---------------------------------------------------------------------------
// Drawer context — the provider wraps the whole app so ANY screen can call
// useDrawer().open(); the overlay itself renders above the navigator (it is
// mounted as a sibling of the Tab.Navigator inside the NavigationContainer).
// ---------------------------------------------------------------------------

export interface DrawerApi {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** Whether the inline "new chat" project/agent picker sheet is up. */
  newChatOpen: boolean;
  openNewChat: () => void;
  closeNewChat: () => void;
}

const DrawerContext = createContext<DrawerApi>({
  isOpen: false,
  open: () => {},
  close: () => {},
  newChatOpen: false,
  openNewChat: () => {},
  closeNewChat: () => {},
});

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);

  // Haptics live here (not at call sites) so every opener/closer gets the same
  // physical feedback and row taps can't double-fire the pattern.
  const open = useCallback(() => { tapMedium(); setIsOpen(true); }, []);
  const close = useCallback(() => { tapLight(); setIsOpen(false); }, []);
  const openNewChat = useCallback(() => { setIsOpen(false); setNewChatOpen(true); }, []);
  const closeNewChat = useCallback(() => { setNewChatOpen(false); }, []);

  const api = useMemo<DrawerApi>(() => ({
    isOpen, open, close, newChatOpen, openNewChat, closeNewChat,
  }), [isOpen, open, close, newChatOpen, openNewChat, closeNewChat]);

  return <DrawerContext.Provider value={api}>{children}</DrawerContext.Provider>;
}

export function useDrawer(): DrawerApi {
  return useContext(DrawerContext);
}

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

/** Unique projects seen in the session list, newest activity first. */
export function collectProjects(sessions: Session[]): ProjectSummary[] {
  const byKey = new Map<string, { id: string; name: string; provider: string; last: number }>();
  for (const s of sessions) {
    const key = s.projectId || s.projectName || 'unknown';
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

function timeAgo(timestamp: number): string {
  const s = Math.floor((Date.now() - timestamp) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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
  const sorted = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);
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

  return useCallback((projectId: string, harness: string) => {
    clear();
    // createSession returns false when the socket isn't OPEN — surface that
    // instead of waiting the full 15s for an event that can never arrive.
    if (!createSession(projectId, harness)) {
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
  const { sessions, connected } = useRelay();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  useTheme();
  const c = theme.colors;
  const start = useCreateSessionFlow();

  const projects = useMemo(() => collectProjects(sessions), [sessions]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [harness, setHarness] = useState('claude_code');

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

  const canStart = Boolean(projectId) && connected;

  const handleStart = () => {
    if (!projectId || !connected) return;
    onClose();
    // Land on the chat home while the desktop creates the session (the
    // SessionCreated listener in `start` opens the chat itself).
    navigation.navigate('Home');
    start(projectId, harness);
  };

  return (
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

          {projects.length === 0 ? (
            <Text style={[styles.sheetEmpty, { color: c.textSecondary }, theme.type.secondary]}>
              No projects yet — start a CLI session on your desktop and it will show up here.
            </Text>
          ) : (
            <>
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

              <Text style={[styles.sheetLabel, { color: c.textSecondary }, theme.type.label]}>AGENT</Text>
              <View style={styles.chipRow}>
                {HARNESS_OPTIONS.map((opt) => {
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
                        ]}
                      >
                        {opt.label}
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
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The drawer overlay. Render ONCE inside the NavigationContainer, as a
// sibling AFTER the navigator so it stacks above every screen.
// ---------------------------------------------------------------------------

export default function AppDrawer() {
  const { isOpen, close, newChatOpen, closeNewChat, openNewChat } = useDrawer();
  const { sessions, connected, deleteSession, spawnSession } = useRelay();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  useTheme(); // subscribe so theme.colors is reactive
  const c = theme.colors;

  const panelWidth = Math.min(Math.round(winWidth * 0.82), 380);
  const progress = useRef(new Animated.Value(0)).current;
  // Keep the panel mounted through the close animation, unmount when settled.
  const [mounted, setMounted] = useState(isOpen);

  useEffect(() => {
    Animated.timing(progress, {
      toValue: isOpen ? 1 : 0,
      duration: 250,
      easing: isOpen ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !isOpen) setMounted(false);
    });
    if (isOpen) setMounted(true);
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

  const confirmClear = useCallback((session: Session) => {
    Alert.alert(
      'Clear conversation history?',
      'The session stays on the desktop. This clears the chat history linked to your phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear conversation',
          style: 'destructive',
          onPress: () => deleteSession(session.id),
        },
      ],
    );
  }, [deleteSession]);

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
    close();
    navigation.navigate('Settings');
  }, [close, navigation]);

  // The picker modal must stay mounted even while the panel itself is gone.
  if (!mounted) return <NewChatModal visible={newChatOpen} onClose={closeNewChat} />;

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

      <Animated.View
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
            onChangeText={setQuery}
            placeholder="Search chats"
            placeholderTextColor={c.textSecondary}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query.length > 0 && (
            <TouchableOpacity
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Ionicons name="close-circle" size={16} color={c.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {/* History grouped by time */}
        <ScrollView style={styles.history} keyboardShouldPersistTaps="handled">
          {groups.length === 0 && (
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
          )}
          {groups.map((group) => (
            <View key={group.label} style={styles.group}>
              <Text style={[styles.groupLabel, { color: c.textSecondary }, theme.type.label]}>
                {group.label}
              </Text>
              {group.items.map((s) => (
                <TouchableOpacity
                  key={s.id}
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
                    <Text
                      numberOfLines={1}
                      style={[styles.historyTitle, { color: c.text }, theme.type.body]}
                    >
                      {s.title || 'Untitled'}
                    </Text>
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
              ))}
            </View>
          ))}
        </ScrollView>

        {/* Bottom rows: Settings + connection */}
        <View style={[styles.footer, { borderTopColor: c.border }]}>
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
