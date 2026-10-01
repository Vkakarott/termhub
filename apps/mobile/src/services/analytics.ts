import { getAnalytics, logScreenView, setConsent } from '@react-native-firebase/analytics';

/** Logs a `screen_view` for an expo-router route pattern, e.g. `/chat/[id]`. Never throws. */
export function logScreen(route: string): void {
  try {
    logScreenView(getAnalytics(), { screen_name: route, screen_class: route }).catch(() => undefined);
  } catch {
    // Native module missing (e.g. an old dev client): analytics must never break the app.
  }
}

/** Google's ad consent signals (permission prompts spec §3.3): all three follow the person's
 * choice; analytics storage stays on (screen views are first-party). Never throws. */
export async function setAdConsent(granted: boolean): Promise<void> {
  try {
    await setConsent(getAnalytics(), { ad_storage: granted, ad_user_data: granted, ad_personalization: granted, analytics_storage: true });
  } catch {
    // Native module missing: the defaults in firebase.json (denied) stay in force.
  }
}
