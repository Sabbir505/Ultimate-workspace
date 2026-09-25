/**
 * QuestionCard — the phone's mirror of the desktop QuestionCard. A harness
 * (claude/kimi/opencode/pi/omp/commandcode) can ask the user a question
 * mid-turn; the turn is PARKED until the answer lands, so the phone must
 * show the same card or the agent waits for a desktop visit.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity } from 'react-native';
import { theme } from '../../theme';
import type { AgentQuestion } from '../../hooks/useRelay';
import { tapLight } from '../../lib/haptics';

export interface QuestionCardProps {
  pendingId: string;
  questions: AgentQuestion[];
  onAnswer: (answers: Record<string, string | string[]>, response?: string) => void;
}

export function QuestionCard({ pendingId, questions, onAnswer }: QuestionCardProps) {
  const c = theme.colors;
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [response, setResponse] = useState('');

  useEffect(() => {
    // A NEW question resets the card.
    setPicked({});
    setResponse('');
  }, [pendingId]);

  const toggle = (q: AgentQuestion, label: string) => {
    tapLight();
    setPicked((prev) => {
      const cur = prev[q.question] ?? [];
      if (q.multiSelect) {
        return {
          ...prev,
          [q.question]: cur.includes(label)
            ? cur.filter((l) => l !== label)
            : [...cur, label],
        };
      }
      return { ...prev, [q.question]: [label] };
    });
  };

  const submit = () => {
    const answers: Record<string, string | string[]> = {};
    for (const [q, labels] of Object.entries(picked)) {
      if (labels.length === 0) continue;
      answers[q] = labels.length > 1 ? labels : labels[0]!;
    }
    tapLight();
    onAnswer(answers, response.trim() || undefined);
  };

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.accent }]}>
      <Text style={[styles.title, { color: c.accent }]}>The agent has a question</Text>
      {questions.map((q, qi) => (
        <View key={`${q.question}-${qi}`} style={styles.question}>
          {q.header ? (
            <Text style={[styles.header, { color: c.textSecondary }]}>{q.header}</Text>
          ) : null}
          <Text style={[styles.questionText, { color: c.text }]}>{q.question}</Text>
          {(q.options ?? []).map((opt) => {
            const selected = (picked[q.question] ?? []).includes(opt.label);
            return (
              <TouchableOpacity
                key={opt.label}
                style={[
                  styles.option,
                  { borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.bubble : 'transparent' },
                ]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${opt.label}${opt.description ? `: ${opt.description}` : ''}`}
                onPress={() => toggle(q, opt.label)}
              >
                <Text style={[styles.optionLabel, { color: selected ? c.accent : c.text }]}>
                  {opt.label}
                </Text>
                {opt.description ? (
                  <Text style={[styles.optionDesc, { color: c.textSecondary }]}>{opt.description}</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
      <TextInput
        style={[styles.input, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
        placeholder="Optional free-text reply"
        placeholderTextColor={c.textSecondary}
        value={response}
        onChangeText={setResponse}
        multiline
        accessibilityLabel="Free text reply"
      />
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.actionBtn}
          accessibilityRole="button"
          accessibilityLabel="Skip question"
          onPress={() => onAnswer({})}
        >
          <Text style={{ color: c.textSecondary, fontWeight: '600', fontSize: 13 }}>Skip</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: c.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Send answer"
          onPress={submit}
        >
          <Text style={{ color: c.white, fontWeight: '700', fontSize: 13 }}>Send answer</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 14,
    gap: 10,
  },
  title: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  question: { gap: 6 },
  header: { fontSize: 11, fontWeight: '700' },
  questionText: { fontSize: 14, lineHeight: 19 },
  option: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 8, gap: 2 },
  optionLabel: { fontSize: 13.5, fontWeight: '600' },
  optionDesc: { fontSize: 11.5 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, fontSize: 13.5, minHeight: 44 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  actionBtn: { paddingHorizontal: 14, paddingVertical: 9 },
  primaryBtn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: theme.radius.pill },
});

export default QuestionCard;
