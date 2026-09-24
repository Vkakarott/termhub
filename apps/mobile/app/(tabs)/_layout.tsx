import { Tabs } from 'expo-router';

/** The three tabs of spec §11.2. */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: '#0F1320', borderTopColor: '#1F2433' },
        tabBarActiveTintColor: '#7C87F7',
        tabBarInactiveTintColor: '#9CA3AF',
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Chats' }} />
      <Tabs.Screen name="notifications" options={{ title: 'Notificações' }} />
      <Tabs.Screen name="settings" options={{ title: 'Ajustes' }} />
    </Tabs>
  );
}
