import Constants from 'expo-constants';

/**
 * The server the app talks to. A constant in production (spec §11.1): test builds point elsewhere
 * through the EAS build-time variable `EXPO_PUBLIC_TERMHUB_URL` (see eas.json), never through a
 * screen. `expo start` reads it from a local `.env`.
 */
export const TERMHUB_URL = (process.env.EXPO_PUBLIC_TERMHUB_URL || 'https://termhub.dev').replace(/\/+$/, '');

/** Mobile API prefix (spec §6) and the chat socket (spec §6.1). */
export const MOBILE_API_URL = `${TERMHUB_URL}/api/m/v1`;
export const MOBILE_WS_URL = `${TERMHUB_URL.replace(/^http/, 'ws')}/ws/m/chat?v=1`;

/** The URL scheme the push payloads deep-link into (`termhub://chat/<conversation_id>`). */
export const APP_SCHEME = (Constants.expoConfig?.scheme as string | undefined) ?? 'termhub';
