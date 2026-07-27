import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, useWindowDimensions, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Send, ArrowLeft } from 'lucide-react-native';
import { useRelay, onTranscript, type Session } from '../hooks/useRelay';
import { useTheme } from '../theme';
import AnsiRenderer from '../components/AnsiRenderer';

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Extra keys for driving TUI prompts (model pickers, questions, confirms):
 *  arrow keys, enter/esc/tab, and Ctrl+C to interrupt. Sent straight to the
 *  pty as escape sequences, exactly what a hardware keyboard would send. */
const TUI_KEYS: Array<{ label: string; data: string }> = [
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: 'Enter', data: '\r' },
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: '^C', data: '\x03' },
];

export default function SessionScreen() {
  const navigation = useNavigation();
  const route = useRoute<any>();
  const session: Session | undefined = route.params?.session;
  const { sendToSession, getTranscript } = useRelay();
  const { isDark } = useTheme();
  const [followUp, setFollowUp] = useState('');
  const [transcript, setTranscript] = useState('');
  // Terminal width in columns (reported by the desktop with each snapshot) —
  // drives the font auto-fit so the full width lands on the phone screen.
  const [termCols, setTermCols] = useState(0);
  const [zoom, setZoom] = useState(1);
  const { width: windowWidth } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);

  // Fit the terminal's column count to the phone width: a monospace advance
  // is ≈0.6× the font size. Floored at 7px (horizontal scroll takes over
  // below that), capped at 13px so narrow terminals don't look comical.
  const H_PADDING = 16;
  const fitSize = termCols > 0 ? (windowWidth - H_PADDING) / (termCols * 0.6) : 12;
  const termFontSize = Math.max(7, Math.min(13, Math.floor(fitSize * zoom)));

  const bg = isDark ? '#0d1117' : '#FAF7F5';
  const fg = isDark ? '#c9d1d9' : '#3D322C';
  const green = isDark ? '#3fb950' : '#2d7d3e';
  const gray = isDark ? '#8b949e' : '#7A6F67';
  const border = isDark ? '#30363d' : '#E8E3DF';

  useEffect(() => {
    if (!session?.id) return;
    getTranscript(session.id);
    const unsub = onTranscript.on(({ sessionId, text, cols }) => {
      // Bail on identical snapshots so an idle terminal doesn't re-render
      // a few hundred lines of <Text> every poll.
      if (sessionId === session.id) {
        setTranscript(prev => (prev === text ? prev : text));
        if (cols > 0) setTermCols(cols);
      }
    });
    // Always poll while the screen is open — the route param's isLive flag is
    // a static snapshot, and a just-created/just-spawned session goes live
    // moments after navigation. Gating the poll on that flag was what made a
    // freshly created session show "not running" until it was reopened.
    const poll = setInterval(() => getTranscript(session.id), 1000);
    return () => { unsub(); clearInterval(poll); };
  }, [session?.id, getTranscript]);

  const handleSend = useCallback(() => {
    if (!followUp.trim() || !session) return;
    sendToSession(session.id, followUp.trim() + '\r');
    setFollowUp('');
  }, [followUp, session, sendToSession]);

  const sendKey = useCallback((data: string) => {
    if (session) sendToSession(session.id, data);
  }, [session, sendToSession]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['top']}>
      {/* KeyboardAvoidingView keeps the command input + TUI keys above the
          on-screen keyboard. 'padding' on iOS pushes the bottom inset; on
          Android Expo defaults to adjustResize so the flex layout already
          shrinks — 'height' there as a safety net. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: bg, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={{ padding: 4 }}>
            <ArrowLeft size={20} color={green} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: fg, fontFamily: 'Courier New' }} numberOfLines={1}>
              {session ? `${session.projectName} / ${session.title}` : 'Session'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <Text style={{ fontSize: 11, color: gray, fontFamily: 'Courier New' }}>
                {session ? `${timeAgo(session.lastActivity)} · ${session.provider}` : ''}
              </Text>
              {session?.isLive && (
                <View style={{ backgroundColor: 'rgba(63, 185, 80, 0.15)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
                  <Text style={{ fontSize: 9, fontWeight: '700', color: green, fontFamily: 'Courier New' }}>LIVE</Text>
                </View>
              )}
            </View>
          </View>
          {/* Font zoom on top of the auto-fit — terminals can be dense. */}
          <View style={{ flexDirection: 'row', gap: 4 }}>
            <TouchableOpacity
              onPress={() => setZoom(z => Math.max(0.75, +(z - 0.25).toFixed(2)))}
              style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: border }}
            >
              <Text style={{ fontSize: 12, fontWeight: '700', color: fg }}>A−</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setZoom(z => Math.min(2, +(z + 0.25).toFixed(2)))}
              style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: border }}
            >
              <Text style={{ fontSize: 12, fontWeight: '700', color: fg }}>A+</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Terminal output: the desktop sends a rendered vt100 screen snapshot
          (SGR-styled rows), so this lays out exactly like the desktop pane.
          Lines can be wider than the phone — scroll horizontally. */}
      <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 8, paddingBottom: 20, flexGrow: 1 }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {transcript.trim() ? (
            <AnsiRenderer text={transcript} fontSize={termFontSize} />
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Text style={{ fontSize: 13, textAlign: 'center', color: gray, fontFamily: 'Courier New' }}>
                {session?.isLive ? 'Loading terminal output…' : 'Session is not running — no terminal output available.'}
              </Text>
            </View>
          )}
          <View style={{ height: 20 }} />
        </ScrollView>
      </ScrollView>

      {/* TUI keys: drive selection prompts (model pickers, questions) the
          same way arrow keys + enter would on a hardware keyboard. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: border, backgroundColor: bg, gap: 6 }}>
        {TUI_KEYS.map((k) => (
          <TouchableOpacity
            key={k.label}
            onPress={() => sendKey(k.data)}
            activeOpacity={0.6}
            style={{
              flex: 1, alignItems: 'center', paddingVertical: 7,
              backgroundColor: isDark ? '#161b22' : '#F0EDE8',
              borderRadius: 6, borderWidth: 1, borderColor: border,
            }}
          >
            <Text style={{ fontSize: k.label.length > 2 ? 10 : 14, fontWeight: '700', color: green, fontFamily: 'Courier New' }}>
              {k.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: border, backgroundColor: bg, gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: green, fontFamily: 'Courier New' }}>$</Text>
        <TextInput
          style={{ flex: 1, fontSize: 14, color: fg, fontFamily: 'Courier New', paddingVertical: 6, paddingHorizontal: 8, backgroundColor: isDark ? '#161b22' : '#F0EDE8', borderRadius: 4, borderWidth: 1, borderColor: border, maxHeight: 80 }}
          placeholder="type command..."
          placeholderTextColor={gray}
          value={followUp}
          onChangeText={setFollowUp}
          onSubmitEditing={handleSend}
          multiline={false}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={{ width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', backgroundColor: isDark ? '#161b22' : '#F0EDE8', borderWidth: 1, borderColor: border, opacity: followUp.trim() ? 1 : 0.5 }}
          disabled={!followUp.trim()}
          onPress={handleSend}
        >
          <Send size={18} color={followUp.trim() ? green : gray} />
        </TouchableOpacity>
      </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}