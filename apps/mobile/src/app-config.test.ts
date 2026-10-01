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
      google_analytics_default_allow_analytics_storage: true,
      google_analytics_default_allow_ad_storage: false,
      google_analytics_default_allow_ad_user_data: false,
      google_analytics_default_allow_ad_personalization_signals: false,
    });
  });
});
