import { Tabs } from 'expo-router';
import { useNotificationsStore } from '@/features/notifications/viewmodel/useNotificationsStore';

/** The three tabs of spec §11.2; Notificações carries the unread count (design spec §7). */
export default function TabsLayout() {
  const unread = useNotificationsStore((s) => s.unread);
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
      <Tabs.Screen name="notifications" options={{ title: 'Notificações', tabBarBadge: unread > 0 ? unread : undefined }} />
      <Tabs.Screen name="settings" options={{ title: 'Ajustes' }} />
    </Tabs>
  );
}
