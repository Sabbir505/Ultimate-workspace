/**
 * ChatComposer — the ChatGPT-app pill composer for the SessionChat screen.
 *
 * One rounded pill (radius pill, hairline border, surface bg) containing:
 *   - "+"      opens the existing attachment flow (document picker; images
 *              and docs with the desktop-matching size caps). Selected
 *              files show as removable chips in a row ABOVE the pill.
 *   - input    auto-growing TextInput (body type, no border; scrolls after
 *              ~5 lines).
 *   - right    mic button when empty (press-and-hold to dictate), accent
 *              send circle (arrow-up) when there's content, stop button
 *              while a stream is in flight.
 *
 * VOICE: press-and-hold the mic records with expo-audio (HIGH_QUALITY
 * preset → .m4a); on release the file is read to base64 (expo-file-system)
 * and sent to the desktop via `transcribeAudio`; the returned text is
 * appended into the input. Recording state = red pulsing dot + timer;
 * transcription state = inline spinner. Every failure path lands in a
 * non-blocking inline error line — never an Alert, never a crash. Sliding
 * the finger off the mic cancels (discards) the recording.
 *
 * Send gating is unchanged: the caller's `onSend` routes through
 * useSessionChat.send, which reports not-connected errors itself.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Keyboard,
  ScrollView,
  Animated,
  ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { File as ExponentFile } from 'expo-file-system';
import CameraCaptureSheet from './CameraCaptureSheet';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { theme } from '../../theme';
import { onChatSkills, useRelay, type ChatSkillInfo, type ConnectorInfo } from '../../hooks/useRelay';
import { tapLight, tapMedium, notifySuccess } from '../../lib/haptics';
import { onTranscription, type SessionChatAttachment } from '../../hooks/useRelay';

// M4: Ionicons glyph-font wrappers preserving the lucide call-shapes.
const AttachIcon = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="add" size={size} color={color} />
);
const MicIcon = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="mic-outline" size={size} color={color} />
);
const ArrowUp = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="arrow-up" size={size} color={color} />
);
const StopIcon = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="stop" size={size} color={color} />
);
const CloseIcon = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="close-circle" size={size} color={color} />
);

// ONE per-file cap, matching the desktop's send-path check
// (src-tauri/src/chat/commands/send.rs MAX_ATTACHMENT_BYTES = 25 MB) so the
// phone rejects exactly what the desktop rejects — the old 15/10/0.5 MB split
// silently refused files the desktop accepts.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const DOC_EXTS = ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h'];

function classifyByName(name: string): 'image' | 'doc' | 'text' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (DOC_EXTS.includes(ext)) return 'doc';
  return 'text';
}

// Extension → MIME map for image attachments. The desktop builds a
// `data:<media_type>;base64,…` URI from this value, so it MUST be a real
// MIME type — a bare extension like "png" yields `data:png;base64,…` which
// vision endpoints reject.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function imageMediaType(name: string, assetMimeType?: string): string {
  if (assetMimeType && assetMimeType.startsWith('image/')) return assetMimeType;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXT[ext] ?? 'image/png';
}

/** HIGH_QUALITY records .m4a — the MIME the desktop's transcriber expects. */
const RECORDING_MIME = 'audio/mp4';
/** Slide farther than this from the mic and the recording is discarded. */
const CANCEL_SLIDE_DISTANCE = 56;
/** Give up waiting for the desktop's Transcription reply after this long. */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

/**
 * Native on-device speech recognition (the phone's own mic + OS recognizer).
 * Resolves ONLY when the native module is compiled in — i.e. the EAS dev /
 * release APK. Expo Go doesn't bundle it, so there the composer falls back to
 * the record-then-transcribe-on-desktop flow (the lazy require must not be a
 * static import: the package throws at import time when the native side is
 * missing, which would take the whole composer down).
 */
function getNativeStt(): typeof import('expo-speech-recognition') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-speech-recognition');
    if (mod?.ExpoSpeechRecognitionModule?.start && mod?.ExpoSpeechRecognitionModule?.stop) return mod;
    return null;
  } catch {
    return null;
  }
}
const NativeStt = getNativeStt();

interface ChatComposerProps {
  onSend: (text: string, attachments?: SessionChatAttachment[]) => void;
  /** Transcribe a base64 recording on the desktop (useRelay.transcribeAudio).
   *  The reply arrives on the `onTranscription` relay bus. */
  onTranscribe: (dataBase64: string, mediaType?: string) => void;
  /** Tab rendered into the composer's top edge (the model/agent picker on
   *  the new-chat screen — desktop composer parity, one card). */
  notch?: React.ReactNode;
  /** @-menu connector state (desktop composer parity). */
  connectors?: {
    list: ConnectorInfo[];
    attached: string[];
    onToggle: (id: string) => void;
  };
  onCancel?: () => void;
  streaming?: boolean;
  placeholder?: string;
  /** Hard-disable the composer entirely (e.g. relay disconnected) — the
   *  send path would just drop the frame, so there's nothing to send into. */
  disabled?: boolean;
}

export default function ChatComposer({
  onSend,
  onTranscribe,
  notch,
  connectors,
  onCancel,
  streaming = false,
  placeholder = 'Message',
  disabled = false,
}: ChatComposerProps) {
  const c = theme.colors;
  const [text, setText] = useState('');
  // Slash menu (desktop composer parity): `/` opens built-in commands plus
  // the desktop's installed/builtin skills. Selecting inserts `/slug `.
  const [skills, setSkills] = useState<ChatSkillInfo[]>([]);
  const { listChatSkills } = useRelay();
  useEffect(() => {
    const off = onChatSkills.on(({ skills: list }) => setSkills(list));
    listChatSkills();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const slashQuery = useMemo(() => {
    const m = text.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [text]);
  const BUILTIN_COMMANDS: { slug: string; description: string }[] = [
    { slug: 'compact', description: 'Summarize older context' },
    { slug: 'research', description: 'Multi-source research mode' },
    { slug: 'microcompact', description: 'CLI-native context compaction' },
  ];
  const slashItems = useMemo(() => {
    if (slashQuery == null) return [];
    const q = slashQuery;
    const cmds = BUILTIN_COMMANDS
      .filter((c) => c.slug.startsWith(q))
      .map((c) => ({ slug: c.slug, name: c.slug, description: c.description, builtin: true }));
    const sk = skills
      .filter((k) => k.slug.startsWith(q) || k.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map((k) => ({ slug: k.slug, name: k.name, description: k.description, builtin: false }));
    return [...cmds, ...sk];
  }, [slashQuery, skills]);
  const applySlash = useCallback((slug: string) => {
    setText((prev) => prev.replace(/\/[A-Za-z0-9_-]*$/, `/${slug} `));
  }, []);
  // @-menu (desktop parity): `@` opens connected connectors/MCP servers;
  // tapping one attaches/detaches it for the conversation.
  const atQuery = useMemo(() => {
    const m = text.match(/(?:^|\s)@([A-Za-z0-9 ._-]*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [text]);
  const atItems = useMemo(() => {
    if (atQuery == null || !connectors) return [];
    const q = atQuery;
    return connectors.list
      .filter((c) => c.connected)
      .filter((c) => !q || c.display_name.toLowerCase().includes(q) || c.family.toLowerCase().includes(q))
      .slice(0, 20);
  }, [atQuery, connectors]);
  const toggleConnector = useCallback((id: string) => {
    connectors?.onToggle(id);
    // Close the menu: the attachment chip is the state display from here.
    setText((prev) => prev.replace(/@([A-Za-z0-9 ._-]*)$/, ''));
  }, [connectors]);
  const attachedNames = useMemo(
    () =>
      (connectors?.attached ?? [])
        .map((id) => connectors?.list.find((c) => c.id === id)?.display_name ?? id)
        .filter(Boolean),
    [connectors],
  );
  const [attachments, setAttachments] = useState<SessionChatAttachment[]>([]);
  // Attach source picker: the + opens a small menu (camera vs files) instead
  // of going straight to the document picker.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // --- native speech recognition (phone's own mic) ---
  // The hold-to-talk gesture drives it exactly like the recording flow:
  // pressIn starts the OS recognizer (interim results stream live into the
  // input), pressOut stops and finalizes. Slide-off aborts and restores the
  // pre-dictation text. Only used when the native module exists (dev/release
  // APK) — Expo Go falls back to the desktop transcription flow below.
  const sttListeningRef = useRef(false);
  const sttBaseRef = useRef('');
  const sttFinalRef = useRef('');

  useEffect(() => {
    const stt = NativeStt;
    if (!stt) return;
    const mod = stt.ExpoSpeechRecognitionModule as {
      addListener?: (event: string, cb: (e: never) => void) => { remove: () => void } | undefined;
    };
    const subs: { remove: () => void }[] = [];
    subs.push(mod.addListener?.('result', (e: { isFinal: boolean; results?: { transcript: string }[] }) => {
      if (!sttListeningRef.current) return;
      const transcript = (e.results ?? []).map((r) => r.transcript).join(' ').trim();
      if (e.isFinal) {
        sttFinalRef.current = [sttFinalRef.current, transcript].filter(Boolean).join(' ');
        setText((sttBaseRef.current ? `${sttBaseRef.current} ` : '') + sttFinalRef.current);
      } else if (transcript) {
        const interim = [sttBaseRef.current, sttFinalRef.current, transcript].filter(Boolean).join(' ');
        setText(interim);
      }
    }) ?? { remove: () => {} });
    subs.push(mod.addListener?.('error', (e: { error?: string }) => {
      // 'aborted' is the deliberate slide-off cancel — not an error.
      if (e?.error === 'aborted') return;
      setVoiceError(`Speech recognition error: ${e?.error ?? 'unknown'}`);
      sttListeningRef.current = false;
      setRecording(false);
    }) ?? { remove: () => {} });
    subs.push(mod.addListener?.('end', () => {
      sttListeningRef.current = false;
      setRecording(false);
    }) ?? { remove: () => {} });
    return () => subs.forEach((s) => s.remove());
  }, []);


  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recPulse = useRecPulse();

  const recordingRef = useRef(false);
  // True between onPressIn and onPressOut — lets the async start path bail
  // if the finger is already up (e.g. the permission prompt ate the press).
  const pressActiveRef = useRef(false);
  const cancelSlideRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const awaitingTranscribeRef = useRef(false);
  const transcribeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canSend =
    !disabled && !streaming && !recording && !transcribing &&
    (text.trim().length > 0 || attachments.length > 0);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const trimmed = text.trim();
    setText('');
    setAttachments([]);
    Keyboard.dismiss();
    tapMedium();
    notifySuccess();
    onSend(trimmed, attachments);
  }, [canSend, text, attachments, onSend]);

  // --- attachments (existing flow, unchanged semantics) ---

  const handleAttach = useCallback(async () => {
    if (streaming || disabled) return;
    tapLight();
    setAttachMenuOpen(false);
    try {
      // The NEW FileSystem API's own picker: the returned File objects carry
      // the SAF READ permission, so .base64()/.text() work. The old
      // DocumentPicker → new File(uri) path is rejected at runtime with
      // "Missing 'READ' permission" (SDK 57 permission model).
      const result = await ExponentFile.pickFileAsync({ multipleFiles: true });
      if (result.canceled || !result.result?.length) return;

      const picked: SessionChatAttachment[] = [];
      for (const file of result.result) {
        const name = file.name;
        const kind = classifyByName(name);
        const size = file.size;

        // Fail closed: a picker result without a size would sail through the
        // cap below and get read into base64 wholesale — treat it as
        // over-limit instead of trusting an unbounded read.
        if (!size) {
          setVoiceError(`${name}: file size unknown — attachment skipped.`);
          continue;
        }
        if (size > MAX_ATTACHMENT_BYTES) {
          setVoiceError(`${name} exceeds the 25 MB attachment limit.`);
          continue;
        }
        if (kind === 'image') {
          const data = await file.base64();
          picked.push({ name, kind: 'image', data, media_type: imageMediaType(name) });
        } else if (kind === 'doc') {
          const data = await file.base64();
          picked.push({ name, kind: 'doc', data, format: name.split('.').pop()?.toLowerCase() });
        } else {
          const fileText = await file.text();
          picked.push({ name, kind: 'text', text: fileText });
        }
      }

      if (picked.length > 0) setAttachments((prev) => [...prev, ...picked]);
    } catch (e) {
      setVoiceError((e as Error)?.message ?? 'Could not pick file.');
    }
  }, [streaming, disabled]);

  // Camera capture: the sheet resolves with a cache file:// URI (app sandbox
  // — readable under the new FileSystem permission model), read to base64
  // and attached as a JPEG image.
  const handlePhotoCaptured = useCallback(async (uri: string) => {
    setCameraOpen(false);
    try {
      const data = await new ExponentFile(uri).base64();
      const name = `photo-${Date.now()}.jpg`;
      setAttachments((prev) => [
        ...prev,
        { name, kind: 'image', data, media_type: 'image/jpeg' },
      ]);
      notifySuccess();
    } catch (e) {
      setVoiceError((e as Error)?.message ?? 'Could not attach the photo.');
    }
  }, []);
  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // --- voice dictation ---

  // Recording timer.
  useEffect(() => {
    if (!recording) return;
    setRecordSeconds(0);
    const t = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // Transcription reply arrives on the global relay bus — only accept it
  // while we actually have a request in flight.
  useEffect(() => {
    const off = onTranscription.on(({ text: reply, error }) => {
      if (!awaitingTranscribeRef.current) return;
      awaitingTranscribeRef.current = false;
      if (transcribeTimeoutRef.current) {
        clearTimeout(transcribeTimeoutRef.current);
        transcribeTimeoutRef.current = null;
      }
      setTranscribing(false);
      if (error) {
        setVoiceError(error);
        return;
      }
      if (reply) setText((prev) => (prev ? `${prev} ${reply}` : reply));
    });
    return off;
  }, []);

  const startRecording = useCallback(async () => {
    if (streaming || disabled || transcribing) return;
    pressActiveRef.current = true;
    // Native STT path (dev/release APK): the OS recognizer listens directly —
    // no recording, no desktop round trip.
    if (NativeStt) {
      try {
        setVoiceError(null);
        const perm = await NativeStt.ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!perm.granted) {
          setVoiceError('Microphone permission denied.');
          return;
        }
        // The finger may already be up (permission prompt delay) — same
        // discard rule as the recording path.
        if (!pressActiveRef.current) return;
        cancelSlideRef.current = false;
        sttBaseRef.current = text;
        sttFinalRef.current = '';
        NativeStt.ExpoSpeechRecognitionModule.start({
          lang: 'en-US',
          interimResults: true,
          continuous: true,
        });
        sttListeningRef.current = true;
        setRecording(true);
      } catch {
        sttListeningRef.current = false;
        setRecording(false);
        setVoiceError('Could not start listening.');
      }
      return;
    }
    try {
      setVoiceError(null);
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setVoiceError('Microphone permission denied.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      // The finger may already be up (permission prompt delay) — discard
      // instead of leaving a runaway recording with no listener.
      if (!pressActiveRef.current) {
        await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
        return;
      }
      cancelSlideRef.current = false;
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      setRecording(true);
    } catch {
      recordingRef.current = false;
      setRecording(false);
      setVoiceError('Could not start recording.');
    }
  }, [recorder, streaming, disabled, transcribing, text]);

  const finishRecording = useCallback(async (transcribe: boolean) => {
    pressActiveRef.current = false;
    // Native STT path: stop (finalize) or abort (slide-off cancel restores
    // the pre-dictation text). The 'end' event clears the listening flag.
    if (sttListeningRef.current) {
      const mod = NativeStt?.ExpoSpeechRecognitionModule;
      if (!transcribe || cancelSlideRef.current) {
        mod?.abort();
        setText(sttBaseRef.current);
      } else {
        mod?.stop();
      }
      return;
    }
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      if (!transcribe || cancelSlideRef.current) return; // discarded
      const uri = recorder.uri;
      if (!uri) {
        setVoiceError('Recording unavailable.');
        return;
      }
      setTranscribing(true);
      awaitingTranscribeRef.current = true;
      const dataBase64 = await new ExponentFile(uri).base64();
      onTranscribe(dataBase64, RECORDING_MIME);
      transcribeTimeoutRef.current = setTimeout(() => {
        if (awaitingTranscribeRef.current) {
          awaitingTranscribeRef.current = false;
          setTranscribing(false);
          setVoiceError('Transcription timed out.');
        }
      }, TRANSCRIBE_TIMEOUT_MS);
    } catch {
      awaitingTranscribeRef.current = false;
      setTranscribing(false);
      setVoiceError('Could not transcribe the recording.');
    }
  }, [recorder, onTranscribe]);

  const timerText = `${Math.floor(recordSeconds / 60)}:${String(recordSeconds % 60).padStart(2, '0')}`;

  const micDisabled = streaming || disabled || transcribing;

  const menuOpen = slashItems.length > 0 || atItems.length > 0;

  // The `/` and `@` menus are a POPUP above the composer (desktop parity) —
  // a floating panel anchored to the card's top edge, not something drawn
  // inside the input's own surface.
  const menu = menuOpen ? (
    <View style={styles.menuDock}>
      <View style={[styles.slashMenu, { backgroundColor: c.elevated, borderColor: c.border }]}>
        <ScrollView style={styles.slashList} keyboardShouldPersistTaps="always" bounces={false}>
          {slashItems.map((it) => (
            <TouchableOpacity
              key={`${it.builtin ? 'b' : 's'}-${it.slug}`}
              style={styles.slashRow}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Command ${it.slug}`}
              onPress={() => applySlash(it.slug)}
            >
              <Text style={[styles.slashName, { color: c.text }]} numberOfLines={1}>
                /{it.slug}
              </Text>
              <Text style={[styles.slashDesc, { color: c.textSecondary }]} numberOfLines={1}>
                {it.description}
              </Text>
            </TouchableOpacity>
          ))}
          {atItems.map((conn) => (
            <TouchableOpacity
              key={`c-${conn.id}`}
              style={styles.slashRow}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Connector ${conn.display_name}`}
              onPress={() => toggleConnector(conn.id)}
            >
              <Text style={[styles.slashName, { color: c.text }]} numberOfLines={1}>
                {conn.display_name}
              </Text>
              <Text style={[styles.slashDesc, { color: c.textSecondary }]} numberOfLines={1}>
                {connectors?.attached.includes(conn.id) ? 'Attached — tap to detach' : conn.description}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </View>
  ) : null;

  return (
    <View style={styles.rootWrap}>
      {menu}
      <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
      {/* Notch — the model/agent picker tab riding the card's top edge. */}
      {notch ? <View style={styles.notchSlot}>{notch}</View> : null}
      {voiceError ? (
        <Text style={[styles.voiceError, { color: c.error }]} numberOfLines={2}>
          {voiceError}
        </Text>
      ) : null}

      {attachments.length > 0 && (
        <ScrollView horizontal style={styles.attachmentRow} showsHorizontalScrollIndicator={false}>
          {attachments.map((att, i) => (
            <View
              key={`${att.name}-${i}`}
              style={[styles.attachmentChip, { backgroundColor: c.surface2, borderColor: c.border }]}
            >
              <Ionicons
                name={att.kind === 'image' ? 'image' : att.kind === 'doc' ? 'document' : 'document-text'}
                size={14}
                color={c.accent}
              />
              <Text style={[styles.attachmentName, { color: c.text }]} numberOfLines={1}>
                {att.name}
              </Text>
              <TouchableOpacity
                onPress={() => removeAttachment(i)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <CloseIcon size={16} color={c.textSecondary} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={[styles.pill, { backgroundColor: 'transparent', borderWidth: 0 }]}>
        {attachMenuOpen ? (
          <View style={[styles.attachMenu, { backgroundColor: c.elevated, borderColor: c.border }]}>
            <TouchableOpacity
              style={styles.attachMenuItem}
              onPress={() => { tapLight(); setAttachMenuOpen(false); setCameraOpen(true); }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Take photo with camera"
            >
              <Ionicons name="camera-outline" size={18} color={c.text} />
              <Text style={[styles.attachMenuText, { color: c.text }]}>Take photo</Text>
            </TouchableOpacity>
            <View style={[styles.attachMenuDivider, { backgroundColor: c.border }]} />
            <TouchableOpacity
              style={styles.attachMenuItem}
              onPress={() => void handleAttach()}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Choose file"
            >
              <Ionicons name="folder-open-outline" size={18} color={c.text} />
              <Text style={[styles.attachMenuText, { color: c.text }]}>Choose file</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        <TouchableOpacity
          style={[styles.plusBtn, { borderColor: c.border }]}
          onPress={() => { tapLight(); setAttachMenuOpen((v) => !v); }}
          disabled={streaming || disabled}
          activeOpacity={0.7}
          accessibilityLabel="Attach photo or file"
        >
          <AttachIcon size={20} color={streaming || disabled ? c.textSecondary : c.text} />
        </TouchableOpacity>

        {recording ? (
          <View style={styles.recordingRow}>
            <Animated.View style={[styles.recDot, { backgroundColor: c.error, opacity: recPulse }] } />
            <Text style={[styles.recText, { color: c.error }]}>
              {NativeStt ? 'Listening…' : `Recording ${timerText}`}
            </Text>
            <Text style={[styles.recHint, { color: c.textSecondary }]}>
              {cancelSlideRef.current ? 'Release to discard' : 'Release to insert · slide off to cancel'}
            </Text>
          </View>
        ) : transcribing ? (
          <View style={styles.recordingRow}>
            <ActivityIndicator size="small" color={c.accent} />
            <Text style={[styles.recText, { color: c.textSecondary }]}>Transcribing…</Text>
          </View>
        ) : (
          <TextInput
            style={[styles.input, { color: c.text }]}
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={c.textSecondary}
            multiline
            editable={!streaming && !disabled}
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
            returnKeyType="default"
          />
        )}

        {/* Attached connectors (desktop composer pills) — tap × to detach. */}
        {attachedNames.length > 0 ? (
          <View style={styles.attachedRow}>
            {attachedNames.map((name) => {
              const id = connectors?.attached.find(
                (cid) => (connectors?.list.find((c) => c.id === cid)?.display_name ?? cid) === name,
              );
              return (
                <TouchableOpacity
                  key={name}
                  style={[styles.attachedChip, { backgroundColor: c.bubble, borderColor: c.border }]}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Detach ${name}`}
                  onPress={() => id && toggleConnector(id)}
                >
                  <Ionicons name="attach-outline" size={11} color={c.accent} />
                  <Text style={[styles.attachedText, { color: c.text }]} numberOfLines={1}>{name}</Text>
                  <Ionicons name="close-circle" size={12} color={c.textSecondary} />
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}


        {streaming && onCancel ? (
          <TouchableOpacity
            style={[styles.roundBtn, { backgroundColor: c.text }]}
            onPress={() => {
              tapLight();
              onCancel();
            }}
            activeOpacity={0.7}
            accessibilityLabel="Stop generating"
          >
            <StopIcon size={16} color={c.surface} />
          </TouchableOpacity>
        ) : canSend ? (
          <TouchableOpacity
            style={[styles.roundBtn, { backgroundColor: c.accent }]}
            onPress={handleSend}
            activeOpacity={0.8}
            accessibilityLabel="Send message"
          >
            <ArrowUp size={18} color={c.white} />
          </TouchableOpacity>
        ) : (
          <Pressable
            style={[
              styles.roundBtn,
              { backgroundColor: recording ? c.error : c.surface2 },
              micDisabled && styles.btnDisabled,
            ]}
            delayLongPress={120}
            onPressIn={() => {
              if (!micDisabled) void startRecording();
            }}
            onPressOut={() => {
              void finishRecording(true);
            }}
            onTouchStart={(e) => {
              const t = e.nativeEvent;
              touchStartRef.current = { x: t.locationX, y: t.locationY };
              cancelSlideRef.current = false;
            }}
            onTouchMove={(e) => {
              const start = touchStartRef.current;
              if (!start) return;
              const t = e.nativeEvent;
              const dx = t.locationX - start.x;
              const dy = t.locationY - start.y;
              if (Math.sqrt(dx * dx + dy * dy) > CANCEL_SLIDE_DISTANCE) {
                cancelSlideRef.current = true;
              }
            }}
            disabled={micDisabled}
            accessibilityLabel="Hold to record voice"
          >
            <MicIcon size={18} color={recording ? c.white : c.text} />
          </Pressable>
        )}
      </View>
      <CameraCaptureSheet
        visible={cameraOpen}
        onCaptured={(uri) => void handlePhotoCaptured(uri)}
        onClose={() => setCameraOpen(false)}
      />
    </View>
    </View>
  );
}

// Recording-dot pulse is created lazily below the component body's first use
// via a tiny hook — kept module-local so the composer stays readable.
function useRecPulse() {
  const pulse = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return pulse;
}

const styles = StyleSheet.create({
  voiceError: {
    ...theme.type.secondary,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  attachmentRow: {
    flexDirection: 'row',
    marginBottom: 8,
    flexGrow: 0,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 6,
    maxWidth: 160,
  },
  attachmentName: {
    fontSize: 12,
    maxWidth: 100,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 50,
    paddingLeft: 2,
    paddingRight: 2,
    gap: 4,
  },
  plusBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachMenu: {
    position: 'absolute',
    left: 0,
    bottom: 46,
    zIndex: 30,
    elevation: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    paddingVertical: 4,
    minWidth: 170,
  },
  attachMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  attachMenuText: { fontSize: 14 },
  attachMenuDivider: { height: StyleSheet.hairlineWidth, marginLeft: 44 },
  rootWrap: {
    position: 'relative',
  },
  menuDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    marginBottom: 8,
  },
  slashMenu: {
    maxHeight: 184,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    // Popup lift off the composer, desktop-menu style.
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  slashList: { maxHeight: 184 },
  slashRow: { paddingHorizontal: 12, paddingVertical: 8 },
  slashName: { fontSize: 13, fontWeight: '600' },
  slashDesc: { fontSize: 11, marginTop: 1 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: theme.spacing.md,
    paddingTop: 4,
    paddingBottom: 10,
  },
  notchSlot: {
    alignSelf: 'flex-start',
    marginTop: -12,
    marginBottom: 2,
  },
  attachedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingBottom: 6,
  },
  attachedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  attachedText: { fontSize: 11, fontWeight: '600' },
  input: {
    flex: 1,
    // A flex child with no floor collapses to ZERO height inside the
    // auto-height docked card on Android — typing became invisible.
    minHeight: 30,
    borderWidth: 0,
    paddingTop: 8,
    paddingBottom: 8,
    paddingHorizontal: 6,
    ...theme.type.body,
    maxHeight: 5 * 24 + 8,
  },
  recordingRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    minHeight: 40,
  },
  recDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  recText: {
    ...theme.type.secondary,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  recHint: {
    ...theme.type.secondary,
    flex: 1,
  },
  roundBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.4 },
});
