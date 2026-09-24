import { z } from 'zod';

// Excludes 0/O and 1/I/L — the letters and digits a person reads aloud from one screen to type
// into another must never be ambiguous.
export const VERIFICATION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const verificationCodeSchema = z.string().regex(new RegExp(`^[${VERIFICATION_CODE_ALPHABET}]{6}$`));

/** 'K7F2QD' -> 'K7F-2QD': the same split the app renders on screen. */
export const formatVerificationCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

/** A P-256 public key as the app exports it; anything else is refused before it reaches a signature check. */
export const p256Jwk = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().min(1), y: z.string().min(1) }).strict();

export const deviceInfo = z.object({
  platform: z.enum(['ios', 'android']),
  model: z.string().trim().min(1).max(80),
  os_version: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(60),
});

export const deviceRequestBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  public_key: p256Jwk,
  device: deviceInfo,
  app_version: z.string().regex(/^\d+\.\d+\.\d+\+\d+$/),
});
export const deviceRequestResponse = z.object({
  request_id: z.string(),
  request_secret: z.string(),
  verification_code: verificationCodeSchema,
  expires_at: z.string(),
  poll_after: z.number().int(),
});
export const devicePollResponse = z.object({ status: z.enum(['pending', 'approved', 'closed']) });
export const deviceActivateBody = z.object({ request_id: z.string().min(1).max(64), request_secret: z.string().min(1).max(128) });
export const deviceActivateResponse = z.object({ device_id: z.string(), pin_secret: z.string(), access_token: z.string(), expires_in: z.number().int() });
export const deviceSelf = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['ios', 'android']),
  model: z.string(),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  biometrics_hint: z.boolean().optional(),
});
