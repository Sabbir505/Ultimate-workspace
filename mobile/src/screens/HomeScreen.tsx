import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRelay, onAcpAgentList, type AcpAgentInfo} from '../hooks/useRelay';
import { theme, useTheme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import ConnectionIndicator from '../components/ConnectionIndicator';
import { HARNESS_OPTIONS, useCreateSessionFlow, useDrawerActions } from '../components/AppDrawer';
import QrScanModal from './QrScanModal';
import ModelSheet from '../components/chat/ModelSheet';
import ChatComposer from '../components/chat/ChatComposer';
import type { SessionChatAttachment, ConnectorInfo } from '../hooks/useRelay';
import { onConnectorList } from '../hooks/useRelay';
import { tapLight } from '../lib/haptics';

/**
 * Mobile mirror of the desktop's new-chat welcome (ChatView + ChatWelcome):
 * a time-aware greeting ("Still up?"), the same four starter cards, and a
 * bottom composer whose model chip lists the desktop's providers. Chat
 * history lives in the drawer, not here.
 */

// Desktop parity: chatWelcomeShared's WELCOME_PROMPTS + timeGreeting.
const WELCOME_PROMPTS: { title: string; sub: string; icon: 'doc' | 'concept' | 'code' | 'research' }[] = [
  { title: 'Write a document', sub: 'Draft a brief, memo, or report', icon: 'doc' },
  { title: 'Explain a concept', sub: 'Get a clear breakdown of any topic', icon: 'concept' },
  { title: 'Write code', sub: 'Build a script, fix a bug, or refactor', icon: 'code' },
  { title: 'Research a topic', sub: 'Gather and synthesize sources', icon: 'research' },
];

const PROMPT_ICONS: Record<'doc' | 'concept' | 'code' | 'research', keyof typeof Ionicons.glyphMap> = {
  doc: 'document-text',
  concept: 'bulb-outline',
  code: 'code-slash',
  research: 'search',
};

function timeGreeting(): { hi: string; ask: string } {
  const h = new Date().getHours();
  if (h < 5) return { hi: 'Still up?', ask: "Let's get this done." };
  if (h < 12) return { hi: 'Good morning', ask: 'What should we get done today?' };
  if (h < 18) return { hi: 'Good afternoon', ask: 'What are we working on?' };
  return { hi: 'Good evening', ask: 'How can I help you tonight?' };
}

export default function HomeScreen() {
  useScreenMountTiming('HomeScreen');
  // `connecting` holds a STABLE middle state for the whole handshake: the
  // old two-way connected/offline flip re-rendered the entire screen between
  // its starter-card layout and its pairing layout on every reconnect
  // attempt, which read as the app flashing for the first few seconds.
  const { connected, connecting, connect, providers, harnesses, defaultModel, startLocalModel, transcribeAudio, listConnectors, getSessionConnectors, setSessionConnectors, listAcpAgents } = useRelay();
  // Actions only: subscribing to the drawer's STATE would re-render the
  // home screen on every open/close, including the close that accompanies a
  // navigation away from it.
  const { open } = useDrawerActions();
  useTheme(); // subscribe so theme.colors is reactive
  const c = theme.colors;
  const insets = useSafeAreaInsets();

  const [qrVisible, setQrVisible] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // ACP agents for the picker's Agents · ACP rail (desktop parity).
  const [acpAgents, setAcpAgents] = useState<AcpAgentInfo[]>([]);
  React.useEffect(() => {
    if (!connected) return;
    listAcpAgents();
    const off = onAcpAgentList.on(({ agents }) => setAcpAgents(agents));
    return off;
  }, [connected, listAcpAgents]);
  const start = useCreateSessionFlow();

  // Selected model for new chats (what the model chip shows). Defaults to
  // the DESKTOP's auto-route default (what its own composer shows — e.g.
  // "Deepseek V4.1 Flash"), then the first cloud provider; the pick rides
  // CreateSession → the chat is born on that model. Effort ('' = Def)
  // rides along, mirroring the desktop picker's slider.
  const [picked, setPicked] = useState<{ provider: string; model: string } | null>(null);
  const [pickedEffort, setPickedEffort] = useState('');
  // Composer @-menu state: connector catalog + what's attached to the
  // not-yet-created chat (rides CreateSession).
  const [connectorList, setConnectorList] = useState<ConnectorInfo[]>([]);
  const [attachedConnectors, setAttachedConnectors] = useState<string[]>([]);
  React.useEffect(() => {
    if (!connected) return;
    listConnectors();
    const off = onConnectorList.on(({ connectors: list }) => setConnectorList(list));
    return off;
  }, [connected, listConnectors]);
  const toggleConnector = React.useCallback((id: string) => {
    setAttachedConnectors((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  }, []);
  const greeting = useMemo(timeGreeting, []);
  const selected = useMemo(() => {
    if (picked) return picked;
    if (defaultModel) return defaultModel;
    const first = providers.find((p) => !p.is_local) ?? providers[0];
    const model = first?.models?.[0];
    return first && model ? { provider: first.id, model } : null;
  }, [picked, defaultModel, providers]);

  // The + inside ChatComposer covers "Add files or photos" (document
  // picker); "Choose working folder…" parity is the Pick a project row.
  // A harness pick (provider 'harness:<id>') maps onto CreateSession's
  // harness field — the desktop commits agent+model together too.
  const sendNewChat = useCallback((text: string, attachments?: SessionChatAttachment[]) => {
    if (!connected || !text.trim()) return;
    let harness = '';
    let provider = selected?.provider;
    if (provider?.startsWith('harness:')) {
      harness = provider.slice('harness:'.length);
      provider = undefined;
    }
    start('', harness, text.trim(), provider, selected?.model, attachments, pickedEffort, attachedConnectors);
  }, [connected, selected, pickedEffort, attachedConnectors, start]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      {/* Header: drawer menu left, quiet connection right */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          onPress={open}
        >
          <Ionicons name="menu" size={24} color={c.text} />
        </TouchableOpacity>
        <ConnectionIndicator size={8} showLabel />
      </View>

      <ScrollView contentContainerStyle={styles.body} bounces={false} keyboardShouldPersistTaps="handled">
        {/* Time-aware greeting — desktop ChatWelcome parity */}
        {connected || connecting ? (
          <View style={styles.greetingBlock}>
            <Text style={[styles.greetingHi, { color: c.text }]}>{greeting.hi}</Text>
            <Text style={[styles.greetingAsk, { color: c.textSecondary }]}>
              {connected ? greeting.ask : 'Connecting to your desktop…'}
            </Text>
          </View>
        ) : (
          <View style={styles.greetingBlock}>
            <View style={[styles.glyph, { backgroundColor: c.accent }]}>
              <Text style={[styles.glyphText, { color: c.white }]}>R</Text>
            </View>
            <Text style={[styles.greetingHi, { color: c.text }]}>Relay</Text>
            <Text style={[styles.greetingAsk, { color: c.textSecondary }]}>
              Pair with your desktop to take your agent anywhere.
            </Text>
          </View>
        )}

        {connected || connecting ? (
          <>
            {/* Starter cards — desktop WELCOME_PROMPTS; tap prefills. */}
            <View style={styles.prompts}>
              {WELCOME_PROMPTS.map((p) => (
                <TouchableOpacity
                  key={p.title}
                  style={[styles.promptCard, { backgroundColor: c.surface2, borderColor: c.border }]}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${p.title}: ${p.sub}`}
                  onPress={() => { tapLight(); sendNewChat(p.title); }}
                >
                  <View style={[styles.promptIcon, { backgroundColor: c.bubble }]}>
                    <Ionicons name={PROMPT_ICONS[p.icon]} size={15} color={c.textSecondary} />
                  </View>
                  <View style={styles.promptText}>
                    <Text numberOfLines={1} style={[styles.promptTitle, { color: c.text }]}>
                      {p.title}
                    </Text>
                    <Text numberOfLines={2} style={[styles.promptSub, { color: c.textSecondary }]}>
                      {p.sub}
                    </Text>
                  </View>
                  <Ionicons name="arrow-forward" size={13} color={c.textSecondary} />
                </TouchableOpacity>
              ))}
            </View>
          </>
        ) : (
          /* Offline: pairing explainer + QR scan entry */
          <View style={[styles.offlineCard, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <Ionicons name="cloud-offline-outline" size={28} color={c.textSecondary} />
            <Text style={[styles.offlineTitle, { color: c.text }]}>Pair with your desktop</Text>
            <Text style={[styles.offlineBody, { color: c.textSecondary }]}>
              Open Relay on your desktop, head to the Remote settings panel, and scan the
              pairing QR code. Your sessions and agent chats stay in sync over that
              connection.
            </Text>
            <TouchableOpacity
              style={[styles.scanButton, { backgroundColor: c.accent }]}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Scan pairing QR code"
              onPress={() => { tapLight(); setQrVisible(true); }}
            >
              <Ionicons name="qr-code-outline" size={18} color={c.white} />
              <Text style={styles.scanButtonText}>Scan QR</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Bottom composer — docked to the screen's bottom edge (desktop
          parity): model chip + the real ChatComposer (attach/input/mic/send). */}
      {connected || connecting ? (
        <View style={{ marginHorizontal: theme.spacing.md, marginBottom: Math.max(insets.bottom, 10) }}>
          <ChatComposer
            onSend={sendNewChat}
            onTranscribe={transcribeAudio}
            disabled={!connected}
            placeholder="Write a message…"
            notch={
              <TouchableOpacity
                style={[styles.modelChip, { borderColor: c.border, backgroundColor: c.surface2 }]}
                accessibilityRole="button"
                accessibilityLabel={`Model: ${selected ? `${selected.provider} ${selected.model}` : 'select'}`}
                onPress={() => { tapLight(); setModelSheetOpen(true); }}
              >
                <Ionicons name="cube-outline" size={13} color={c.textSecondary} />
                <Text numberOfLines={1} style={[styles.modelChipText, { color: c.text }]}>
                  {selected ? selected.model : 'Model'}
                </Text>
                <Ionicons name="chevron-down" size={12} color={c.textSecondary} />
              </TouchableOpacity>
            }
            connectors={{ list: connectorList, attached: attachedConnectors, onToggle: toggleConnector }}
          />
        </View>
      ) : null}

      <ModelSheet
        visible={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        providers={providers}
        harnesses={harnesses}
        acpAgents={acpAgents}
        currentProvider={selected?.provider ?? null}
        currentModel={selected?.model ?? null}
        effort={pickedEffort}
        onEffortChange={setPickedEffort}
        onSelect={(provider, model) => setPicked({ provider, model })}
        onStartLocal={(model, ggufPath) => startLocalModel(model, ggufPath)}
      />

      <QrScanModal
        visible={qrVisible}
        onClose={() => setQrVisible(false)}
        onScanned={(url) => { connect(url); setQrVisible(false); }}
      />
    </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  iconButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: -theme.spacing.xs,
  },
  body: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  // greeting
  greetingBlock: { alignItems: 'center', paddingTop: '14%', paddingBottom: theme.spacing.lg },
  glyph: {
    width: 52,
    height: 52,
    borderRadius: theme.radius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  glyphText: { fontSize: 24, fontWeight: '800' },
  greetingHi: { fontSize: 24, fontWeight: '800', marginBottom: 4 },
  greetingAsk: { fontSize: theme.fontSize.md },
  // starter cards
  prompts: { gap: theme.spacing.sm },
  promptCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 2,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
  },
  promptIcon: {
    width: 30,
    height: 30,
    borderRadius: theme.radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  promptText: { flex: 1 },
  promptTitle: { fontWeight: '600', fontSize: theme.fontSize.sm },
  promptSub: { fontSize: theme.fontSize.xs, marginTop: 1 },
  // composer
  composer: {
    // Docked composer (outside the scroll view): side margins + a hairline
    // lift off the bottom edge; marginBottom carries the safe-area inset.
    marginHorizontal: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  modelChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
  },
  modelChipText: {
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
  },
  // offline card
  offlineCard: {
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
  },
  offlineTitle: { marginTop: theme.spacing.xs },
  offlineBody: { textAlign: 'center', marginBottom: theme.spacing.sm },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
  },
  scanButtonText: { fontWeight: '600' },
});
