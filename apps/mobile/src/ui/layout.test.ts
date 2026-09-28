import { isWide, MAX_READABLE_WIDTH, readableColumn, SHEET_MAX_WIDTH, SPLIT_LIST_WIDTH, WIDE_MIN_WIDTH } from './layout';

describe('layout', () => {
  it('is wide from 700 pt: the iPad mini in portrait (744) splits, Slide Over and iPhones do not', () => {
    expect(WIDE_MIN_WIDTH).toBe(700);
    expect(isWide(320)).toBe(false); // Slide Over
    expect(isWide(390)).toBe(false); // iPhone
    expect(isWide(699)).toBe(false);
    expect(isWide(700)).toBe(true);
    expect(isWide(744)).toBe(true); // iPad mini, portrait
    expect(isWide(1024)).toBe(true);
  });

  it('leaves the conversation at least 380 pt next to the list', () => {
    expect(WIDE_MIN_WIDTH - SPLIT_LIST_WIDTH).toBeGreaterThanOrEqual(380);
    expect(MAX_READABLE_WIDTH).toBe(720);
    expect(SHEET_MAX_WIDTH).toBe(560);
  });

  it('centres a full-width column capped at the given width', () => {
    expect(readableColumn(MAX_READABLE_WIDTH)).toEqual({ width: '100%', maxWidth: 720, alignSelf: 'center' });
    expect(readableColumn(SHEET_MAX_WIDTH)).toEqual({ width: '100%', maxWidth: 560, alignSelf: 'center' });
  });
});
