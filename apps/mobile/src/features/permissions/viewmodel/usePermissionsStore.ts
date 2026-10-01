// The app's one permissions store, over the real OS and Firebase services. Importing it (the root
// layout does, through the primer sheet) subscribes it to the session and chat signals.
import * as Device from 'expo-device';
import { setAdConsent } from '@/services/analytics';
import { notificationStatus, requestNotifications } from '@/services/push';
import { requestTracking, trackingStatus } from '@/services/tracking';
import { createPermissionsStore } from './createPermissionsStore';

let openSettings: () => Promise<void> = async () => undefined;

/** The root layout injects Linking.openSettings: viewmodels never import react-native. */
export function setSystemSettingsOpener(open: () => Promise<void>): void {
  openSettings = open;
}

export const usePermissionsStore = createPermissionsStore({
  platform: Device.osName === 'iOS' || Device.osName === 'iPadOS' ? 'ios' : 'android',
  notificationStatus,
  requestNotifications,
  trackingStatus,
  requestTracking,
  setAdConsent,
  openSystemSettings: () => openSettings(),
});
