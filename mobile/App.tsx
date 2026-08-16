import React, { useMemo, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const Home = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="home" size={size} color={color} />;
const Settings = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="settings" size={size} color={color} />;
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme } from './src/theme';
import BottomNav from './src/components/BottomNav';
import HomeScreen from './src/screens/HomeScreen';
import SessionChat from './src/screens/SessionChat';
// M1 (PERFORMANCE_AUDIT.md): lazy-load the Settings screen — Metro cannot
// code-split, but React.lazy defers module evaluation until the tab is first
// rendered, keeping its ~15-25 KB of factory work off the cold-start path.
const SettingsScreen = React.lazy(() => import('./src/screens/SettingsScreen'));

const Tab = createBottomTabNavigator();
const HomeStack = createNativeStackNavigator();

/**
 * Cursor-style layout: tapping a session opens it as a chat conversation.
 * There is no separate Chat / Inbox tab — sessions ARE the chat, and
 * approvals render inline in the stream.
 */
function HomeStackScreen() {
  return (
    <HomeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} />
      <HomeStack.Screen name="SessionDetail" component={SessionChat} />
    </HomeStack.Navigator>
  );
}

function AppTabs() {
  const { isDark } = useTheme();

  const tabBar = useMemo(() => (props: any) => <BottomNav {...props} />, []);

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <NavigationContainer>
        <Tab.Navigator tabBar={tabBar} screenOptions={{ headerShown: false }}>
          <Tab.Screen name="Home" component={HomeStackScreen}
            options={{ tabBarLabel: 'Home', tabBarIcon: ({ color, size }: any) => <Home size={size} color={color} /> }} />
          <Tab.Screen name="Settings"
            options={{ tabBarLabel: 'Settings', tabBarIcon: ({ color, size }: any) => <Settings size={size} color={color} /> }}>
            {() => (
              <React.Suspense fallback={null}>
                <SettingsScreen />
              </React.Suspense>
            )}
          </Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppTabs />
    </ThemeProvider>
  );
}
