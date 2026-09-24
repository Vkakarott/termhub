import { appHeader } from './app-header';

describe('appHeader', () => {
  it('formats platform, version and build the way the server parses them', () => {
    expect(appHeader('ios', '1.2.0', '34')).toBe('ios/1.2.0+34');
    expect(appHeader('android', '1.0', '7')).toBe('android/1.0+7');
  });
  it('falls back to zeros when the native side reports nothing usable', () => {
    expect(appHeader('ios', null, null)).toBe('ios/0.0.0+0');
    expect(appHeader('android', '1.0.0-beta', 'x')).toBe('android/0.0.0+0');
  });
});
