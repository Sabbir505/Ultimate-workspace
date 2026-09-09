/**
 * SessionChat — the ChatGPT-app-style conversation screen for one session.
 *
 * Layout (top to bottom):
 *   Header      back · centered title (long-press to rename) · model chip
 *               (opens ModelSheet) · drawer menu button (AppDrawer)
 *   Messages    INVERTED FlatList — newest turn at the bottom, older pages
 *               paginate in at the top (onEndReached → loadMore), pull to
 *               refresh. User turns render as right-aligned bubbles;
 *               assistant turns render full-width as plain text with
 *               think/tool segments (MessageBubble). The live streaming
 *               turn sits at the very bottom of the list.
 *   Approvals   pending ApprovalCards between the list and the composer.
 *   Plan card   live plan proposal pinned above the composer.
 *   Status      transient status pill (StatusBanner) + error banner.
 *   Composer    ChatComposer pill (send / stop / voice / attachments).
 *
 * `deleted` flips to a full-screen "This conversation was cleared" state.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const ArrowLeft = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="arrow-back" size={size} color={color} />;
const ChevronDown = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="chevron-down" size={size} color={color} />;
const MenuIcon = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="menu" size={size} color={color} />;
import { theme as themeMod } from '../theme';
import { useRelay } from '../hooks/useRelay';
import { useSessionChat } from '../hooks/useSessionChat';
import MessageBubble from '../components/chat/MessageBubble';
import ChatComposer from '../components/chat/ChatComposer';
import ApprovalCard from '../components/chat/ApprovalCard';
import StatusBanner from '../components/chat/StatusBanner';
import PlanCard from '../components/chat/PlanCard';
import ModelSheet from '../components/chat/ModelSheet';
// Drawer contract (parallel build): `export function useDrawer():
// { open: () => void; close: () => void; isOpen: boolean }` from AppDrawer.
import { useDrawer } from '../components/AppDrawer';

export default function SessionChat() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const session = route.params?.session as { id: string; title?: string } | undefined;
  const sessionId: string | null = (route.params?.sessionId as string | undefined) ?? session?.id ?? null;

  const c = themeMod.colors;
  const { providers, connected, transcribeAudio, startLocalModel } = useRelay();
  const drawer = useDrawer();
  const chat = useSessionChat(sessionId);

  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const listRef = useRef<FlatList>(null);
  const lastAutoScrollRef = useRef(0);

  const title = chat.meta?.title ?? session?.title ?? 'Chat';

  // Auto-scroll to the newest content (inverted list → offset 0 = bottom).
  // Throttled to one scroll per 100 ms so streaming tokens don't fight the
  // layout engine for the whole turn (PERFORMANCE_AUDIT.md M5).
  useEffect(() => {
    if (chat.messages.length === 0 && chat.streamingContent.length === 0) return;
    const scroll = () => {
      lastAutoScrollRef.current = Date.now();
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
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

  const listHeader = useMemo(() => (
    // Visual BOTTOM of the inverted list: the live streaming turn.
    // (Every row is counter-flipped — `inverted` mirrors the content.)
    chat.streaming ? (
      <View style={styles.flipRow}>
        <MessageBubble
          role="assistant"
          content={chat.streamingContent}
          streaming
        />
      </View>
    ) : null
  ), [chat.streaming, chat.streamingContent]);

  const listFooter = useMemo(() => (
    // Visual TOP of the inverted list: pagination + first-load states.
    <View style={styles.flipRow}>
      {chat.loading && chat.messages.length === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={c.textSecondary} />
        </View>
      ) : chat.hasMore ? (
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
      ) : null}
    </View>
  ), [chat.loading, chat.hasMore, chat.messages.length, chat.loadMore, c.textSecondary, c.surface2, c.border, c.text]);

  const listEmpty = useMemo(() => (
    !chat.loading && !chat.streaming ? (
      <View style={[styles.emptyRow, styles.flipRow]}>
        <Text style={[styles.emptyText, { color: c.textSecondary }]}>
          Ask anything
        </Text>
      </View>
    ) : null
  ), [chat.loading, chat.streaming, c.textSecondary]);

  const renderItem = useCallback(({ item }: { item: { id: number; role: string; content: string } }) => (
    <View style={styles.flipRow}>
      <MessageBubble
        role={item.role as 'user' | 'assistant' | 'system'}
        content={item.content}
      />
    </View>
  ), []);

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
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.headerBtn}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
            accessibilityLabel="Back"
          >
            <ArrowLeft size={22} color={c.text} />
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
            </Text>            <ChevronDown size={13} color={c.textSecondary} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => drawer.open()}
            style={styles.headerBtn}
            hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
            accessibilityLabel="Open menu"
          >
            <MenuIcon size={20} color={c.text} />
          </TouchableOpacity>
        </View>

        {/* Messages — inverted: newest at the bottom, ChatGPT style. */}
        <FlatList
          ref={listRef}
          data={chat.messages}
          keyExtractor={(item) => String(item.id)}
          inverted
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
          onEndReachedThreshold={0.6}
          onEndReached={() => {
            if (chat.hasMore && !chat.loading) chat.loadMore();
          }}
          refreshControl={
            <RefreshControl
              refreshing={chat.loading && chat.messages.length > 0}
              onRefresh={chat.refresh}
              tintColor={c.textSecondary}
              colors={[c.accent]}
            />
          }
        />

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

        {/* Composer — send while idle, stop while streaming. Send gating
            lives in useSessionChat.send (not-connected error surfaced there). */}
        <ChatComposer
          onSend={chat.send}
          onTranscribe={transcribeAudio}
          onCancel={chat.cancel}
          streaming={chat.streaming}
          disabled={!connected}
          placeholder={connected ? 'Message' : 'Not connected to desktop'}
        />

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

        {/* Model picker bottom sheet. */}
        <ModelSheet
          visible={modelSheetOpen}
          onClose={() => setModelSheetOpen(false)}
          providers={providers}
          currentProvider={chat.meta?.provider ?? null}
          currentModel={chat.meta?.model ?? null}
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
  // `inverted` mirrors the list content vertically — every row, the header
  // (streaming turn), footer and empty state are counter-flipped so their
  // contents render upright.
  flipRow: { transform: [{ scaleY: -1 }] },
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
