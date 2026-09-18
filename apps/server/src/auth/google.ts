import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';
import { generateToken } from './tokens.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export function isGoogleEnabled(): boolean {
  return !!config.auth.google;
}

export function redirectUri(): string {
  return `${config.publicUrl}/api/auth/google/callback`;
}

export interface OAuthState {
  state: string;
  verifier: string;
}

/** Gera state + PKCE verifier/challenge e a URL de autorização. */
export function buildAuthorizationUrl(): { url: string; oauth: OAuthState } {
  const google = config.auth.google;
  if (!google) throw new Error('Google OAuth não configurado');
  const state = generateToken(16);
  const verifier = generateToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  });
  return { url: `${AUTH_URL}?${params}`, oauth: { state, verifier } };
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/** Troca o code por tokens e valida o id_token contra o JWKS do Google. */
export async function exchangeCode(code: string, verifier: string): Promise<GoogleProfile> {
  const google = config.auth.google!;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: google.clientId,
      client_secret: google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Google token endpoint respondeu ${res.status}`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error('Resposta do Google sem id_token');

  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(body.id_token, jwks, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: google.clientId,
  });
  if (typeof payload.email !== 'string' || !payload.sub) throw new Error('id_token sem e-mail');
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
