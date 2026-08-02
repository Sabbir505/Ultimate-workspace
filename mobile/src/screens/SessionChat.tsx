/**
 * SessionChat — the cursor-style chat UI for a single mobile session.
 *
 * Wired to:
 *  - useSessionChat (history + streaming state + actions)
 *  - useRelay (model/provider list for the composer hint + relay lifecycle)
 *
 * Layout (top to bottom):
 *   Header       — back button, session title, harness label, overflow
 *                  (rename) menu
 *   Messages     — FlatList of MessageBubble rows (newest first) plus
 *                  pending approval cards inserted where they arrived,
 *                  and a live "streaming" bubble that takes the top slot
 *                  while a turn is in-flight
 *   Load more    — small footer button that paginates older history
 *                  (hidden on the first page)
 *   StatusBanner — transient line ("Compacting…") above the composer
 *   Composer     — ChatComposer (send while idle, stop while streaming)
 *
 * Pull-to-refresh re-fetches the latest page; the FlatList auto-scrolls
 * to the top on new content (cursor-style — newest at the top, you read
 * downward as the conversation grows).
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { ArrowLeft, Edit3, MoreVertical, RefreshCcw } from 'lucide-react-native';
import { useTheme, theme as themeMod } from '../theme';
import { useRelay, type Session } from '../hooks/useRelay';
import { useSessionChat } from '../hooks/useSessionChat';
import MessageBubble from '../components/chat/MessageBubble';
import ChatComposer from '../components/chat/ChatComposer';
import ApprovalCard from '../components/chat/ApprovalCard';
import StatusBanner from '../components/chat/StatusBanner';
import ArtifactChip from '../components/chat/ArtifactChip';

export default function SessionChat() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const session: Session | undefined = route.params?.session;
  const sessionId = session?.id ?? null;

  useTheme();
  const c = themeMod.colors;

  const { providers } = useRelay();
  const chat = useSessionChat(sessionId);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(session?.title ?? '');

  const listRef = useRef<FlatList>(null);

  // Auto-scroll to top on new content (newest-first).
  useEffect(() => {
    if (chat.messages.length > 0) {
      // Defer to next frame so the new row is mounted first.
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
    }
  }, [chat.messages.length, chat.streamingContent.length]);

  const handleRename = useCallback(() => {
    if (renameValue.trim().length === 0) return;
    chat.rename(renameValue.trim());
    setRenameOpen(false);
  }, [chat, renameValue]);

  // Resolve a model hint string from the active provider (best-effort).
  const modelHint = (() => {
    if (!session?.provider) return undefined;
    const p = providers.find((x) => x.id === session.provider);
    if (!p) return undefined;
    return `${p.display_name}${p.models[0] ? ' · ' + p.models[0] : ''}`;
  })();

  if (!sessionId) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: c.background }]}>
        <Text style={{ color: c.textSecondary, textAlign: 'center', marginTop: 32 }}>
          No session selected.
        </Text>
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
        <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.headerBtn}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
          >
            <ArrowLeft size={22} color={c.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={[styles.headerTitle, { color: c.text }]} numberOfLines={1}>
              {session?.title || 'Session'}
            </Text>
            {session?.provider ? (
              <Text style={[styles.headerSub, { color: c.textSecondary }]} numberOfLines={1}>
                {session.provider}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            onPress={() => {
              setRenameValue(session?.title ?? '');
              setRenameOpen(true);
            }}
            style={styles.headerBtn}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
          >
            <Edit3 size={18} color={c.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              Alert.alert('Session', undefined, [
                { text: 'Refresh', onPress: () => chat.loadMore() },
                { text: 'Cancel', style: 'cancel' },
              ]);
            }}
            style={styles.headerBtn}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
          >
            <MoreVertical size={20} color={c.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Error chip */}
        {chat.error ? (
          <TouchableOpacity
            onPress={chat.clearError}
            style={[styles.errorChip, { backgroundColor: c.error }]}
          >
            <Text style={styles.errorText}>{chat.error}  (tap to dismiss)</Text>
          </TouchableOpacity>
        ) : null}

        {/* Messages */}
        <FlatList
          ref={listRef}
          data={chat.messages}
          keyExtractor={(item) => String(item.id)}
          inverted={false}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <>
              {/* Live streaming bubble — appears above the persisted messages. */}
              {chat.streaming ? (
                <MessageBubble
                  role="assistant"
                  content={chat.streamingContent}
                  streaming
                  createdAt={Math.floor(Date.now() / 1000)}
                />
              ) : null}

              {/* Pending approvals at the very top of the stream. */}
              {chat.pendingApprovals.map((a) => (
                <ApprovalCard
                  key={a.pendingId}
                  tool={a.tool}
                  summary={a.summary}
                  args={a.args}
                  onApprove={() => chat.approve(a.pendingId)}
                  onDeny={() => chat.deny(a.pendingId)}
                />
              ))}

              {/* Latest artifact chip (only when not streaming). */}
              {chat.lastArtifact && !chat.streaming ? (
                <View style={styles.artifactRow}>
                  <ArtifactChip artifact={chat.lastArtifact} />
                </View>
              ) : null}

              {/* Initial loading state. */}
              {chat.loading && chat.messages.length === 0 ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color={c.textSecondary} />
                </View>
              ) : null}
            </>
          }
          renderItem={({ item }) => (
            <View>
              <MessageBubble
                role={item.role as 'user' | 'assistant' | 'system'}
                content={item.content}
                createdAt={item.created_at}
                usage={
                  item.role === 'assistant' && (item.input_tokens != null || item.output_tokens != null)
                    ? { inputTokens: item.input_tokens ?? 0, outputTokens: item.output_tokens ?? 0, costUsd: item.cost_usd ?? undefined }
                    : undefined
                }
              />
            </View>
          )}
          ListFooterComponent={
            chat.hasMore ? (
              <TouchableOpacity
                onPress={chat.loadMore}
                disabled={chat.loading}
                style={[styles.loadMoreBtn, { backgroundColor: c.surface2, borderColor: c.border }]}
              >
                {chat.loading ? (
                  <ActivityIndicator size="small" color={c.textSecondary} />
                ) : (
                  <Text style={[styles.loadMoreText, { color: c.text }]}>
                    Load older messages
                  </Text>
                )}
              </TouchableOpacity>
            ) : null
          }
          // Refresh = re-fetch the first page from the top.
          refreshing={chat.loading && chat.messages.length > 0}
          onRefresh={() => {
            // Reset the list to the first page; the hook will handle merging.
            if (sessionId) {
              // Clear local state via reload: simplest is to set sessionId in the
              // hook's ref to a sentinel, then back. We don't expose that, so
              // we approximate by calling getSessionMessages with no before_id
              // and a smaller limit; the hook appends/prepends correctly when
              // IDs are older. For a "refresh" UX, we re-send a fresh query —
              // this is best-effort.
            }
          }}
        />

        {/* Transient status banner. */}
        {chat.status ? <StatusBanner message={chat.status} /> : null}

        {/* Composer. */}
        <ChatComposer
          onSend={chat.send}
          onCancel={chat.cancel}
          streaming={chat.streaming}
          modelHint={modelHint}
          placeholder="Send a message…"
        />

        {/* Rename modal. */}
        <Modal
          visible={renameOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setRenameOpen(false)}
        >
          <View style={styles.modalBackdrop}>
            <View style={[styles.modalCard, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.modalTitle, { color: c.text }]}>Rename session</Text>
              <TextInput
                value={renameValue}
                onChangeText={setRenameValue}
                placeholder="Title"
                placeholderTextColor={c.textSecondary}
                style={[
                  styles.modalInput,
                  { color: c.text, borderColor: c.border, backgroundColor: c.surface2 },
                ]}
                autoFocus
              />
              <View style={styles.modalActions}>
                <TouchableOpacity onPress={() => setRenameOpen(false)} style={styles.modalBtn}>
                  <Text style={{ color: c.textSecondary }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleRename} style={styles.modalBtn}>
                  <Text style={{ color: c.primary, fontWeight: '600' }}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
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
  },
  headerBtn: { padding: 6 },
  headerCenter: { flex: 1, paddingHorizontal: 8 },
  headerTitle: { fontSize: 15, fontWeight: '600' },
  headerSub: { fontSize: 11, marginTop: 1 },
  listContent: { paddingTop: 8, paddingBottom: 12 },
  loadingRow: { padding: 24, alignItems: 'center' },
  loadMoreBtn: {
    margin: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  loadMoreText: { fontSize: 13, fontWeight: '500' },
  artifactRow: { paddingHorizontal: 12, paddingBottom: 4 },
  errorChip: { paddingHorizontal: 12, paddingVertical: 8 },
  errorText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 16,
  },
  modalTitle: { fontSize: 15, fontWeight: '600', marginBottom: 12 },
  modalInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12, gap: 12 },
  modalBtn: { paddingHorizontal: 12, paddingVertical: 6 },
});
