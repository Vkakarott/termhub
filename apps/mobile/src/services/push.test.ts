import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { expoPushToken, pushConversationId, pushNotificationId } from './push';

// A getter, so the switch reaches `push.ts` through Babel's namespace copy of the module.
jest.mock('expo-device', () => {
  let isDevice = true;
  return {
    get isDevice() {
      return isDevice;
    },
    __setIsDevice: (v: boolean) => {
      isDevice = v;
    },
  };
});

const config = Constants.expoConfig as { extra?: unknown };
const setIsDevice = (Device as unknown as { __setIsDevice(v: boolean): void }).__setIsDevice;
const notifications = Notifications as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  config.extra = { eas: { projectId: 'project-1' } };
  setIsDevice(true);
  jest.clearAllMocks();
});

afterAll(() => {
  delete config.extra;
});

describe('expoPushToken', () => {
  it('creates the Android channel, then returns the token for the EAS project', async () => {
    expect(await expoPushToken()).toBe('ExponentPushToken[jest]');
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith('default', expect.objectContaining({ name: 'Notificações' }));
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('asks for the permission when not granted yet, and gives up when refused', async () => {
    notifications.getPermissionsAsync!.mockResolvedValueOnce({ status: 'undetermined' });
    notifications.requestPermissionsAsync!.mockResolvedValueOnce({ status: 'denied' });
    expect(await expoPushToken()).toBeNull();
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('has no token on a simulator or without an EAS project id', async () => {
    setIsDevice(false);
    expect(await expoPushToken()).toBeNull();
    setIsDevice(true);
    config.extra = {};
    expect(await expoPushToken()).toBeNull();
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });
});

it('pushConversationId reads data.conversation_id, and nothing else', () => {
  expect(pushConversationId({ kind: 'reply', conversation_id: 'c1', project_id: null })).toBe('c1');
  expect(pushConversationId({ kind: 'device_request' })).toBeNull();
  expect(pushConversationId({ conversation_id: '' })).toBeNull();
  expect(pushConversationId({ conversation_id: 42 })).toBeNull();
  expect(pushConversationId(null)).toBeNull();
});

it('pushNotificationId reads data.notification_id, when the server sent one', () => {
  expect(pushNotificationId({ kind: 'reply', conversation_id: 'c1', notification_id: 'n1' })).toBe('n1');
  expect(pushNotificationId({ kind: 'reply', conversation_id: 'c1' })).toBeNull();
});
