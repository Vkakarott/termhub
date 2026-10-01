// The app's one permissions store, over the real OS and Firebase services. Importing it (the root
// layout does, through the primer sheet) subscribes it to the session and chat signals.
import * as Device from 'expo-device';
import { Linking } from 'react-native';
import { setAdConsent } from '@/services/analytics';
import { notificationStatus, requestNotifications } from '@/services/push';
import { requestTracking, trackingStatus } from '@/services/tracking';
import { createPermissionsStore } from './createPermissionsStore';

export const usePermissionsStore = createPermissionsStore({
  platform: Device.osName === 'iOS' || Device.osName === 'iPadOS' ? 'ios' : 'android',
  notificationStatus,
  requestNotifications,
  trackingStatus,
  requestTracking,
  setAdConsent,
  openSystemSettings: () => Linking.openSettings(),
});
