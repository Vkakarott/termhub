// App Tracking Transparency (permission prompts spec §3.3). iOS only: where ATT does not exist
// (Android) the status is `unavailable` and nothing prompts.
import * as ATT from 'expo-tracking-transparency';

export type TrackingStatus = 'authorized' | 'denied' | 'undetermined' | 'unavailable';

const fromOs = (status: string): TrackingStatus => (status === 'granted' ? 'authorized' : status === 'undetermined' ? 'undetermined' : 'denied');

export async function trackingStatus(): Promise<TrackingStatus> {
  if (!ATT.isAvailable()) return 'unavailable';
  return fromOs((await ATT.getTrackingPermissionsAsync()).status);
}

/** The ATT prompt: iOS shows it once per install; later calls answer the stored status. */
export async function requestTracking(): Promise<TrackingStatus> {
  if (!ATT.isAvailable()) return 'unavailable';
  return fromOs((await ATT.requestTrackingPermissionsAsync()).status);
}
