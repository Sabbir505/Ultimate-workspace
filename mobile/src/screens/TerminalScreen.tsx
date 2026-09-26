/**
 * TerminalScreen — read/write mirror of the desktop pane's terminal for one
 * session (desktop TerminalPane parity, phone-shaped).
 *
 * The relay's GetTranscript op answers with the RENDERED terminal screen (a
 * vt100 snapshot, not the raw stream — TUI redraw sequences would be
 * unreadable concatenated) and skips byte-identical answers, so polling on a
 * timer is cheap. Input goes out via SendToSession, which writes to the
 * session's live pane on the desktop (a '\r' terminates the line, exactly
 * what the desktop keyboard's Enter produces).
 *
 * If the session has no live pane on the desktop the poll answers an empty
 * screen forever — say so instead of showing a blank terminal.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import { useRelay, onTranscript } from '../hooks/useRelay';

const POLL_MS = 1500;

export default function TerminalScreen() {
  // Timing was missing here — every other screen records its mount mark.
  useScreenMountTiming('TerminalScreen');
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const sessionId: string | null = route.params?.sessionId ?? null;
  const fallbackTitle: string = route.params?.title ?? 'Terminal';

  const c = theme.colors;
  const { getTranscript, sendToSession } = useRelay();

  const [screen, setScreen] = useState<string>('');
  const [gotScreen, setGotScreen] = useState(false);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!sessionId) return;
    // Poll the rendered screen; the relay answers an empty `text` with
    // unchanged=true when nothing moved, so this stays cheap.
    getTranscript(sessionId);
    const timer = setInterval(() => getTranscript(sessionId), POLL_MS);
    const off = onTranscript.on(({ sessionId: sid, text, unchanged }) => {
      if (sid !== sessionId || unchanged) return;
      setScreen(text);
      setGotScreen(true);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    });
    return () => { clearInterval(timer); off(); };
  }, [sessionId, getTranscript]);

  const send = useCallback(() => {
    const text = draft;
    if (!sessionId || !text.trim()) return;
    setDraft('');
    sendToSession(sessionId, `${text}\r`);
    // The echo comes back on the next poll tick — nudge it right away.
    setTimeout(() => getTranscript(sessionId), 250);
  }, [sessionId, draft, sendToSession, getTranscript]);

  const title = fallbackTitle;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: c.background, borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={22} color={c.text} />
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>{title}</Text>
          <Text style={[styles.subtitle, { color: c.textSecondary }]}>Live terminal · desktop pane</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.screenWrap}
          contentContainerStyle={styles.screenContent}
        >
          {!gotScreen ? (
            <Text style={[styles.screenText, { color: c.textSecondary }]}>
              Connecting to the desktop pane…
            </Text>
          ) : screen.length === 0 ? (
            <Text style={[styles.screenText, { color: c.textSecondary }]}>
              No terminal output yet — the session's pane may be idle or closed on the desktop.
            </Text>
          ) : (
            <Text style={[styles.screenText, { color: c.text }]}>{screen}</Text>
          )}
        </ScrollView>

        <View style={[styles.inputRow, { backgroundColor: c.surface, borderTopColor: c.border }]}>
          <TextInput
            style={[styles.input, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
            value={draft}
            onChangeText={setDraft}
            placeholder="Type a command…"
            placeholderTextColor={c.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            returnKeyType="send"
            onSubmitEditing={send}
            accessibilityLabel="Terminal input"
          />
          <TouchableOpacity
            style={[styles.sendBtn, { backgroundColor: c.accent }]}
            onPress={send}
            disabled={!draft.trim()}
            accessibilityRole="button"
            accessibilityLabel="Send to terminal"
          >
            <Ionicons name="return-down-forward-outline" size={17} color={c.white} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  backBtn: { padding: 6 },
  titleWrap: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  subtitle: { fontSize: 11, lineHeight: 15 },
  screenWrap: { flex: 1 },
  screenContent: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.lg,
  },
  screenText: {
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 14,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
