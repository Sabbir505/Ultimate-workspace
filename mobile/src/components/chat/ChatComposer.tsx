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
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { theme } from '../../theme';
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

// Match the desktop composer's size caps so the relay's 64 MiB default
// message cap is never the gate.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

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

interface ChatComposerProps {
  onSend: (text: string, attachments?: SessionChatAttachment[]) => void;
  /** Transcribe a base64 recording on the desktop (useRelay.transcribeAudio).
   *  The reply arrives on the `onTranscription` relay bus. */
  onTranscribe: (dataBase64: string, mediaType?: string) => void;
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
  onCancel,
  streaming = false,
  placeholder = 'Message',
  disabled = false,
}: ChatComposerProps) {
  const c = theme.colors;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<SessionChatAttachment[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

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
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const picked: SessionChatAttachment[] = [];
      for (const asset of result.assets) {
        const name = asset.name;
        const kind = classifyByName(name);
        const uri = asset.uri;
        const size = asset.size ?? 0;

        if (kind === 'image') {
          if (size > MAX_IMAGE_BYTES) {
            setVoiceError(`${name} exceeds the 15 MB image limit.`);
            continue;
          }
          const data = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          picked.push({ name, kind: 'image', data, media_type: imageMediaType(name, asset.mimeType) });
        } else if (kind === 'doc') {
          if (size > MAX_DOC_BYTES) {
            setVoiceError(`${name} exceeds the 10 MB document limit.`);
            continue;
          }
          const data = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          picked.push({ name, kind: 'doc', data, format: name.split('.').pop()?.toLowerCase() });
        } else {
          if (size > MAX_TEXT_BYTES) {
            setVoiceError(`${name} exceeds the 512 KB text limit.`);
            continue;
          }
          const fileText = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.UTF8,
          });
          picked.push({ name, kind: 'text', text: fileText });
        }
      }

      if (picked.length > 0) setAttachments((prev) => [...prev, ...picked]);
    } catch (e) {
      setVoiceError((e as Error)?.message ?? 'Could not pick file.');
    }
  }, [streaming, disabled]);
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
  }, [recorder, streaming, disabled, transcribing]);

  const finishRecording = useCallback(async (transcribe: boolean) => {
    pressActiveRef.current = false;
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
      const dataBase64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
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

  return (
    <View style={[styles.wrap, { backgroundColor: c.surface, borderColor: c.border }]}>
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

      <View style={[styles.pill, { borderColor: c.border, backgroundColor: c.surface }]}>
        <TouchableOpacity
          style={[styles.plusBtn, { borderColor: c.border }]}
          onPress={handleAttach}
          disabled={streaming || disabled}
          activeOpacity={0.7}
          accessibilityLabel="Attach file"
        >
          <AttachIcon size={20} color={streaming || disabled ? c.textSecondary : c.text} />
        </TouchableOpacity>

        {recording ? (
          <View style={styles.recordingRow}>
            <Animated.View style={[styles.recDot, { backgroundColor: c.error, opacity: recPulse }] } />
            <Text style={[styles.recText, { color: c.error }]}>Recording {timerText}</Text>
            <Text style={[styles.recHint, { color: c.textSecondary }]}>
              {cancelSlideRef.current ? 'Release to discard' : 'Release to transcribe · slide off to cancel'}
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
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.md,
    paddingTop: 8,
    paddingBottom: 10,
  },
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
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill,
    paddingLeft: 6,
    paddingRight: 6,
    paddingTop: 4,
    paddingBottom: 4,
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
  input: {
    flex: 1,
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
