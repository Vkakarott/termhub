import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { signupBody, waitlistRoutes } from './waitlist.js';

const base = {
  first_name: 'Ana',
  last_name: 'Lima',
  email: 'ana@gmail.com',
  phone_country: '55',
  phone_area: '62',
  phone_number: '999990000',
};

/** The public POST with stubbed repositories, wired to the app's real error handler. */
function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  const repos = {
    waitlist: {
      findByEmail: async () => null,
      create: async () => undefined,
      list: async () => [],
      delete: async () => true,
    },
  } as unknown as Repositories;
  app.register((instance) => waitlistRoutes(instance, repos), { prefix: '/api/waitlist' });
  return app;
}

const post = (payload: Record<string, unknown>) =>
  buildApp().inject({ method: 'POST', url: '/api/waitlist', payload });

describe('waitlist signupBody', () => {
  it('accepts a Gmail address and lowercases it', () => {
    const parsed = signupBody.parse({ ...base, email: 'Ana@Gmail.com ' });
    expect(parsed.email).toBe('ana@gmail.com');
  });

  it('rejects a non-Gmail address with gmail_only', () => {
    const result = signupBody.safeParse({ ...base, email: 'ana@empresa.com' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.message === 'gmail_only')).toBe(true);
  });

  it('still rejects a malformed address', () => {
    expect(signupBody.safeParse({ ...base, email: 'ana@' }).success).toBe(false);
  });
});

describe('POST /api/waitlist', () => {
  it('answers 400 gmail_only for an address on another domain', async () => {
    const res = await post({ ...base, email: 'ana@empresa.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('gmail_only');
  });

  it('answers 400 invalid_email for a malformed address', async () => {
    const res = await post({ ...base, email: 'ana..lima@gmail.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_email');
  });

  it('answers 400 VALIDATION when another field is wrong', async () => {
    const res = await post({ ...base, phone_number: '12' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION');
  });

  it('accepts a Gmail sign-up', async () => {
    const res = await post(base);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true, already: false });
  });
});
