import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRelay } from '../hooks/useRelay';
import { theme, useTheme } from '../theme';
import ConnectionIndicator from '../components/ConnectionIndicator';
import { collectProjects, harnessLabel, useCreateSessionFlow, useDrawer } from '../components/AppDrawer';
import QrScanModal from './QrScanModal';
import { tapLight, tapMedium } from '../lib/haptics';

/**
 * ChatGPT-style "new chat" home: a quiet centered greeting, one prominent
 * New chat action, and quick-start rows generated from the projects already
 * seen on the desktop. Chat history lives in the drawer, not here.
 */

export default function HomeScreen() {
  const { connected, sessions, connect } = useRelay();
  const { open, openNewChat } = useDrawer();
  useTheme(); // subscribe so theme.colors is reactive
  const c = theme.colors;

  const [qrVisible, setQrVisible] = useState(false);
  const start = useCreateSessionFlow();

  // Kick the persisted relay URL on mount (no-op when already connected).
  useEffect(() => { connect(); }, [connect]);

  // Quick-start suggestions: up to 4 recent projects from the session list.
  const projects = useMemo(() => collectProjects(sessions).slice(0, 4), [sessions]);

  return (
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

      <ScrollView contentContainerStyle={styles.body} bounces={false}>
        {/* Centered empty state */}
        <View style={styles.hero}>
          <View style={[styles.glyph, { backgroundColor: c.accent }]}>
            <Text style={[styles.glyphText, { color: c.white }]}>R</Text>
          </View>
          <Text style={[styles.greeting, { color: c.text }, theme.type.title]}>
            What are we building?
          </Text>
          <Text style={[styles.tagline, { color: c.textSecondary }, theme.type.secondary]}>
            Your desktop agent is right here.
          </Text>
        </View>

        {connected ? (
          <>
            {/* Prominent New chat */}
            <TouchableOpacity
              style={[styles.newChatButton, { backgroundColor: c.accent }]}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="New chat"
              onPress={() => { tapMedium(); openNewChat(); }}
            >
              <Ionicons name="create-outline" size={18} color={c.white} />
              <Text style={[styles.newChatButtonText, theme.type.body, { color: c.white }]}>
                New chat
              </Text>
            </TouchableOpacity>

            {/* Quick-start rows from recent projects */}
            {projects.length > 0 && (
              <View style={styles.quickStarts}>
                {projects.map((p) => (
                  <TouchableOpacity
                    key={p.id || p.name}
                    style={[styles.quickStartRow, { backgroundColor: c.surface2, borderColor: c.border }]}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Continue ${p.name}`}
                    onPress={() => { tapLight(); start(p.id, p.provider); }}
                  >
                    <View style={[styles.quickStartIcon, { backgroundColor: c.bubble }]}>
                      <Ionicons name="folder-outline" size={16} color={c.accent} />
                    </View>
                    <View style={styles.quickStartText}>
                      <Text numberOfLines={1} style={[styles.quickStartName, { color: c.text }, theme.type.body]}>
                        {p.name}
                      </Text>
                      <Text numberOfLines={1} style={[{ color: c.textSecondary }, theme.type.secondary]}>
                        Continue with {harnessLabel(p.provider)}
                      </Text>
                    </View>
                    <Ionicons name="arrow-forward" size={16} color={c.textSecondary} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        ) : (
          /* Offline: pairing explainer + QR scan entry */
          <View style={[styles.offlineCard, { backgroundColor: c.surface2, borderColor: c.border }]}>
            <Ionicons name="cloud-offline-outline" size={28} color={c.textSecondary} />
            <Text style={[styles.offlineTitle, { color: c.text }, theme.type.title]}>
              Pair with your desktop
            </Text>
            <Text style={[styles.offlineBody, { color: c.textSecondary }, theme.type.secondary]}>
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
              <Text style={[styles.scanButtonText, theme.type.body, { color: c.white }]}>
                Scan QR
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <QrScanModal
        visible={qrVisible}
        onClose={() => setQrVisible(false)}
        onScanned={(url) => { connect(url); setQrVisible(false); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
  // hero
  hero: { alignItems: 'center', paddingTop: '22%', paddingBottom: theme.spacing.xl },
  glyph: {
    width: 56,
    height: 56,
    borderRadius: theme.radius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  },
  glyphText: { fontSize: 26, fontWeight: '800' },
  greeting: { fontSize: 22, marginBottom: theme.spacing.xs },
  tagline: { textAlign: 'center' },
  // new chat
  newChatButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingVertical: 13,
    borderRadius: theme.radius.pill,
  },
  newChatButtonText: { fontWeight: '600' },
  // quick starts
  quickStarts: { marginTop: theme.spacing.lg, gap: theme.spacing.sm },
  quickStartRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 2,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
  },
  quickStartIcon: {
    width: 30,
    height: 30,
    borderRadius: theme.radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickStartText: { flex: 1 },
  quickStartName: { fontWeight: '500' },
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
