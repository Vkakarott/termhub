import type { NotificationStatus } from '@/services/push';
import type { TrackingStatus } from '@/services/tracking';

export type { NotificationStatus, TrackingStatus };
export type AdConsent = 'unknown' | 'granted' | 'denied';

export interface PermissionsDeps {
  platform: 'ios' | 'android';
  notificationStatus(): Promise<NotificationStatus>;
  requestNotifications(): Promise<NotificationStatus>;
  trackingStatus(): Promise<TrackingStatus>;
  requestTracking(): Promise<TrackingStatus>;
  setAdConsent(granted: boolean): Promise<void>;
  openSystemSettings(): Promise<void>;
}

export interface PermissionsState {
  /** Persisted. */
  firstMessageSent: boolean;
  pushPrimerDismissals: number;
  adConsent: AdConsent;
  /** Memory only. */
  platform: 'ios' | 'android';
  pushPrimerOpen: boolean;
  notificationStatus: NotificationStatus | null;
  trackingStatus: TrackingStatus | null;

  refreshStatuses(): Promise<void>;
  maybeOpenPushPrimer(): Promise<void>;
  acceptPush(): Promise<void>;
  dismissPush(): void;
  acceptAds(): Promise<void>;
  declineAds(): Promise<void>;
  setAdsFromSettings(on: boolean): Promise<void>;
  syncAdConsent(): Promise<void>;
  openSystemSettings(): Promise<void>;
}
