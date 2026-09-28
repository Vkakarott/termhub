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
