import { getAnalytics, logScreenView } from '@react-native-firebase/analytics';

/** Logs a `screen_view` for an expo-router route pattern, e.g. `/chat/[id]`. Never throws. */
export function logScreen(route: string): void {
  try {
    logScreenView(getAnalytics(), { screen_name: route, screen_class: route }).catch(() => undefined);
  } catch {
    // Native module missing (e.g. an old dev client): analytics must never break the app.
  }
}
