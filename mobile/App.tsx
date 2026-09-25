import React, { useEffect, useMemo, useState } from 'react';
import { AppState, Text, StyleSheet, TouchableOpacity, View, Alert } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme, theme } from './src/theme';
import { navigationRef } from './src/lib/navigation';
import AppDrawer, { DrawerProvider } from './src/components/AppDrawer';
import { tapMedium } from './src/lib/haptics';
import { initDeepLinkHandling } from './src/lib/deepLinks';
import { authenticate, markBackgrounded, shouldLockOnResume, deviceCanAuthenticate, appLockPlatformName } from './src/lib/appLock';
import { useRelay } from './src/hooks/useRelay';
import HomeScreen from './src/screens/HomeScreen';
import SessionChat from './src/screens/SessionChat';
import ArtifactsScreen from './src/screens/ArtifactsScreen';
import CostScreen from './src/screens/CostScreen';
import AutomationsScreen from './src/screens/AutomationsScreen';
import MemoryScreen from './src/screens/MemoryScreen';
import SkillsScreen from './src/screens/SkillsScreen';
import GitScreen from './src/screens/GitScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';
import TerminalScreen from './src/screens/TerminalScreen';
// Eager import on purpose: React.lazy + Metro's SDK 57 dev segment splitting
// crashes the settings tab on Android devices ("Cannot read property … " red
// box on the segment fetch), while web is unaffected. The screen's own module
// graph is small enough that eager evaluation costs cold start nothing
// meaningful — and QrScanModal's lazy import already loaded on Settings mount
// anyway, so the old deferral never actually deferred anything.
import SettingsScreen from './src/screens/SettingsScreen';

const HomeStack = createNativeStackNavigator();

/**
 * ChatGPT-app layout: the app opens straight into the conversation experience.
 * The Home tab holds the "new chat" home, which pushes SessionDetail for any
 * conversation; the slide-in drawer (not a session-list tab) is the primary
 * history surface. Settings stays reachable via a minimal two-tab bar and is
 * also linked from the drawer's bottom rows.
 */
function HomeStackScreen() {
  return (
    <HomeStack.Navigator screenOptions={{ headerShown: false, animation: "none" }}>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} />
      <HomeStack.Screen name="SessionDetail" component={SessionChat} />
      <HomeStack.Screen name="Artifacts" component={ArtifactsScreen} />
      <HomeStack.Screen name="Automations" component={AutomationsScreen} />
      <HomeStack.Screen name="Memory" component={MemoryScreen} />
      <HomeStack.Screen name="Skills" component={SkillsScreen} />
      <HomeStack.Screen name="Git" component={GitScreen} />
      <HomeStack.Screen name="Terminal" component={TerminalScreen} />
      <HomeStack.Screen name="Notifications" component={NotificationsScreen} />
      <HomeStack.Screen name="Settings" component={SettingsScreen} />
      <HomeStack.Screen name="CostDashboard" component={CostScreen} />
    </HomeStack.Navigator>
  );
}

// Bottom nav removed per user direction: the composer owns the bottom
// edge (desktop parity). The Tab navigator stays as invisible routing so the
// drawer's Settings/Artifacts rows keep working.

function AppShell() {
  const { isDark } = useTheme();
  const c = theme.colors;
  const { connect, applyPairingToken, connected } = useRelay();

  // relay:// deep links (QR-free pairing from e.g. a desktop-shown link):
  // a link with a host carries a full connect URL; a token-only link
  // (`relay://connect#<token>`) must NOT hit connect() as a URL (it would
  // overwrite the stored relay URL with the bare token) — it goes to the
  // pairing-token flow instead.
  useEffect(() => {
    return initDeepLinkHandling(
      (url) => {
        if (!url) return;
        // A deep link repoints this phone at an arbitrary relay host — a
        // malicious link could serve fake sessions and harvest approvals.
        // Confirm before connecting (audit M19).
        const host = url.split('#')[0].replace(/^ws(s?):\/\//, '');
        Alert.alert('Connect to relay?', 'Connect this phone to ' + host + '?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Connect', onPress: () => connect(url) },
        ]);
      },
      (token) => {
        if (token) applyPairingToken(token);
      },
    );
  }, [connect, applyPairingToken]);

  // App lock: when enabled, backgrounding the app arms the gate; returning
  // after the grace window requires Face ID / fingerprint / passcode. The
  // phone can approve shell commands on the desktop — an unlocked phone in
  // someone else's hands is otherwise a remote shell in theirs.
  const [locked, setLocked] = useState(false);
  const [hasBiometrics, setHasBiometrics] = useState(false);
  useEffect(() => {
    void deviceCanAuthenticate().then(setHasBiometrics);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        markBackgrounded();
      } else if (state === 'active') {
        void shouldLockOnResume().then((should) => {
          if (should) setLocked(true);
        });
      }
    });
    return () => sub.remove();
  }, []);

  const unlock = () => {
    tapMedium();
    void authenticate('Unlock Relay').then((ok) => {
      if (ok) setLocked(false);
    });
  };

  // Bridge the Relay theme onto react-navigation's theme so screens pushed by
  // the native stack (and native chrome) match the app's warm-neutral palette.
  const navTheme = useMemo(
    () => ({
      ...(isDark ? DarkTheme : DefaultTheme),
      colors: {
        ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
        primary: c.accent,
        background: c.background,
        card: c.surface,
        text: c.text,
        border: c.border,
        notification: c.accent,
      },
    }),
    [isDark, c],
  );

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <NavigationContainer ref={navigationRef} theme={navTheme}>
        {/* Plain wrapper so the drawer overlay can stack above the navigator
            while still living inside the container's navigation context. */}
        <View style={styles.shell}>
          <HomeStackScreen />
          {/* Global drawer overlay — above everything. */}
          <AppDrawer />
          {/* App-lock gate — above even the drawer. */}
          {locked && (
            <View style={[styles.lockGate, { backgroundColor: c.background }]}>
              <View style={[styles.lockGlyph, { backgroundColor: c.accent }]}>
                <Text style={[styles.lockGlyphText, { color: '#FFFFFF' }]}>R</Text>
              </View>
              <Text style={[theme.type.title, { color: c.text, marginTop: 16 }]}>Relay is locked</Text>
              <Text style={[theme.type.secondary, { color: c.textSecondary, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 }]}>
                {hasBiometrics
                  ? `Unlock with ${appLockPlatformName} to reach your desktop agent.`
                  : 'Unlock to reach your desktop agent.'}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Unlock Relay"
                onPress={unlock}
                style={[styles.lockButton, { backgroundColor: c.accent }]}
              >
                <Text style={[theme.type.label, { color: '#FFFFFF' }]}>Unlock</Text>
              </TouchableOpacity>
              {connected && (
                <Text style={[theme.type.label, { color: c.textSecondary, marginTop: 20 }]}>
                  Desktop connected — sessions keep running.
                </Text>
              )}
            </View>
          )}
        </View>
      </NavigationContainer>
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      {/* SafeAreaProvider must sit above every screen: the tab bar, drawer,
          and composer all read useSafeAreaInsets(). Without it the first
          consumer throws "No safe area value available" at render. */}
      <SafeAreaProvider>
        <DrawerProvider>
          <AppShell />
        </DrawerProvider>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  lockGate: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockGlyph: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockGlyphText: { fontSize: 28, fontWeight: '700' },
  lockButton: {
    marginTop: 24,
    paddingVertical: 12,
    paddingHorizontal: 40,
    borderRadius: theme.radius.pill,
  },
});
