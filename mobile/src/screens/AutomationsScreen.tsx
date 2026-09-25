/**
 * AutomationsScreen — the phone's mirror of the desktop Automations view.
 *
 * List every scheduled/event automation with its trigger, last run, and
 * enable state; run one immediately, stop an in-flight run, browse past runs
 * (opening the run-log chat), and create/edit/delete through the same relay
 * ops the desktop commands use.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Switch,
  Modal,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import {
  useRelay,
  onAutomationList,
  onAutomationRuns,
  onAutomationUpdated,
  onAutomationDeleted,
  onAutomationRunStarted,
  onAutomationRunStopped,
  onAutomationRunFinished,
  onAutomationError,
  type AutomationInfo,
  type AutomationRunInfo,
} from '../hooks/useRelay';
import { tapLight } from '../lib/haptics';
import DomainErrorBar from '../components/DomainErrorBar';

const TRIGGER_LABELS: Record<string, string> = {
  cron: 'Schedule',
  webhook: 'Webhook',
  file: 'File change',
  git: 'Git change',
  gmail: 'Gmail',
};

function triggerLabel(a: AutomationInfo): string {
  const kind = TRIGGER_LABELS[a.trigger_type] ?? 'Schedule';
  if (a.trigger_type === 'cron' && a.schedule) return `${kind} · ${a.schedule}`;
  return kind;
}

function timeAgo(ts?: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts * 1000) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function AutomationsScreen() {
  useScreenMountTiming('AutomationsScreen');
  const navigation = useNavigation<any>();
  const c = theme.colors;
  const {
    connected,
    harnesses,
    listAutomations,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    setAutomationEnabled,
    runAutomationNow,
    stopAutomationRun,
    listAutomationRuns,
    spawnSession,} = useRelay();

  const [items, setItems] = useState<AutomationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AutomationInfo | 'new' | null>(null);
  const [runsFor, setRunsFor] = useState<AutomationInfo | null>(null);
  const [runs, setRuns] = useState<AutomationRunInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => listAutomations(), [listAutomations]);
  // A flapping relay (the desktop busy-starves its accept loop) reconnects
  // every few seconds. Re-blanking the list to a spinner on every flap IS
  // the "flashing" the user saw — keep the data through short drops and only
  // (re)fetch on the first load or a settled reconnect.
  const fetchedOnce = React.useRef(false);
  const runsForRef = React.useRef<AutomationInfo | null>(null);
  runsForRef.current = runsFor;

  useEffect(() => {
    if (!connected) return;
    if (!fetchedOnce.current) {
      fetchedOnce.current = true;
      setLoading(true);
      refresh();
    }
    const offList = onAutomationList.on(({ automations }) => { setItems(automations); setLoading(false); });
    const offUpdated = onAutomationUpdated.on(() => refresh());
    const offDeleted = onAutomationDeleted.on(({ automationId }) => {
      setItems((prev) => prev.filter((a) => a.id !== automationId));
    });
    const offStarted = onAutomationRunStarted.on(({ automationId }) => {
      setItems((prev) => prev.map((a) => (a.id === automationId ? { ...a, last_status: 'running' } : a)));
    });
    const offStopped = onAutomationRunStopped.on(({ automationId, stopped }) => {
      setItems((prev) => prev.map((a) => (a.id === automationId ? { ...a, last_status: stopped ? 'stopped' : a.last_status } : a)));
    });
    const offRuns = onAutomationRuns.on(({ automationId, runs: list }) => {
      if (runsForRef.current?.id === automationId) setRuns(list);
    });
    const offFinished = onAutomationRunFinished.on(() => { listAutomations(); });
    const offError = onAutomationError.on(({ error: e }) => setError(e));
    return () => { offList(); offUpdated(); offDeleted(); offStarted(); offStopped(); offRuns(); offError(); offFinished(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, refresh]);

  const openRuns = useCallback((a: AutomationInfo) => {
    setRunsFor(a);
    setRuns([]);
    listAutomationRuns(a.id, 50);
  }, [listAutomationRuns]);

  const confirmDelete = useCallback((a: AutomationInfo) => {
    Alert.alert('Delete automation', `Delete “${a.name}”? Past runs stay in history.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteAutomation(a.id) },
    ]);
  }, [deleteAutomation]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: c.text }]}>Automations</Text>
        <TouchableOpacity
          onPress={() => { tapLight(); setEditing('new'); }}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="New automation"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="add" size={24} color={c.accent} />
        </TouchableOpacity>
      </View>

      <DomainErrorBar domains={['projects', 'automation']} />

      {error ? (
        <View style={[styles.errorBar, { backgroundColor: c.surface2 }]}>
          <Text style={[styles.errorText, { color: c.error }]} numberOfLines={2}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)} accessibilityLabel="Dismiss error">
            <Ionicons name="close-circle" size={16} color={c.textSecondary} />
          </TouchableOpacity>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.list}>
        {loading ? (
          <View style={styles.empty}>
            <ActivityIndicator color={c.accent} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: c.textSecondary }]}>
              No automations yet. Scheduled and event-driven agent runs live here.
            </Text>
          </View>
        ) : (
          items.map((a) => (
            <View key={a.id} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <View style={styles.cardHead}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                    {a.name}
                    {a.origin === 'agent' ? '  · agent' : ''}
                  </Text>
                  <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={1}>
                    {triggerLabel(a)} · {a.harness.replace('_', ' ')}
                    {a.model ? ` · ${a.model}` : ''}
                  </Text>
                </View>
                <Switch
                  value={a.enabled}
                  onValueChange={(v) => setAutomationEnabled(a.id, v)}
                  trackColor={{ true: c.accent, false: c.border }}
                  accessibilityLabel={`Toggle ${a.name}`}
                />
              </View>
              <Text style={[styles.prompt, { color: c.textSecondary }]} numberOfLines={2}>
                {a.prompt}
              </Text>
              <Text style={[styles.meta, { color: c.textSecondary }]}>
                Last run {timeAgo(a.last_run_at)}
                {a.last_status ? ` · ${a.last_status}` : ''}
              </Text>
              <View style={styles.actions}>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: c.surface2 }]}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Run ${a.name} now`}
                  onPress={() => runAutomationNow(a.id)}
                >
                  <Ionicons name="play" size={14} color={c.accent} />
                  <Text style={[styles.actionText, { color: c.text }]}>Run now</Text>
                </TouchableOpacity>
                {a.last_status === 'running' ? (
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: c.surface2 }]}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Stop ${a.name}`}
                    onPress={() => stopAutomationRun(a.id)}
                  >
                    <Ionicons name="stop" size={14} color={c.error} />
                    <Text style={[styles.actionText, { color: c.text }]}>Stop</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: c.surface2 }]}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${a.name} run history`}
                  onPress={() => openRuns(a)}
                >
                  <Ionicons name="time-outline" size={14} color={c.text} />
                  <Text style={[styles.actionText, { color: c.text }]}>Runs</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: c.surface2 }]}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${a.name}`}
                  onPress={() => setEditing(a)}
                >
                  <Ionicons name="create-outline" size={14} color={c.text} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: c.surface2 }]}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${a.name}`}
                  onPress={() => confirmDelete(a)}
                >
                  <Ionicons name="trash-outline" size={14} color={c.error} />
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* Run history */}
      <Modal visible={runsFor != null} transparent animationType="slide" onRequestClose={() => setRunsFor(null)}>
        <View style={[styles.modalScrim, { backgroundColor: c.scrim }]}>
          <View style={[styles.sheet, { backgroundColor: c.elevated }]}>
            <Text style={[styles.sheetTitle, { color: c.text }]}>{runsFor?.name} — runs</Text>
            <ScrollView style={styles.runsList}>
              {runs.length === 0 ? (
                <Text style={[styles.emptyText, { color: c.textSecondary }]}>No runs yet.</Text>
              ) : (
                runs.map((r) => (
                  <TouchableOpacity
                    key={r.id}
                    style={[styles.runRow, { backgroundColor: c.surface2 }]}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Run ${r.status} — open log`}
                    onPress={() => {
                      if (!r.chat_session_id) return;
                      const sid = r.chat_session_id;
                      // A finished run's chat is INACTIVE on the desktop —
                      // spawn it so the log is live and follow-up sends land.
                      spawnSession(sid);
                      setRunsFor(null);
                      navigation.navigate('SessionDetail', {
                        sessionId: sid,
                        session: {
                          id: sid, projectId: '', projectName: '', title: `${runsFor?.name ?? 'Automation'} run`,
                          status: 'idle', provider: '', model: '', lastActivity: r.started_at * 1000,
                          isLive: false, starred: false, unread: false,
                        },
                      });
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                        {r.status} · {timeAgo(r.started_at)} {r.source ? `(${r.source})` : ''}
                      </Text>
                      <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={2}>
                        {r.summary || '—'}
                      </Text>
                    </View>
                    {r.chat_session_id ? <Ionicons name="chevron-forward" size={14} color={c.textSecondary} /> : null}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: c.surface2 }]}
              onPress={() => setRunsFor(null)}
              accessibilityLabel="Close runs"
            >
              <Text style={[styles.actionText, { color: c.text }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Create / edit */}
      {editing ? (
        <AutomationForm
          initial={editing === 'new' ? null : editing}
          harnesses={harnesses}
          onClose={() => setEditing(null)}
          onSave={(input) => {
            if (editing === 'new') createAutomation(input);
            else updateAutomation(editing.id, input);
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

function AutomationForm({
  initial,
  harnesses,
  onClose,
  onSave,
}: {
  initial: AutomationInfo | null;
  harnesses: { id: string; display_name: string; installed: boolean }[];
  onClose: () => void;
  onSave: (input: Record<string, unknown>) => void;
}) {
  const c = theme.colors;
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [harness, setHarness] = useState(initial?.harness ?? harnesses.find((h) => h.installed)?.id ?? 'claude_code');
  const [model, setModel] = useState(initial?.model ?? '');
  const [schedule, setSchedule] = useState(initial?.schedule ?? '0 9 * * *');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const save = () => {
    if (!name.trim() || !prompt.trim()) return;
    onSave({
      name: name.trim(),
      prompt: prompt.trim(),
      harness,
      model: model.trim() || null,
      cwd: initial?.cwd || null,
      schedule: schedule.trim(),
      enabled,
      origin: 'user',
      trigger_type: initial?.trigger_type ?? 'cron',
    });
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalScrim, { backgroundColor: c.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: c.elevated }]}>
          <Text style={[styles.sheetTitle, { color: c.text }]}>
            {initial ? 'Edit automation' : 'New automation'}
          </Text>
          <TextInput
            style={[styles.input, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
            placeholder="Name"
            placeholderTextColor={c.textSecondary}
            value={name}
            onChangeText={setName}
            accessibilityLabel="Automation name"
          />
          <TextInput
            style={[styles.input, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }, styles.promptInput]}
            placeholder="Prompt to run"
            placeholderTextColor={c.textSecondary}
            value={prompt}
            onChangeText={setPrompt}
            multiline
            accessibilityLabel="Automation prompt"
          />
          <Text style={[styles.fieldLabel, { color: c.textSecondary }]}>Agent</Text>
          <View style={styles.harnessRow}>
            {harnesses.filter((h) => h.installed).map((h) => (
              <TouchableOpacity
                key={h.id}
                style={[styles.harnessChip, { backgroundColor: harness === h.id ? c.accent : c.surface2 }]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Agent ${h.display_name}`}
                onPress={() => setHarness(h.id)}
              >
                <Text style={[styles.harnessChipText, { color: harness === h.id ? c.white : c.text }]}>
                  {h.display_name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={[styles.input, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
            placeholder="Model (blank = agent default)"
            placeholderTextColor={c.textSecondary}
            value={model}
            onChangeText={setModel}
            accessibilityLabel="Automation model"
          />
          <TextInput
            style={[styles.input, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
            placeholder="Cron (m h dom mon dow)"
            placeholderTextColor={c.textSecondary}
            value={schedule}
            onChangeText={setSchedule}
            autoCapitalize="none"
            accessibilityLabel="Cron schedule"
          />
          <View style={styles.enabledRow}>
            <Text style={{ color: c.text, fontSize: 14 }}>Enabled</Text>
            <Switch value={enabled} onValueChange={setEnabled} trackColor={{ true: c.accent, false: c.border }} />
          </View>
          <View style={styles.formActions}>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: c.surface2 }]}
              onPress={onClose}
              accessibilityLabel="Cancel"
            >
              <Text style={[styles.actionText, { color: c.text }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: c.accent }]}
              onPress={save}
              disabled={!name.trim() || !prompt.trim()}
              accessibilityLabel="Save automation"
            >
              <Text style={[styles.actionText, { color: c.white }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    margin: 12,
    padding: 10,
    borderRadius: 10,
  },
  errorText: { flex: 1, fontSize: 12 },
  list: { padding: 12, gap: 10, paddingBottom: 40 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 11 },
  prompt: { fontSize: 13 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  actionText: { fontSize: 12, fontWeight: '600' },
  empty: { paddingVertical: 48, alignItems: 'center' },
  emptyText: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32 },
  modalScrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    gap: 10,
    maxHeight: '88%',
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  runsList: { maxHeight: 400, gap: 8 },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, padding: 12 },
  primaryBtn: { borderRadius: theme.radius.pill, paddingHorizontal: 18, paddingVertical: 10, alignItems: 'center' },
  input: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 11, fontSize: 14 },
  promptInput: { minHeight: 84, textAlignVertical: 'top' },
  fieldLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 2 },
  harnessRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  harnessChip: { borderRadius: theme.radius.pill, paddingHorizontal: 11, paddingVertical: 6 },
  harnessChipText: { fontSize: 12, fontWeight: '600' },
  enabledRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
});
