// Push notifications through `expo-notifications` (spec §9). The server sends through the Expo Push
// Service to the token this module reads; the session store registers it (`PUT push-token`) at every
// session start, and the root layout opens the conversation a tapped push points at.
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

/** Android's channel for every push: the Expo Push Service delivers to `default` when a message names
 * none, and the server never names one. */
const ANDROID_CHANNEL = 'default';

/** A push that arrives while the app is open is still shown: the server only skips phones with a live
 * chat socket, so one that lands here is about something the screen may not be showing. */
export function configurePush(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      // Android hides the heads-up banner of a silent notification.
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * This phone's Expo push token, asking for the permission the first time; `null` on a simulator (no
 * token there), when the permission is refused, or when the build has no EAS project id.
 */
export async function expoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  // Android 13+ only shows the permission prompt once a channel exists (a no-op on iOS).
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
    name: 'Notificações',
    importance: Notifications.AndroidImportance.HIGH,
  });
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== 'granted') return null;
  const projectId: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof projectId !== 'string') return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

/** A non-empty string field of a push's `data`, or `null`. */
function dataString(data: unknown, key: string): string | null {
  if (!data || typeof data !== 'object') return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

/** The conversation a push points at (`data.conversation_id` of `confirmation`, `tab_question` and
 * `reply`), or `null` — a `device_request` names none. */
export const pushConversationId = (data: unknown): string | null => dataString(data, 'conversation_id');

/** The history row a push was sent for (`data.notification_id`), or `null` for a push from a server
 * older than that field. */
export const pushNotificationId = (data: unknown): string | null => dataString(data, 'notification_id');
