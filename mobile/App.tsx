import React, { useMemo, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Home, MessageSquare, Bell, Settings } from 'lucide-react-native';
import { StatusBar } from 'expo-status-bar';
import { useRelay } from './src/hooks/useRelay';
import { ThemeProvider, useTheme } from './src/theme';
import { getUseChatSession } from './src/lib/featureFlags';
import BottomNav from './src/components/BottomNav';
import HomeScreen from './src/screens/HomeScreen';
import SessionScreen from './src/screens/SessionScreen';
import ChatScreen from './src/screens/ChatScreen';
import ApprovalsScreen from './src/screens/ApprovalsScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Tab = createBottomTabNavigator();
const HomeStack = createNativeStackNavigator();

function HomeStackScreen() {
  return (
    <HomeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} />
      <HomeStack.Screen name="SessionDetail" component={SessionScreen} />
    </HomeStack.Navigator>
  );
}

function AppTabs() {
  const { sessions } = useRelay();
  const { isDark } = useTheme();
  // Inbox badge = live sessions paused on user input or diff review.
  const badgeCount = sessions.filter(
    s => s.isLive && (s.status === 'waiting' || s.status === 'diff_ready')
  ).length;

  const tabBar = useMemo(() => (props: any) => <BottomNav {...props} badgeCount={badgeCount} />, [badgeCount]);

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <NavigationContainer>
        <Tab.Navigator tabBar={tabBar} screenOptions={{ headerShown: false }}>
          <Tab.Screen name="Home" component={HomeStackScreen}
            options={{ tabBarLabel: 'Home', tabBarIcon: ({ color, size }: any) => <Home size={size} color={color} /> }} />
          <Tab.Screen name="Chat" component={ChatScreen}
            options={{ tabBarLabel: 'Chat', tabBarIcon: ({ color, size }: any) => <MessageSquare size={size} color={color} /> }} />
          <Tab.Screen name="Approvals" component={ApprovalsScreen}
            options={{ tabBarLabel: 'Inbox', tabBarIcon: ({ color, size }: any) => <Bell size={size} color={color} /> }} />
          <Tab.Screen name="Settings" component={SettingsScreen}
            options={{ tabBarLabel: 'Settings', tabBarIcon: ({ color, size }: any) => <Settings size={size} color={color} /> }} />
        </Tab.Navigator>
      </NavigationContainer>
    </>
  );
}

export default function App() {
  // Resolve the feature flag once on mount so the synchronous
  // `useUseChatSession()` hook can return a stable initial value.
  useEffect(() => {
    void getUseChatSession();
  }, []);
  return (
    <ThemeProvider>
      <AppTabs />
    </ThemeProvider>
  );
}