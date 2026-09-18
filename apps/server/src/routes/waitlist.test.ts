import { describe, expect, it } from 'vitest';
import { signupBody } from './waitlist.js';

const base = {
  first_name: 'Ana',
  last_name: 'Lima',
  email: 'ana@gmail.com',
  phone_country: '55',
  phone_area: '62',
  phone_number: '999990000',
};

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
