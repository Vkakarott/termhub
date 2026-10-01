// The universal build (spec 2026-09-28 iPad §2.1, §2.2): Expo's `withRequiresFullScreen` writes every
// iPad orientation when the tablet is supported and full screen is not required; the iPhone keeps
// `orientation`'s portrait.
const { expo } = require('../app.json') as { expo: { orientation: string; ios: Record<string, unknown> } };

describe('app.json', () => {
  it('builds for the iPad too, with multitasking (no full-screen requirement)', () => {
    expect(expo.ios.supportsTablet).toBe(true);
    expect(expo.ios.requireFullScreen).toBeUndefined();
    expect(expo.ios.isTabletOnly).toBeUndefined();
  });

  it('keeps the iPhone in portrait', () => {
    expect(expo.orientation).toBe('portrait');
  });
});

type Plugin = string | [string, Record<string, unknown>];
const plugins = (require('../app.json') as { expo: { plugins: Plugin[] } }).expo.plugins;
const pluginOptions = (name: string) => (plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name) as [string, Record<string, unknown>] | undefined)?.[1];

describe('ad measurement (permission prompts spec §3.5)', () => {
  it('asks ATT with a pt-BR reason, and builds Firebase with the advertising id', () => {
    expect(pluginOptions('expo-tracking-transparency')?.userTrackingPermission).toMatch(/identificador de publicidade/);
    expect((pluginOptions('@react-native-firebase/analytics')?.ios as { withoutAdIdSupport?: boolean }).withoutAdIdSupport).toBe(false);
  });

  it('denies the ad signals by default, before any JS runs, and keeps analytics', () => {
    const rn = (require('../firebase.json') as { 'react-native': Record<string, boolean> })['react-native'];
    expect(rn).toEqual({
      analytics_default_allow_analytics_storage: true,
      analytics_default_allow_ad_storage: false,
      analytics_default_allow_ad_user_data: false,
      analytics_default_allow_ad_personalization_signals: false,
    });
  });

  it('only uses keys RNFirebase knows (an unknown key is silently ignored and the signal stays granted)', () => {
    // The package's `exports` hides the schema from require(), so reach it by path (hoisted to the root).
    const schema = require('../../../node_modules/@react-native-firebase/app/firebase-schema.json') as {
      properties: { 'react-native': { properties: Record<string, unknown> } };
    };
    const known = Object.keys(schema.properties['react-native'].properties);
    const rn = (require('../firebase.json') as { 'react-native': Record<string, boolean> })['react-native'];
    for (const key of Object.keys(rn)) expect(known).toContain(key);
  });
});
