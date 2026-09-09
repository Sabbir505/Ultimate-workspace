import React, { useEffect, useMemo, useState } from 'react';
import { AppState, Text, StyleSheet, TouchableOpacity, View } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets, SafeAreaProvider } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme, theme } from './src/theme';
import AppDrawer, { DrawerProvider } from './src/components/AppDrawer';
import { tapLight, tapMedium } from './src/lib/haptics';
import { initDeepLinkHandling } from './src/lib/deepLinks';
import { authenticate, markBackgrounded, shouldLockOnResume, deviceCanAuthenticate, appLockPlatformName } from './src/lib/appLock';
import { useRelay } from './src/hooks/useRelay';
import HomeScreen from './src/screens/HomeScreen';
import SessionChat from './src/screens/SessionChat';
// M1 (PERFORMANCE_AUDIT.md): lazy-load the Settings screen — Metro cannot
// code-split, but React.lazy defers module evaluation until the tab is first
// rendered, keeping its ~15-25 KB of factory work off the cold-start path.
const SettingsScreen = React.lazy(() => import('./src/screens/SettingsScreen'));

const Tab = createBottomTabNavigator();
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
    <HomeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} />
      <HomeStack.Screen name="SessionDetail" component={SessionChat} />
    </HomeStack.Navigator>
  );
}

// Minimal custom tab bar — Home + Settings, quiet icons, accent when active.
const TAB_ICONS: Record<string, { active: keyof typeof Ionicons.glyphMap; inactive: keyof typeof Ionicons.glyphMap }> = {
  Home: { active: 'home', inactive: 'home-outline' },
  Settings: { active: 'settings', inactive: 'settings-outline' },
};

function MinimalTabBar({ state, navigation }: any) {
  useTheme(); // subscribe so theme.colors is reactive
  const c = theme.colors;
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.tabBar,
        {
          backgroundColor: c.background,
          borderTopColor: c.border,
          paddingBottom: Math.max(insets.bottom, 8),
        },
      ]}
    >
      {state.routes.map((route: any, index: number) => {
        const isFocused = state.index === index;
        const icons = TAB_ICONS[route.name] ?? TAB_ICONS.Home;

        const onPress = () => {
          tapLight();
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        return (
          <TouchableOpacity
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={route.name === 'Home' ? 'Home' : 'Settings'}
            onPress={onPress}
            style={styles.tabItem}
          >
            <Ionicons
              name={isFocused ? icons.active : icons.inactive}
              size={22}
              color={isFocused ? c.accent : c.textSecondary}
            />
            <Text
              style={[
                styles.tabLabel,
                theme.type.label,
                { color: isFocused ? c.accent : c.textSecondary },
              ]}
            >
              {route.name}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function AppShell() {
  const { isDark } = useTheme();
  const c = theme.colors;
  const { connect, connected } = useRelay();

  // relay:// deep links (QR-free pairing from e.g. a desktop-shown link):
  // a valid relay URL connects immediately.
  useEffect(() => {
    return initDeepLinkHandling((url) => {
      if (url) connect(url);
    });
  }, [connect]);

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

  const tabBar = useMemo(() => (props: any) => <MinimalTabBar {...props} />, []);

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <NavigationContainer theme={navTheme}>
        {/* Plain wrapper so the drawer overlay can stack above the navigator
            while still living inside the container's navigation context. */}
        <View style={styles.shell}>
          <Tab.Navigator tabBar={tabBar} screenOptions={{ headerShown: false }}>
            <Tab.Screen name="Home" component={HomeStackScreen} />
            <Tab.Screen name="Settings">
              {() => (
                <React.Suspense fallback={null}>
                  <SettingsScreen />
                </React.Suspense>
              )}
            </Tab.Screen>
          </Tab.Navigator>
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
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 2,
  },
  tabLabel: { fontSize: 11 },
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
