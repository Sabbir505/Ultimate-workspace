/**
 * DomainErrorBar — dismissible error strip for the non-chat relay domains.
 *
 * The desktop answers a failed list/read with ChatError tagged with the
 * domain name (git, memory, skills, projects, budgets, sessions, artifacts,
 * session-chat…). Before this existed those frames fell into the session-only
 * bus, so a failed screen just looked empty. Each screen mounts this with
 * the domains it cares about and the user sees why the page is empty.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { onDomainError } from '../hooks/useRelay';

export default function DomainErrorBar({ domains }: { domains: string[] }) {
  const c = theme.colors;
  const [error, setError] = useState<string | null>(null);
  const wanted = new Set(domains);

  useEffect(() => {
    const off = onDomainError.on(({ domain, error: msg }) => {
      if (wanted.has(domain)) setError(msg);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domains.join(',')]);

  if (!error) return null;
  return (
    <View style={[styles.bar, { backgroundColor: c.surface2 }]}>
      <Ionicons name="alert-circle-outline" size={15} color={c.error} />
      <Text style={[styles.text, { color: c.error }]} numberOfLines={3}>{error}</Text>
      <TouchableOpacity onPress={() => setError(null)} accessibilityLabel="Dismiss error" hitSlop={8}>
        <Ionicons name="close-circle" size={16} color={c.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
  },
  text: { flex: 1, fontSize: 12 },
});
