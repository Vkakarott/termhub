/**
 * Shared visual language for the floating room card and the wall nameplate — one identity system,
 * two surfaces (UI badge vs. architectural plaque).
 */
export const ID = {
  font: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  bg: 0x151820,
  bgDeep: 0x0f1115,
  line: 0x2a2f3a,
  lineBright: 0x3d465a,
  fg: 0xe6e8ee,
  muted: 0x9aa1b1,
  dim: 0x6b7384,
  /** Brand accent — quiet stripe / focus, not alarm. */
  accent: 0x5b63d3,
  /** Soft urgency for the needs-you pill (less loud than the desk markers). */
  warn: 0xd4a06a,
  warnInk: 0x1a140c,
} as const;

export const idText = (size: number, fill: number, weight: '500' | '600' | '700' = '600') => ({
  fontSize: size,
  fill,
  fontWeight: weight,
  fontFamily: ID.font,
  letterSpacing: 0.15,
});
