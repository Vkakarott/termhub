import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';

export const CF_HEADER = 'cf-access-jwt-assertion';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!config.auth.cloudflare) throw new Error('Cloudflare Access não configurado');
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.auth.cloudflare.teamDomain}/cdn-cgi/access/certs`));
  }
  return jwks;
}

export interface CloudflareIdentity {
  email: string;
  sub: string;
  payload: JWTPayload;
}

/** Valida o JWT emitido pelo Cloudflare Access. Lança se inválido. */
export async function verifyCloudflareJwt(token: string): Promise<CloudflareIdentity> {
  const cf = config.auth.cloudflare!;
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: cf.teamDomain,
    audience: cf.aud,
  });
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  if (!email || !payload.sub) throw new Error('JWT do Cloudflare sem e-mail/sub');
  return { email, sub: payload.sub, payload };
}
