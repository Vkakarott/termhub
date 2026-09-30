import { render } from '@testing-library/react-native';

/** The screens the bar was given, in order: the real navigator needs a whole app around it. */
const mockScreens: { name: string; title: string }[] = [];
jest.mock('expo-router', () => {
  const Tabs = ({ children }: { children: unknown }) => children;
  Tabs.Screen = ({ name, options }: { name: string; options: { title: string } }) => {
    mockScreens.push({ name, title: options.title });
    return null;
  };
  return { Tabs };
});
jest.mock('@/features/notifications/viewmodel/useNotificationsStore', () => ({ useNotificationsStore: () => 0 }));

import TabsLayout from '../app/(tabs)/_layout';

it('puts Home first, where the app opens, then Chats (TER-541)', async () => {
  await render(<TabsLayout />);
  expect(mockScreens.map((s) => [s.name, s.title])).toEqual([
    ['index', 'Home'],
    ['chats', 'Chats'],
    ['notifications', 'Notificações'],
    ['progress', 'Progresso'],
    ['settings', 'Ajustes'],
  ]);
});
