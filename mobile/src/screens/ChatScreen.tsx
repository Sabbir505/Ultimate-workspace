import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Send, Paperclip, Bot, User, ChevronDown, ChevronUp, FileText, XCircle, Square, Sparkles, Code2, Bug, Lightbulb } from 'lucide-react-native';
import { useRelay, onChatToken, onChatDone, onChatError, type ChatUsage } from '../hooks/useRelay';
import { theme, useTheme } from '../theme';
import ModelSelector from '../components/ModelSelector';
import ConnectionIndicator from '../components/ConnectionIndicator';

// Suggestion chips shown in the empty state. Each pairs a label with an icon
// so the welcome screen reads as a tidy set of starter prompts rather than a
// wall of text.
const SUGGESTIONS: Array<{ icon: React.ReactNode; label: string }> = [
  { icon: <Code2 size={15} color={theme.colors.primary} />, label: 'Explain this codebase' },
  { icon: <Sparkles size={15} color={theme.colors.primary} />, label: 'Write a function to sort an array' },
  { icon: <Bug size={15} color={theme.colors.primary} />, label: 'Help me debug a null pointer' },
  { icon: <Lightbulb size={15} color={theme.colors.primary} />, label: 'Best practices for React?' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessageUI {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** True while the assistant response is still streaming. */
  streaming?: boolean;
  usage?: ChatUsage;
  error?: string;
  toolCalls?: { name: string; status: 'running' | 'done' | 'error' }[];
  artifacts?: { name: string; type: string; content?: string }[];
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: ChatMessageUI }) {
  const isUser = message.role === 'user';
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={[
      styles.messageBubble,
      isUser ? styles.userBubble : styles.assistantBubble,
    ]}>
      <View style={styles.messageHeader}>
        {isUser ? (
          <User size={14} color={theme.colors.primary} />
        ) : (
          <Bot size={14} color={theme.colors.textSecondary} />
        )}
        <Text style={[styles.messageRole, isUser ? styles.userRole : styles.assistantRole]}>
          {isUser ? 'You' : 'Assistant'}
        </Text>
        <Text style={styles.messageTime}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>

      <Text style={styles.messageContent}>
        {message.content}
        {message.streaming && <Text style={styles.cursor}>▌</Text>}
      </Text>

      {message.error && (
        <View style={styles.errorRow}>
          <XCircle size={14} color={theme.colors.error} />
          <Text style={styles.errorText}>{message.error}</Text>
        </View>
      )}

      {/* Tool calls summary */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <TouchableOpacity onPress={() => setExpanded(!expanded)} style={styles.toolCallsRow}>
          <ChevronDown
            size={14}
            color={theme.colors.textSecondary}
            style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
          />
          <Text style={styles.toolCallsText}>
            {message.toolCalls.length} tool call{message.toolCalls.length > 1 ? 's' : ''}
          </Text>
        </TouchableOpacity>
      )}

      {expanded && message.toolCalls && (
        <View style={styles.toolCallsList}>
          {message.toolCalls.map((tc, idx) => (
            <View key={idx} style={styles.toolCallItem}>
              <View style={[
                styles.toolCallDot,
                tc.status === 'done' && { backgroundColor: theme.colors.success },
                tc.status === 'error' && { backgroundColor: theme.colors.error },
                tc.status === 'running' && { backgroundColor: theme.colors.warning },
              ]} />
              <Text style={styles.toolCallName}>{tc.name}</Text>
              <Text style={styles.toolCallStatus}>{tc.status}</Text>
            </View>
          ))}
        </View>
      )}

      {message.artifacts && message.artifacts.length > 0 && (
        <View style={styles.artifactsContainer}>
          {message.artifacts.map((artifact, idx) => (
            <View key={idx} style={styles.artifactCard}>
              <FileText size={16} color={theme.colors.primary} />
              <Text style={styles.artifactName} numberOfLines={1}>{artifact.name}</Text>
            </View>
          ))}
        </View>
      )}

      {message.usage && (
        <Text style={styles.usageText}>
          {message.usage.input_tokens} in / {message.usage.output_tokens} out
          {message.usage.cost_usd > 0 ? ` · $${message.usage.cost_usd.toFixed(4)}` : ''}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ChatScreen() {
  const { connected, desktopUnreachable, providers, sendChatTurn, cancelChatTurn, connect, refreshProviders } = useRelay();
  useTheme(); // subscribe to theme changes so theme.colors is reactive
  const c = theme.colors;
  const [messages, setMessages] = useState<ChatMessageUI[]>([]);
  const [inputText, setInputText] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('anthropic');
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-5-20250929');
  const [selectedGgufPath, setSelectedGgufPath] = useState<string | undefined>(undefined);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [localModelStarting, setLocalModelStarting] = useState(false);
  // The desktop-generated chat session id for the in-flight turn (captured
  // from the first ChatToken) — needed to cancel the stream.
  const activeTurnIdRef = useRef<string | null>(null);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    connect();
    // The provider list is only auto-requested on WS open + a slow 30s poll.
    // If the connection persisted across a desktop rebuild (onopen never
    // re-fired), providers would be empty when this screen mounts — so nudge
    // a refresh on mount and whenever connectivity is re-established.
    refreshProviders();
  }, [connect, refreshProviders]);

  // Seed / repair the model selection from the provider list the desktop
  // sends. The hardcoded defaults (anthropic/sonnet) are placeholders until
  // this arrives — if they're not actually available, pick the first real one.
  useEffect(() => {
    if (providers.length === 0) return;
    const current = providers.find(
      p => p.id === selectedProvider && (selectedProvider !== 'local_gguf' || p.gguf_path === selectedGgufPath)
    );
    const modelOk = current?.models.some(m => m.toLowerCase() === selectedModel.toLowerCase());
    if (current && modelOk) return;
    // Prefer a running cloud provider; fall back to a running local one, then
    // whatever came first (a stopped local model can still be warmed up).
    const first =
      providers.find(p => !p.is_local) ??
      providers.find(p => p.is_running) ??
      providers[0];
    setSelectedProvider(first.id);
    setSelectedModel(first.models[0] ?? '');
    setSelectedGgufPath(first.gguf_path);
  }, [providers]);

  // Subscribe to streaming events from the relay
  useEffect(() => {
    const unsubToken = onChatToken.on(({ chatSessionId, token }) => {
      // Capture the desktop's turn id so the stop button can cancel it.
      if (chatSessionId !== 'warmup') activeTurnIdRef.current = chatSessionId;
      setStreamingMsgId((currentId) => {
        if (!currentId) return null;

        // Skip warm-up status messages — they're for the loading banner
        if (token.startsWith('[STATUS]')) {
          setLocalModelStarting(false);
          return currentId;
        }

        setMessages(prev => prev.map(m =>
          m.id === currentId
            ? { ...m, content: m.content + token.replace(' thinking', '').replace(' response', '') }
            : m
        ));
        return currentId;
      });
    });

    const unsubDone = onChatDone.on(({ usage }) => {
      activeTurnIdRef.current = null;
      setStreamingMsgId((currentId) => {
        setMessages(prev => prev.map(m =>
          m.id === currentId
            ? { ...m, streaming: false, usage: usage ?? m.usage }
            : m
        ));
        return null;
      });
    });

    const unsubError = onChatError.on(({ error }) => {
      activeTurnIdRef.current = null;
      setStreamingMsgId((currentId) => {
        setMessages(prev => prev.map(m =>
          m.id === currentId
            ? { ...m, streaming: false, error }
            : m
        ));
        return null;
      });
    });

    return () => {
      unsubToken();
      unsubDone();
      unsubError();
    };
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages]);

  const handleSend = useCallback((text?: string) => {
    const content = (text ?? inputText).trim();
    if (!content || !connected) return;

    const userMsg: ChatMessageUI = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    const assistantMsg: ChatMessageUI = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInputText('');
    setStreamingMsgId(assistantMsg.id);

    // ggufPath lets the desktop warm up a stopped local model before sending.
    sendChatTurn(selectedProvider, selectedModel, [{ role: 'user', content }], {
      ggufPath: selectedGgufPath,
    });
  }, [inputText, selectedProvider, selectedModel, selectedGgufPath, sendChatTurn, connected]);

  const handleStop = useCallback(() => {
    const id = activeTurnIdRef.current;
    if (id) cancelChatTurn(id);
    activeTurnIdRef.current = null;
    // Optimistically end the streaming state; the relay aborts server-side.
    setMessages(prev => prev.map(m => (m.id === streamingMsgId ? { ...m, streaming: false } : m)));
    setStreamingMsgId(null);
  }, [cancelChatTurn, streamingMsgId]);

  const handleModelSelect = useCallback((provider: string, model: string, ggufPath?: string) => {
    setSelectedProvider(provider);
    setSelectedModel(model);
    setSelectedGgufPath(ggufPath);
    if (ggufPath) {
      setLocalModelStarting(true);
    } else {
      setLocalModelStarting(false);
    }
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      {/* One KeyboardAvoidingView around the whole screen so the header stays
          fixed and the messages list compresses, keeping the input bar above
          the on-screen keyboard. 'padding' on iOS; 'height' on Android (Expo
          defaults to adjustResize so the flex layout already shrinks). */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <View style={styles.headerLeft}>
          <ConnectionIndicator connected={connected} size={10} />
          <Text style={styles.headerTitle}>Chat</Text>
        </View>
        <ModelSelector
          providers={providers}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          onSelect={handleModelSelect}
        />
      </View>

      {/* Desktop unreachable banner */}
      {desktopUnreachable && (
        <View style={styles.unreachableBanner}>
          <Text style={styles.unreachableText}>
            {selectedProvider === 'local_gguf'
              ? `Your desktop app needs to be running to use ${selectedModel} — there's no cloud fallback for local models.`
              : 'Desktop unreachable — open Conduit on your computer to chat.'}
          </Text>
        </View>
      )}

      {/* Local model warm-up banner — spinner so the user can see the model
          is loading on the desktop sidecar (5–30s for large GGUFs). */}
      {localModelStarting && (
        <View style={[styles.loadingBanner, { backgroundColor: 'rgba(255, 152, 0, 0.10)', borderBottomColor: 'rgba(255, 152, 0, 0.25)' }]}>
          <ActivityIndicator size="small" color={theme.colors.warning} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.loadingBannerTitle, { color: theme.colors.warning }]}>
              Loading local model…
            </Text>
            <Text style={[styles.loadingBannerSub, { color: c.textSecondary }]}>
              Warming up {selectedModel} on your desktop. This can take 5–30 seconds.
            </Text>
          </View>
        </View>
      )}

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={messages.length === 0 ? styles.emptyList : styles.messagesList}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={[styles.emptyIconCircle, { backgroundColor: 'rgba(193, 95, 60, 0.10)' }]}>
              <Bot size={32} color={theme.colors.primary} />
            </View>
            <Text style={[styles.emptyTitle, { color: c.text }]}>How can I help?</Text>
            <Text style={[styles.emptySubtitle, { color: c.textSecondary }]}>
              {connected
                ? selectedProvider === 'local_gguf'
                  ? `Chatting with ${selectedModel} on your desktop. Pick a starter or type your own below.`
                  : 'Pick a starter prompt below or type your own message to begin.'
                : 'Connect to your desktop to start chatting.'}
            </Text>
            {connected && (
              <View style={styles.chipRow}>
                {SUGGESTIONS.map(({ icon, label }) => (
                  <TouchableOpacity
                    key={label}
                    style={[styles.chip, { backgroundColor: c.surface, borderColor: c.border }]}
                    onPress={() => handleSend(label)}
                    activeOpacity={0.7}
                  >
                    {icon}
                    <Text style={[styles.chipText, { color: c.text }]} numberOfLines={2}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        }
      />

      {/* Input */}
      <View style={[styles.inputContainer, { backgroundColor: c.surface, borderTopColor: c.border }]}>
        <TextInput
          style={styles.input}
          placeholder={connected ? 'Message…' : 'Connect to desktop to chat'}
          placeholderTextColor={theme.colors.textSecondary}
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={4000}
          editable={connected}
        />
        {streamingMsgId ? (
          <TouchableOpacity
            style={styles.sendButton}
            onPress={handleStop}
            accessibilityLabel="Stop generating"
          >
            <Square size={16} color="#fff" fill="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendButton, (!inputText.trim() || !connected) && styles.sendButtonDisabled]}
            onPress={() => handleSend()}
            disabled={!inputText.trim() || !connected}
          >
            <Send size={20} color={inputText.trim() && connected ? '#fff' : theme.colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface, borderBottomWidth: 1, borderBottomColor: theme.colors.border,
    gap: 12,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: theme.fontSize.lg, fontWeight: '700', color: theme.colors.text },
  messagesList: { padding: theme.spacing.md, paddingBottom: theme.spacing.lg, gap: theme.spacing.md },
  emptyList: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyState: { alignItems: 'center', gap: 10, paddingHorizontal: 28, paddingVertical: 20 },
  emptyTitle: { fontSize: theme.fontSize['2xl'], fontWeight: '800', color: theme.colors.text },
  emptySubtitle: { fontSize: theme.fontSize.md, color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  messageBubble: {
    borderRadius: theme.borderRadius.lg, padding: theme.spacing.md,
    maxWidth: '90%', borderWidth: 1, borderColor: theme.colors.border,
  },
  userBubble: {
    backgroundColor: 'rgba(193, 95, 60, 0.08)', alignSelf: 'flex-end', borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: theme.colors.surface, alignSelf: 'flex-start', borderBottomLeftRadius: 4,
  },
  messageHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  messageRole: { fontSize: theme.fontSize.sm, fontWeight: '600' },
  userRole: { color: theme.colors.primary },
  assistantRole: { color: theme.colors.textSecondary },
  messageTime: { fontSize: theme.fontSize.xs, color: theme.colors.textSecondary, marginLeft: 'auto' },
  messageContent: { fontSize: theme.fontSize.md, color: theme.colors.text, lineHeight: 22 },
  cursor: { color: theme.colors.primary, fontWeight: '700' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
  errorText: { fontSize: theme.fontSize.sm, color: theme.colors.error, flex: 1 },
  usageText: { fontSize: theme.fontSize.xs, color: theme.colors.textSecondary, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
  toolCallsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
  toolCallsText: { fontSize: theme.fontSize.sm, color: theme.colors.textSecondary, fontWeight: '500' },
  toolCallsList: { marginTop: 8, gap: 6 },
  toolCallItem: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.colors.background, padding: 8, borderRadius: theme.borderRadius.sm },
  toolCallDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.gray },
  toolCallName: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.text, fontFamily: 'monospace' },
  toolCallStatus: { fontSize: theme.fontSize.xs, color: theme.colors.textSecondary, textTransform: 'capitalize' },
  artifactsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border },
  artifactCard: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.colors.background, paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.borderRadius.sm, borderWidth: 1, borderColor: theme.colors.border },
  artifactName: { fontSize: theme.fontSize.sm, color: theme.colors.text, fontFamily: 'monospace', maxWidth: 200 },
  inputContainer: { flexDirection: 'row', alignItems: 'flex-end', padding: theme.spacing.md, backgroundColor: theme.colors.surface, borderTopWidth: 1, borderTopColor: theme.colors.border, gap: 8 },
  input: { flex: 1, backgroundColor: theme.colors.background, borderRadius: theme.borderRadius.lg, paddingHorizontal: theme.spacing.md, paddingVertical: 10, fontSize: theme.fontSize.md, color: theme.colors.text, maxHeight: 120, borderWidth: 1, borderColor: theme.colors.border },
  sendButton: { backgroundColor: theme.colors.primary, width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  sendButtonDisabled: { backgroundColor: theme.colors.border },
  unreachableBanner: { backgroundColor: 'rgba(229, 57, 53, 0.08)', borderBottomWidth: 1, borderBottomColor: 'rgba(229, 57, 53, 0.2)', padding: theme.spacing.md },
  unreachableText: { fontSize: theme.fontSize.sm, color: theme.colors.error, textAlign: 'center', lineHeight: 18 },
  loadingBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderBottomWidth: 1, padding: theme.spacing.md,
  },
  loadingBannerTitle: { fontSize: theme.fontSize.md, fontWeight: '700' },
  loadingBannerSub: { fontSize: theme.fontSize.xs, marginTop: 2, lineHeight: 16 },
  emptyIconCircle: {
    width: 64, height: 64, borderRadius: 32,
    justifyContent: 'center', alignItems: 'center', marginBottom: 4,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18, paddingHorizontal: 4 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, borderWidth: 1,
  },
  chipText: { fontSize: theme.fontSize.sm, flexShrink: 1 },
});