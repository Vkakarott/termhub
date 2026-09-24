# Mobile chat app — server and web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the phone app will talk to — device enrolment approved on the web, hardware-bound sessions with proof of possession and a server-counted PIN, the chat and dictation behind `/api/m/v1` and `/ws/m/chat`, push with an in-app history, the device screens on the web and the store-review switch — shipped and testable from a command-line client before a single screen of the app exists.

**Architecture:** A second Fastify plugin at `/api/m/v1`, registered at the root and outside `/api`, with its own `preHandler` that accepts only a device access token plus a DPoP proof (never a cookie, never `thb_pat_`). `ChatService` is split into *start* and *finish* so the mobile send answers `202` while the web keeps awaiting. Push rides on `chatBus`. The web gains one settings section and one admin panel over ordinary cookie routes. The spec's second half — the Expo app itself, EAS and the store submission — is a separate plan (`2026-09-24-mobile-chat-app.md`, written once this one has shipped its contract).

**Tech Stack:** TypeScript; Fastify 5, Prisma 7 on Postgres 16, zod 3, `jose` 5 (already a server dependency: ES256 verification, JWK thumbprints), `ws`; React 18 + Tailwind 3 + react-router 7 on the web; Vitest everywhere. New workspace `packages/mobile-api` (zod, no other dependency).

**Spec:** `docs/superpowers/specs/2026-09-24-mobile-chat-app-design.md` — read it first. Section numbers below (§) refer to it.

## Global Constraints

- **No new server dependencies.** `jose`, `zod`, `ws`, `nodemailer` and Prisma already cover everything; `@noble/hashes` and the Expo modules belong to the app plan, not here.
- Code, comments, commit messages and PR text in English; **UI copy, e-mail templates and API `error` strings in pt-BR**.
- Routes never import Prisma; every input is a zod schema; owner data through `scoped(repos, request)` / `request.scope` (CLAUDE.md). On the mobile prefix the scope is always self.
- **Migrations additive and backward compatible**: the previous container keeps serving while `prisma migrate deploy` runs. Partial indexes live in SQL only.
- **Secrets are stored hashed** (`hashToken`, sha256) or encrypted (`encryptSecret`). Never log a token, a proof, a PIN secret, a verification code, or chat/terminal content. Logs carry ids only.
- Neutral enrolment response (§4.2): `POST devices/requests` must produce the **same shape, same status and the same DB write pattern** for an existing account, an unknown e-mail and an account without permission.
- The mobile prefix **never reads cookies or the Cloudflare header**, and `/api` never accepts a device token. `/ws/m/chat` refuses any upgrade that carries `Origin`.
- Token lifetimes, verbatim from the spec: access token 15 min; device request 10 min; activation window 10 min after approval; challenge 60 s; `jti` window 5 min; `iat` skew ±60 s; PIN lock 15 min at 3 failures, revocation at 6; at most 5 active devices per user; 3 requests per e-mail per 10 min; 10 per IP per 10 min; 3 pending per account; 5 notification e-mails per hour per account; 10 audio uploads per device per 10 min; audio `seconds` ≤ 300, `TOO_LONG` above 330 s measured.
- Verification code: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, displayed `XXX-XXX`.
- Green means: `npm test -w @termhub/mobile-api`, `npm test -w @termhub/server` (with `TERMHUB_DB_TESTS=1` where a task says so), `npm test -w @termhub/web`, `npm run typecheck --workspaces --if-present`, `npm run build -w @termhub/web`. On jarvis, run them through Docker as CLAUDE.md shows. Existing tests are the contract; none may be deleted or weakened.
- Every new route plugin is registered through `guardedMobile(resource, plugin, prefix)` (mobile) or `guarded(...)` (web); no handler checks a role by name.

## Review Focus

Inputs the spec implies but no ordinary test would think of; each line's test is added to the owning task.

1. **An attacker without the device key hammers `session/token` with wrong PIN proofs to lock the owner out.** The signature must be verified *before* the PIN proof is counted, so only the device itself can burn attempts. (Task 9, test "a bad signature never increments pin_failures".)
2. **The same `jti` replayed within a second by a flaky client retry.** Must be refused with 401, and the first request's effect must not be duplicated. (Task 5, test "second use of a jti is rejected"; Task 6, the hook maps it to `PROOF_REPLAYED`.)
3. **A device request for an e-mail with different casing or trailing spaces (`  Pedro@X.com `).** Must normalise exactly like login does (`trim().toLowerCase()`), otherwise the rate limit and the account lookup disagree and the response differs. (Task 7, test "e-mail is normalised before lookup and limiting".)
4. **A decision approved from the web while the phone's challenge for the same action is in flight.** The phone's `POST decision` must answer 409 "já foi decidida" and must not consume a PIN attempt. (Task 13, test "an already-decided action answers 409 before any PIN check".)
5. **The review flag is on and an admin revokes the reviewer's devices while a request is pending.** The pending request must still auto-approve only if the flag is still on at the time of the request, never retroactively. (Task 7, test "auto-approval reads the flag at request time only".)

## File structure

**New workspace** `packages/mobile-api/` — `package.json`, `tsconfig.json`, `src/index.ts`, `src/enrolment.ts`, `src/session.ts`, `src/chat.ts`, `src/events.ts`, `src/notifications.ts`, `src/version.ts`, `src/proofs.ts` (+ tests).

**Server** `apps/server/src/`:
- `mobile/codes.ts` — verification code, e-mail hash, token generators with prefixes.
- `mobile/rate-limit.ts` — sliding-window limiter (the waitlist's, generalised).
- `mobile/dpop.ts` — DPoP proof verification and the `jti` cache.
- `mobile/auth.ts` — the mobile `preHandler`, `guardedMobile`, app-version check.
- `mobile/enrolment.ts` — `EnrolmentService` (request, poll, approve, deny, activate, expire).
- `mobile/session.ts` — `SessionService` (challenge, refresh, PIN counting, decision proof).
- `mobile/revocation.ts` — `revokeDevice`, the live-socket registry.
- `mobile/push.ts`, `mobile/push-text.ts` — `PushSender`, `ExpoPushSender`, `MobilePushService`, the pt-BR texts.
- `mobile/ws.ts` — `/ws/m/chat`.
- `mobile/app.ts` — `registerMobileApi`: wires the plugin, the services and every mobile route.
- `routes/m-devices.ts`, `routes/m-session.ts`, `routes/m-chat.ts`, `routes/m-transcriptions.ts`, `routes/m-notifications.ts` — the mobile routes.
- `routes/devices.ts` — the web's device routes (cookie world).
- `routes/users.ts` (modify) — the review switch and admin device routes.
- `db/repositories/device-requests.ts`, `devices.ts`, `device-sessions.ts` (tokens + challenges), `device-events.ts`, `user-notifications.ts`.
- `email/templates.ts` (modify) — `deviceRequestMail`, `deviceRevokedMail`.
- `chat/service.ts` (modify) — `start()` / `send()` split, `run_finished` event; `chat/bus.ts` (modify).
- `terminal/transcription.ts` (modify) — `maxSeconds` → `TOO_LONG`.
- `auth/permissions.ts` (modify) — `devices` resource; `config.ts` (modify) — three env vars; `app.ts` (modify) — registration and purge.
- `prisma/schema.prisma`, `prisma/migrations/20260924100000_mobile_devices/migration.sql`.

**Web** `apps/web/src/`: `components/DevicesView.tsx`, `components/DeviceRequestBanner.tsx`, `components/ReviewAccountPanel.tsx`; modify `lib/settings-sections.ts`, `components/settings-icons.ts`, `pages/SettingsPage.tsx`, `components/Layout.tsx`, `lib/api.ts`, `lib/types.ts`.

**Deploy:** `deploy/nginx/termhub.dev.conf.tmpl`, `Dockerfile`, `.github/workflows/deploy.yml`, root `package.json`, `.env.example`, `README.md`.

---

### Task 1: The shared contract package `@termhub/mobile-api`

**Files:**
- Create: `packages/mobile-api/package.json`, `packages/mobile-api/tsconfig.json`, `packages/mobile-api/src/index.ts`, `src/version.ts`, `src/enrolment.ts`, `src/session.ts`, `src/chat.ts`, `src/events.ts`, `src/notifications.ts`, `src/proofs.ts`
- Test: `packages/mobile-api/src/enrolment.test.ts`, `src/proofs.test.ts`, `src/version.test.ts`
- Modify: root `package.json` (`build:packages`, `test`), `Dockerfile` (deps + runner COPY lines, like `agent-protocol`), `.github/workflows/deploy.yml` (a "Testes mobile-api" step next to the others)

**Interfaces:**
- Produces (all exported from `@termhub/mobile-api`):
  ```ts
  export const MOBILE_API_VERSION = 1;
  export const VERIFICATION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  export const verificationCodeSchema: z.ZodString;                  // /^[A-Z2-9]{6}$/ over the alphabet
  export function formatVerificationCode(code: string): string;      // 'K7F2QD' → 'K7F-2QD'
  export function parseAppHeader(v: string | undefined): { platform: 'ios' | 'android'; version: string; build: number } | null; // 'ios/1.2.0+34'
  export function compareVersions(a: string, b: string): -1 | 0 | 1; // semver-ish, numeric parts
  export const deviceRequestBody, deviceRequestResponse, devicePollResponse, deviceActivateBody, deviceActivateResponse, deviceSelf;
  export const challengeBody, challengeResponse, tokenBody, tokenResponse, pushTokenBody;
  export const mobileDecisionBody;    // { decision: 'approve'|'deny', challenge?, pin_proof? }
  export const chatProjectsResponse, hostOptionsResponse, sendAccepted, mobileMessageBody;
  export const chatEventSchema;       // the /ws/chat union + hello
  export const notificationsResponse, notificationRow;
  export function decisionProofMessage(challenge: string, actionId: string, decision: 'approve'): string; // `${challenge}\n${actionId}\napprove`
  export function canonicalHtu(base: string, path: string): string;  // base without trailing slash + path without query
  ```

- [ ] **Step 1: Scaffold the package**

`packages/mobile-api/package.json` — copy `packages/agent-protocol/package.json`, change `name` to `@termhub/mobile-api`. `tsconfig.json` identical to agent-protocol's. `src/index.ts` re-exports every module. Add `-w @termhub/mobile-api` to the root `build:packages` script and `npm test -w @termhub/mobile-api &&` to the root `test` script (before the server). In `Dockerfile`, add `COPY packages/mobile-api/package.json packages/mobile-api/` next to line 15 and the two `COPY --from=build` lines for `packages/mobile-api/package.json` and `dist` next to lines 71–74. In `deploy.yml`, a step `- name: Testes mobile-api` / `run: npm test -w @termhub/mobile-api` after the claude-cli one.

- [ ] **Step 2: Write the failing tests**

`src/enrolment.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { deviceRequestBody, devicePollResponse, formatVerificationCode, verificationCodeSchema } from './enrolment.js';

describe('enrolment contract', () => {
  it('accepts a well-formed request and normalises the e-mail', () => {
    const r = deviceRequestBody.parse({ email: '  Pedro@X.com ', public_key: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, device: { platform: 'ios', model: 'iPhone15,2', os_version: '18.1', name: 'iPhone de Pedro' }, app_version: '1.0.0+12' });
    expect(r.email).toBe('pedro@x.com');
  });
  it('refuses a non-EC key and a platform it does not know', () => {
    expect(() => deviceRequestBody.parse({ email: 'a@b.c', public_key: { kty: 'RSA' }, device: { platform: 'ios', model: 'x', os_version: '1', name: 'n' }, app_version: '1.0.0+1' })).toThrow();
    expect(() => deviceRequestBody.parse({ email: 'a@b.c', public_key: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, device: { platform: 'web', model: 'x', os_version: '1', name: 'n' }, app_version: '1.0.0+1' })).toThrow();
  });
  it('verification codes use only the unambiguous alphabet and format as XXX-XXX', () => {
    expect(verificationCodeSchema.safeParse('K7F2QD').success).toBe(true);
    expect(verificationCodeSchema.safeParse('K7F2Q0').success).toBe(false); // 0 is ambiguous
    expect(verificationCodeSchema.safeParse('K7F2QI').success).toBe(false); // I is ambiguous
    expect(formatVerificationCode('K7F2QD')).toBe('K7F-2QD');
  });
  it('poll status is a closed set', () => {
    expect(devicePollResponse.parse({ status: 'closed' })).toEqual({ status: 'closed' });
    expect(() => devicePollResponse.parse({ status: 'denied' })).toThrow();
  });
});
```

`src/proofs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { canonicalHtu, decisionProofMessage } from './proofs.js';

describe('proof helpers', () => {
  it('builds the htu from the base and the path, dropping the query and a trailing slash', () => {
    expect(canonicalHtu('https://termhub.dev/', '/api/m/v1/chat?project=p1')).toBe('https://termhub.dev/api/m/v1/chat');
  });
  it('the decision message binds challenge, action and the word approve, newline-separated', () => {
    expect(decisionProofMessage('c1', 'a1', 'approve')).toBe('c1\na1\napprove');
  });
});
```

`src/version.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { compareVersions, parseAppHeader } from './version.js';

describe('app version header', () => {
  it('parses ios/1.2.0+34', () => expect(parseAppHeader('ios/1.2.0+34')).toEqual({ platform: 'ios', version: '1.2.0', build: 34 }));
  it('rejects garbage', () => { expect(parseAppHeader('curl/8')).toBeNull(); expect(parseAppHeader(undefined)).toBeNull(); });
  it('compares numerically, not lexically', () => { expect(compareVersions('1.10.0', '1.9.0')).toBe(1); expect(compareVersions('1.0.0', '1.0.0')).toBe(0); expect(compareVersions('0.9.9', '1.0.0')).toBe(-1); });
});
```

- [ ] **Step 3: Run them and watch them fail**

`npm test -w @termhub/mobile-api` — modules not found.

- [ ] **Step 4: Implement**

`src/version.ts`:
```ts
export const MOBILE_API_VERSION = 1;
const HEADER_RE = /^(ios|android)\/(\d+\.\d+\.\d+)\+(\d+)$/;
export function parseAppHeader(v: string | undefined): { platform: 'ios' | 'android'; version: string; build: number } | null {
  const m = v?.match(HEADER_RE);
  return m ? { platform: m[1] as 'ios' | 'android', version: m[2], build: Number(m[3]) } : null;
}
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1; if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1; }
  return 0;
}
```

`src/enrolment.ts`:
```ts
import { z } from 'zod';
export const VERIFICATION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const verificationCodeSchema = z.string().regex(new RegExp(`^[${VERIFICATION_CODE_ALPHABET}]{6}$`));
export const formatVerificationCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;
/** A P-256 public key as the app exports it; anything else is refused before it reaches a signature check. */
export const p256Jwk = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().min(1), y: z.string().min(1) }).strict();
export const deviceInfo = z.object({ platform: z.enum(['ios', 'android']), model: z.string().trim().min(1).max(80), os_version: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(60) });
export const deviceRequestBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), public_key: p256Jwk, device: deviceInfo, app_version: z.string().regex(/^\d+\.\d+\.\d+\+\d+$/) });
export const deviceRequestResponse = z.object({ request_id: z.string(), request_secret: z.string(), verification_code: verificationCodeSchema, expires_at: z.string(), poll_after: z.number().int() });
export const devicePollResponse = z.object({ status: z.enum(['pending', 'approved', 'closed']) });
export const deviceActivateBody = z.object({ request_id: z.string().min(1).max(64), request_secret: z.string().min(1).max(128) });
export const deviceActivateResponse = z.object({ device_id: z.string(), pin_secret: z.string(), access_token: z.string(), expires_in: z.number().int() });
export const deviceSelf = z.object({ id: z.string(), name: z.string(), platform: z.enum(['ios', 'android']), model: z.string(), created_at: z.string(), last_seen_at: z.string().nullable(), biometrics_hint: z.boolean().optional() });
```

`src/session.ts`:
```ts
import { z } from 'zod';
export const challengeBody = z.object({ device_id: z.string().min(1).max(64), purpose: z.enum(['refresh', 'decision']).default('refresh'), action_id: z.string().min(1).max(64).optional() });
export const challengeResponse = z.object({ challenge: z.string(), expires_at: z.string() });
export const tokenBody = z.object({ device_id: z.string().min(1).max(64), challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) });
export const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number().int() });
export const pushTokenBody = z.object({ token: z.string().regex(/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/) });
```

`src/chat.ts`:
```ts
import { z } from 'zod';
export const mobileMessageBody = z.object({ text: z.string().trim().min(1).max(8000), project_id: z.string().min(1).max(64).nullish() });
export const sendAccepted = z.object({ conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string() });
export const mobileDecisionBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('deny') }),
  z.object({ decision: z.literal('approve'), challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) }),
]);
export const chatProjectItem = z.object({ id: z.string(), name: z.string(), key: z.string(), busy: z.boolean(), pending_confirmations: z.number().int(), last_message_at: z.string().nullable() });
export const chatProjectsResponse = z.object({ projects: z.array(chatProjectItem) });
export const hostOptionsResponse = z.object({ machines: z.array(z.object({ id: z.string(), name: z.string(), online: z.boolean(), agent_version: z.string().nullable(), accounts: z.array(z.object({ id: z.string(), label: z.string(), config_dir: z.string().nullable() })) })) });
```

`src/events.ts` — the `ChatEvent` union as zod (`message`, `delta`, `action`, `action_result`, `reset`, `confirmation`, `decision`) plus `{ type: 'hello', protocol: z.number().int(), server_time: z.string() }`. Copy each variant's fields from `apps/server/src/chat/bus.ts`; `message.message` is `z.object({ id, conversation_id, role: z.enum(['user','assistant']), text, usage: z.unknown().nullable(), error_code: z.string().nullable(), created_at })`.

`src/notifications.ts`:
```ts
import { z } from 'zod';
export const notificationRow = z.object({ id: z.string(), kind: z.enum(['confirmation', 'reply', 'device_request']), title: z.string(), body: z.string(), data: z.record(z.unknown()), created_at: z.string(), read_at: z.string().nullable() });
export const notificationsResponse = z.object({ notifications: z.array(notificationRow), unread: z.number().int(), next_before: z.string().nullable() });
```

`src/proofs.ts`:
```ts
export const canonicalHtu = (base: string, path: string) => base.replace(/\/$/, '') + path.split('?')[0];
export const decisionProofMessage = (challenge: string, actionId: string, decision: 'approve') => `${challenge}\n${actionId}\n${decision}`;
```

- [ ] **Step 5: Green, build, commit**

`npm test -w @termhub/mobile-api && npm run build -w @termhub/mobile-api && npm run typecheck --workspaces --if-present`

```bash
git add packages/mobile-api package.json Dockerfile .github/workflows/deploy.yml
git commit -m "Mobile: shared contract package for the phone app's API"
```

---

### Task 2: Migration and Prisma models

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (User gains two fields + relations; six new models)
- Create: `apps/server/prisma/migrations/20260924100000_mobile_devices/migration.sql`
- Modify: `apps/server/src/auth/permissions.ts:5-21` (add `{ key: 'devices', label: 'Aparelhos' }` after `chat`)
- Test: `apps/server/src/auth/permissions.test.ts` (exists? if not, create) — `isResource('devices')` is true

**Interfaces:**
- Produces: Prisma models `DeviceRequest` (`device_requests`), `Device` (`devices`), `DeviceToken` (`device_tokens`), `DeviceChallenge` (`device_challenges`), `DeviceEvent` (`device_events`), `UserNotification` (`user_notifications`); `User.reviewEnabledUntil`, `User.reviewEnabledBy`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/auth/permissions.test.ts (add to the file if it exists)
import { describe, expect, it } from 'vitest';
import { isResource, RESOURCES } from './permissions.js';
describe('resource catalog', () => {
  it('knows the devices resource, labelled in pt-BR', () => {
    expect(isResource('devices')).toBe(true);
    expect(RESOURCES.find((r) => r.key === 'devices')?.label).toBe('Aparelhos');
  });
});
```

Run `npm test -w @termhub/server -- permissions` → fails.

- [ ] **Step 2: Schema**

Append to `schema.prisma` (field names camelCase with `@map`, as the file does):

```prisma
/// A phone asking to join an account (spec §4). `userId` null = a decoy row: unknown e-mail or an
/// account that cannot enrol devices; never shown, never approvable, expires like the rest.
model DeviceRequest {
  id                 String    @id
  userId             String?   @map("user_id")
  user               User?     @relation(fields: [userId], references: [id], onDelete: Cascade)
  emailHash          String    @map("email_hash")
  publicKey          String    @map("public_key")
  keyThumbprint      String    @map("key_thumbprint")
  platform           String
  model              String
  osVersion          String    @map("os_version")
  deviceName         String    @map("device_name")
  appVersion         String    @map("app_version")
  verificationCode   String    @map("verification_code")
  requestSecretHash  String    @unique @map("request_secret_hash")
  /// pending | approved | denied | expired | activated
  status             String    @default("pending")
  ip                 String
  country            String?
  city               String?
  createdAt          DateTime  @default(now()) @map("created_at")
  expiresAt          DateTime  @map("expires_at")
  decidedAt          DateTime? @map("decided_at")
  activateUntil      DateTime? @map("activate_until")
  device             Device?

  @@index([userId, status])
  @@index([emailHash, createdAt])
  @@index([expiresAt])
  @@map("device_requests")
}

/// An enrolled phone (spec §8). Revoked rows stay for the list and the trail.
model Device {
  id             String    @id
  userId         String    @map("user_id")
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name           String
  platform       String
  model          String
  osVersion      String    @map("os_version")
  appVersion     String    @map("app_version")
  publicKey      String    @map("public_key")
  keyThumbprint  String    @unique @map("key_thumbprint")
  /// encryptSecret() of the 32-byte pin secret; the phone holds it wrapped under the PIN
  pinSecretEnc   String    @map("pin_secret_enc")
  pinFailures    Int       @default(0) @map("pin_failures")
  pinLockedUntil DateTime? @map("pin_locked_until")
  /// active | revoked
  status         String    @default("active")
  revokedAt      DateTime? @map("revoked_at")
  /// user | admin | pin_bruteforce | review
  revokedReason  String?   @map("revoked_reason")
  pushToken      String?   @map("push_token")
  lastSeenAt     DateTime? @map("last_seen_at")
  lastIp         String?   @map("last_ip")
  requestId      String?   @unique @map("request_id")
  request        DeviceRequest? @relation(fields: [requestId], references: [id], onDelete: SetNull)
  createdAt      DateTime  @default(now()) @map("created_at")
  tokens         DeviceToken[]
  challenges     DeviceChallenge[]

  @@index([userId, status])
  @@map("devices")
}

model DeviceToken {
  id         String    @id
  deviceId   String    @map("device_id")
  device     Device    @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  tokenHash  String    @unique @map("token_hash")
  expiresAt  DateTime  @map("expires_at")
  createdAt  DateTime  @default(now()) @map("created_at")
  lastUsedAt DateTime? @map("last_used_at")

  @@index([deviceId])
  @@index([expiresAt])
  @@map("device_tokens")
}

model DeviceChallenge {
  id            String    @id
  deviceId      String    @map("device_id")
  device        Device    @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  challengeHash String    @unique @map("challenge_hash")
  /// refresh | decision
  purpose       String
  actionId      String?   @map("action_id")
  expiresAt     DateTime  @map("expires_at")
  usedAt        DateTime? @map("used_at")

  @@index([expiresAt])
  @@map("device_challenges")
}

/// The device trail (spec §8). `meta` holds ids and names, never secrets. Kept 90 days.
model DeviceEvent {
  id        String   @id
  userId    String?  @map("user_id")
  deviceId  String?  @map("device_id")
  requestId String?  @map("request_id")
  kind      String
  actor     String
  ip        String?
  country   String?
  city      String?
  meta      Json     @default("{}")
  createdAt DateTime @default(now()) @map("created_at")

  @@index([userId, createdAt])
  @@index([createdAt])
  @@map("device_events")
}

/// Everything ever pushed to a person, for the app's Notificações tab (spec §9). Kept 30 days.
model UserNotification {
  id        String    @id
  userId    String    @map("user_id")
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind      String
  title     String
  body      String
  data      Json      @default("{}")
  createdAt DateTime  @default(now()) @map("created_at")
  readAt    DateTime? @map("read_at")

  @@index([userId, createdAt])
  @@index([createdAt])
  @@map("user_notifications")
}
```

On `User`, add:
```prisma
  /// Store-review switch (spec §10.2): a device request for this e-mail auto-approves while this is in the future.
  reviewEnabledUntil DateTime? @map("review_enabled_until")
  reviewEnabledBy    String?   @map("review_enabled_by")
  deviceRequests     DeviceRequest[]
  devices            Device[]
  notifications      UserNotification[]
```

- [ ] **Step 3: Migration SQL**

Write `migration.sql` by hand in the style of `20260919120000_api_tokens`: `CREATE TABLE` for the six tables with the exact columns above (`TEXT`, `TIMESTAMP(3)`, `INTEGER`, `JSONB NOT NULL DEFAULT '{}'`), the unique and plain indexes, the foreign keys (`device_requests.user_id → users ON DELETE CASCADE`, `devices.user_id → users CASCADE`, `devices.request_id → device_requests SET NULL`, `device_tokens.device_id → devices CASCADE`, `device_challenges.device_id → devices CASCADE`, `user_notifications.user_id → users CASCADE`), `ALTER TABLE "users" ADD COLUMN "review_enabled_until" TIMESTAMP(3), ADD COLUMN "review_enabled_by" TEXT;`, and the grant:

```sql
-- Additive: new tables and two nullable columns the previous container never reads.
-- `devices` follows the chat feature flag: granted to every role that holds chat:read today
-- (BETA — see 20260921233000_chat_beta_role); admins bypass the matrix.
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_' || r."id" || '_devices_' || a, 'devices', a, r."id"
FROM "roles" r
JOIN "permissions" p ON p."role_id" = r."id" AND p."resource" = 'chat' AND p."action" = 'read',
     unnest(ARRAY['create','read','update','delete']) AS a
ON CONFLICT DO NOTHING;
```

- [ ] **Step 4: Generate, drift-check, green**

`npm run prisma:generate` (through Docker on jarvis). Against a throwaway Postgres named `th-mobile-db`: `npx prisma migrate deploy` then `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` must be clean (this is what CI runs). `npm test -w @termhub/server -- permissions` passes.

- [ ] **Step 5: Commit**

```bash
git add apps/server/prisma apps/server/src/auth/permissions.ts apps/server/src/auth/permissions.test.ts
git commit -m "Mobile: device, session, event and notification tables"
```

---

### Task 3: Repositories

**Files:**
- Create: `apps/server/src/db/repositories/device-requests.ts`, `devices.ts`, `device-sessions.ts`, `device-events.ts`, `user-notifications.ts`
- Modify: `apps/server/src/db/repositories/index.ts` (five new entries + type re-exports)
- Test: `apps/server/src/db/repositories/devices.db.test.ts`, `device-sessions.db.test.ts` (real Postgres, `TERMHUB_DB_TESTS=1`)

**Interfaces:**
- Produces (snake_case DTOs, ISO dates, never a hash or a secret):
  ```ts
  // device-requests.ts
  export type DeviceRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'activated';
  export interface DeviceRequest { id; user_id: string | null; email_hash; public_key; key_thumbprint; platform; model; os_version; device_name; app_version; verification_code; status: DeviceRequestStatus; ip; country: string | null; city: string | null; created_at; expires_at; decided_at: string | null; activate_until: string | null }
  export class DeviceRequestsRepository {
    create(input: Omit<DeviceRequest, 'id'|'status'|'created_at'|'decided_at'|'activate_until'> & { request_secret_hash: string; status?: DeviceRequestStatus; activate_until?: Date | null }): Promise<DeviceRequest>
    findById(id): Promise<DeviceRequest | undefined>
    findByIdWithSecretHash(id): Promise<{ request: DeviceRequest; request_secret_hash: string } | undefined>
    listPendingForUser(userId, now: Date): Promise<DeviceRequest[]>
    countPendingForUser(userId, now): Promise<number>
    countSinceByEmailHash(emailHash, since: Date): Promise<number>
    decide(id, userId, status: 'approved'|'denied', now: Date, activateUntil: Date | null): Promise<DeviceRequest | undefined>   // conditional on status='pending' AND user_id=userId AND expires_at>now
    markActivated(id): Promise<void>
    expireOlderThan(now): Promise<number>   // pending past expires_at, approved past activate_until → 'expired'
    purgeBefore(cutoff): Promise<number>
  }
  // devices.ts
  export type DeviceStatus = 'active' | 'revoked';
  export interface Device { id; user_id; name; platform; model; os_version; app_version; public_key; key_thumbprint; pin_failures; pin_locked_until: string | null; status: DeviceStatus; revoked_at; revoked_reason; push_token; last_seen_at; last_ip; request_id; created_at }
  export class DevicesRepository {
    create(input: {...device fields..., pin_secret_enc: string, request_id: string | null}): Promise<Device>
    findById(id): Promise<Device | undefined>
    findActiveById(id): Promise<Device | undefined>
    pinSecretEnc(id): Promise<string | undefined>
    listByUser(userId): Promise<Device[]>
    countActive(userId): Promise<number>
    rename(id, userId, name): Promise<Device | undefined>
    revoke(id, reason, now): Promise<Device | undefined>         // only if status='active'
    recordPinFailure(id): Promise<{ failures: number }>          // atomic increment, returns the new count
    lockUntil(id, until: Date): Promise<void>
    resetPin(id): Promise<void>                                  // failures 0, locked_until null
    setPushToken(id, token: string | null): Promise<void>
    findByPushToken(token): Promise<Device | undefined>
    touchSeen(id, ip, now): Promise<void>                        // at most once a minute, like ApiTokens.touchLastUsed
    listActiveWithPush(userId): Promise<Device[]>
  }
  // device-sessions.ts
  export class DeviceSessionsRepository {
    createToken(deviceId, tokenHash, expiresAt): Promise<void>
    findValidToken(tokenHash, now): Promise<{ device: Device } | undefined>   // joins devices, status active
    findTokenAny(tokenHash): Promise<{ device_id: string } | undefined>          // no status filter: lets the hook tell 'revoked' from 'unknown'
    deleteTokensForDevice(deviceId): Promise<number>
    createChallenge(deviceId, challengeHash, purpose: 'refresh'|'decision', actionId: string | null, expiresAt): Promise<void>
    consumeChallenge(deviceId, challengeHash, purpose, now): Promise<{ action_id: string | null } | undefined>  // updateMany used_at=null AND expires_at>now → sets used_at; undefined when nothing matched
    purgeExpired(now): Promise<number>   // tokens and challenges past expiry
  }
  // device-events.ts
  export type DeviceEventKind = 'request_created'|'request_approved'|'request_denied'|'request_expired'|'device_activated'|'token_refreshed'|'pin_failed'|'pin_locked'|'device_revoked'|'push_token_set'|'review_auto_approved'|'review_changed';
  export class DeviceEventsRepository { record(e: { user_id?: string|null; device_id?: string|null; request_id?: string|null; kind: DeviceEventKind; actor: string; ip?: string|null; country?: string|null; city?: string|null; meta?: Record<string, unknown> }): Promise<void>; listForUser(userId, limit = 50): Promise<DeviceEvent[]>; purgeBefore(cutoff): Promise<number> }
  // user-notifications.ts
  export class UserNotificationsRepository { create(input: { user_id; kind; title; body; data }): Promise<UserNotification>; list(userId, before: Date | null, limit = 50): Promise<UserNotification[]>; countUnread(userId): Promise<number>; markRead(id, userId, now): Promise<boolean>; purgeBefore(cutoff): Promise<number> }
  ```

- [ ] **Step 1: Write the failing DB tests**

`devices.db.test.ts` (header exactly like `api-tokens.db.test.ts`, creating a user in `beforeEach` and deleting it after):
1. `create` then `findActiveById` returns the device without `pin_secret_enc` in the DTO (`expect(JSON.stringify(d)).not.toContain('pin_secret')`), and `pinSecretEnc(id)` returns what was stored.
2. Two devices with the same `key_thumbprint` → the second `create` rejects (P2002).
3. `recordPinFailure` twice returns 1 then 2; `resetPin` brings it back to 0 and clears `pin_locked_until`.
4. `revoke` returns the row once and `undefined` the second time; `countActive` drops to 0; `findActiveById` is `undefined`.
5. `DeviceRequestsRepository.decide` is `undefined` for another user's row, for an expired row and for a row already decided; succeeds once for a pending row of the same user and sets `activate_until`.
6. `expireOlderThan` turns a pending row past `expires_at` and an approved row past `activate_until` into `expired`, and leaves an approved row still inside its window alone.

`device-sessions.db.test.ts`:
1. `createChallenge` then `consumeChallenge` returns `{ action_id }` once and `undefined` the second time (single use); ten concurrent `consumeChallenge` calls (`Promise.all`) succeed exactly once.
2. `consumeChallenge` with the wrong `purpose` or after `expiresAt` is `undefined`.
3. `findValidToken` finds an unexpired token of an active device, not an expired one, and not one of a revoked device.
4. `deleteTokensForDevice` removes all of that device's tokens and none of another's.

- [ ] **Step 2: Run them and watch them fail**

`TERMHUB_DB_TESTS=1 DATABASE_URL=… npm test -w @termhub/server -- devices` → modules not found.

- [ ] **Step 3: Implement**

Follow `api-tokens.ts` line by line: a `mapX` per model, `newId()` for ids, `updateMany` with a `where` that carries the precondition for every conditional write (`decide`, `revoke`, `consumeChallenge`, `markRead`), then a re-read. `recordPinFailure` is `this.db.device.update({ where: { id }, data: { pinFailures: { increment: 1 } }, select: { pinFailures: true } })`. `findValidToken` is `deviceToken.findFirst({ where: { tokenHash, expiresAt: { gt: now }, device: { status: 'active' } }, include: { device: true } })`. Register the five in `index.ts` (`deviceRequests`, `devices`, `deviceSessions`, `deviceEvents`, `userNotifications`) and re-export the DTO types.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/db/repositories
git commit -m "Mobile: repositories for device requests, devices, sessions, events and notifications"
```

---

### Task 4: Codes, prefixed tokens and the sliding-window limiter

**Files:**
- Create: `apps/server/src/mobile/codes.ts`, `apps/server/src/mobile/rate-limit.ts`
- Test: `apps/server/src/mobile/codes.test.ts`, `apps/server/src/mobile/rate-limit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // codes.ts
  export function newVerificationCode(): string;                 // 6 chars from VERIFICATION_CODE_ALPHABET, randomInt per char
  export function hashEmail(email: string): string;              // sha256 hex of the normalised e-mail
  export const MOBILE_TOKEN_PREFIX = 'thb_mob_', REQUEST_SECRET_PREFIX = 'thb_req_';
  export const MOBILE_TOKEN_RE = /^thb_mob_[A-Za-z0-9_-]{43}$/, REQUEST_SECRET_RE = /^thb_req_[A-Za-z0-9_-]{43}$/;
  export function newMobileToken(): string; export function newRequestSecret(): string; export function newChallenge(): string; // 32 random bytes base64url
  export function newPinSecret(): string;                        // 32 random bytes base64url — the only one ever returned in plain
  export function pinProofFor(pinSecret: string, message: string): string; // base64url(HMAC-SHA256(base64url-decoded secret, message))
  // rate-limit.ts
  export class SlidingWindow { constructor(windowMs: number, max: number); take(key: string): boolean; peek(key: string): number; reset(): void }
  ```

- [ ] **Step 1: Write the failing tests**

`codes.test.ts`: 1000 generated codes all match `verificationCodeSchema` from `@termhub/mobile-api` and never contain `0`, `O`, `1`, `I`, `L`; `hashEmail('a@b.c')` is 64 hex chars and equals `hashEmail('a@b.c')` again; `newMobileToken()` matches `MOBILE_TOKEN_RE`; `pinProofFor(secret, 'x')` is deterministic, differs for another secret, and is base64url (no `=`, `+`, `/`).

`rate-limit.test.ts`: with `vi.useFakeTimers()`, `new SlidingWindow(10_000, 3)`: three `take('k')` true, fourth false, another key unaffected; after `vi.advanceTimersByTime(10_001)` `take('k')` is true again; the map is cleared above 10 000 keys (assert `peek` of an old key is 0 after 10 001 distinct keys).

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

`codes.ts` uses `randomInt` from `node:crypto` per character and `createHmac('sha256', Buffer.from(secret, 'base64url')).update(message).digest('base64url')`. `rate-limit.ts` is `bump` from `routes/waitlist.ts:69-79` lifted into a class with `windowMs`/`max` as constructor arguments and the 10 000-key clear kept; leave the waitlist untouched (a refactor of it is not this plan's job).

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/mobile/codes.ts apps/server/src/mobile/codes.test.ts apps/server/src/mobile/rate-limit.ts apps/server/src/mobile/rate-limit.test.ts
git commit -m "Mobile: verification codes, prefixed tokens, PIN proof and a sliding-window limiter"
```

---

### Task 5: DPoP proof verification

**Files:**
- Create: `apps/server/src/mobile/dpop.ts`
- Test: `apps/server/src/mobile/dpop.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProofCheck { proof: string; htm: string; htu: string; publicKeyJwk: JsonWebKey; accessToken?: string; extra?: Record<string, string>; now?: Date }
  export type ProofResult = { ok: true; jti: string; jwkThumbprint: string } | { ok: false; code: 'PROOF_MISSING'|'PROOF_INVALID'|'PROOF_KEY_MISMATCH'|'PROOF_METHOD'|'PROOF_URL'|'PROOF_STALE'|'PROOF_TOKEN'|'PROOF_CLAIM' };
  export async function verifyProof(c: ProofCheck): Promise<ProofResult>;
  export class JtiCache { constructor(windowMs = 5 * 60_000); claim(scope: string, jti: string, now = Date.now()): boolean; size(): number }  // false when seen inside the window; prunes on every call past 1000 entries
  export async function thumbprint(jwk: JsonWebKey): Promise<string>;   // jose.calculateJwkThumbprint, 'sha256'
  export const SKEW_MS = 60_000;
  ```

- [ ] **Step 1: Write the failing tests**

Build proofs in the test with `jose`:
```ts
import { SignJWT, exportJWK, generateKeyPair, calculateJwkThumbprint } from 'jose';
import { describe, expect, it } from 'vitest';
import { JtiCache, verifyProof } from './dpop.js';

async function device() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const sign = (claims: Record<string, unknown>, jwkHeader = jwk) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: jwkHeader }).sign(privateKey);
  return { jwk, sign };
}
const base = { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/chat/messages' };

describe('verifyProof', () => {
  it('accepts a fresh proof over the right method and url, and returns the jti and thumbprint', async () => {
    const d = await device();
    const jti = 'j1';
    const proof = await d.sign({ ...base, iat: Math.floor(Date.now() / 1000), jti });
    const r = await verifyProof({ proof, ...base, publicKeyJwk: d.jwk });
    expect(r).toMatchObject({ ok: true, jti, jwkThumbprint: await calculateJwkThumbprint(d.jwk, 'sha256') });
  });
  it('binds the access token through ath', async () => { /* proof with ath = base64url(sha256('tok')); ok with accessToken 'tok'; PROOF_TOKEN with 'other'; PROOF_TOKEN when ath absent but accessToken given */ });
  it('rejects a proof signed by another key even if it carries the stored jwk in its header (PROOF_INVALID)', async () => { /* device A's stored jwk, device B signs with A's jwk in the header */ });
  it('rejects a header jwk that is not the stored key (PROOF_KEY_MISMATCH)', async () => {});
  it('rejects the wrong method (PROOF_METHOD), the wrong url or a url with a query (PROOF_URL)', async () => {});
  it('rejects iat more than 60 s away in either direction (PROOF_STALE) and accepts 59 s', async () => {});
  it('checks an extra claim such as chal (PROOF_CLAIM)', async () => { /* extra: { chal: 'c1' } vs a proof with chal 'c2' */ });
  it('rejects garbage and a missing proof (PROOF_INVALID / PROOF_MISSING)', async () => {});
});
describe('JtiCache', () => {
  it('second use of a jti is rejected inside the window and accepted after it', () => {
    const c = new JtiCache(5 * 60_000);
    expect(c.claim('dev1', 'j')).toBe(true);
    expect(c.claim('dev1', 'j')).toBe(false);
    expect(c.claim('dev2', 'j')).toBe(true);           // scoped per device
    expect(c.claim('dev1', 'j', Date.now() + 5 * 60_001)).toBe(true);
  });
});
```

Fill the sketched cases with real proofs of the same shape as the first test.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';

export const SKEW_MS = 60_000;
export async function thumbprint(jwk: JsonWebKey) { return calculateJwkThumbprint(jwk as never, 'sha256'); }

export async function verifyProof(c: ProofCheck): Promise<ProofResult> {
  if (!c.proof) return { ok: false, code: 'PROOF_MISSING' };
  let header;
  try { header = decodeProtectedHeader(c.proof); } catch { return { ok: false, code: 'PROOF_INVALID' }; }
  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) return { ok: false, code: 'PROOF_INVALID' };
  // The header's jwk is compared, never trusted: the signature is checked against the STORED key.
  const stored = await thumbprint(c.publicKeyJwk);
  if ((await thumbprint(header.jwk as JsonWebKey)) !== stored) return { ok: false, code: 'PROOF_KEY_MISMATCH' };
  let payload;
  try {
    const key = await importJWK(c.publicKeyJwk as never, 'ES256');
    ({ payload } = await jwtVerify(c.proof, key, { algorithms: ['ES256'], typ: 'dpop+jwt', clockTolerance: 0 }));
  } catch { return { ok: false, code: 'PROOF_INVALID' }; }
  if (payload.htm !== c.htm) return { ok: false, code: 'PROOF_METHOD' };
  if (payload.htu !== c.htu) return { ok: false, code: 'PROOF_URL' };
  const now = (c.now ?? new Date()).getTime();
  if (typeof payload.iat !== 'number' || Math.abs(payload.iat * 1000 - now) > SKEW_MS) return { ok: false, code: 'PROOF_STALE' };
  if (typeof payload.jti !== 'string' || payload.jti.length < 8 || payload.jti.length > 128) return { ok: false, code: 'PROOF_INVALID' };
  if (c.accessToken !== undefined) {
    const ath = createHash('sha256').update(c.accessToken).digest('base64url');
    if (payload.ath !== ath) return { ok: false, code: 'PROOF_TOKEN' };
  }
  for (const [k, v] of Object.entries(c.extra ?? {})) if (payload[k] !== v) return { ok: false, code: 'PROOF_CLAIM' };
  return { ok: true, jti: payload.jti, jwkThumbprint: stored };
}
```

`jwtVerify` checks `iat` only for `maxTokenAge`; the ±60 s window is ours, above. `JtiCache` is a `Map<string, number>` keyed `${scope}:${jti}` storing the expiry, pruned by a full sweep whenever `size > 1000`.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/mobile/dpop.ts apps/server/src/mobile/dpop.test.ts
git commit -m "Mobile: DPoP proof verification against the stored device key"
```

---

### Task 6: The mobile auth hook, `guardedMobile` and the plugin skeleton

**Files:**
- Create: `apps/server/src/mobile/auth.ts`, `apps/server/src/mobile/app.ts`
- Modify: `apps/server/src/config.ts` (env `MOBILE_PUBLIC_URL`, `MOBILE_MIN_APP_VERSION`, `EXPO_PUSH_ACCESS_TOKEN` → `config.mobile = { publicUrl, minAppVersion, expoPushToken } | null`; null when `MOBILE_PUBLIC_URL` is unset, which disables the prefix), `apps/server/src/app.ts` (call `registerMobileApi` after `mcpRoutes` when `config.mobile`)
- Test: `apps/server/src/mobile/auth.test.ts`

**Interfaces:**
- Consumes: `verifyProof`, `JtiCache`, `MOBILE_TOKEN_RE`, `hashToken`, `canAccess`, `actionForMethod`, `DeviceSessionsRepository.findValidToken`, `DevicesRepository.touchSeen`.
- Produces:
  ```ts
  // auth.ts
  export type MobileAuthMode = 'none' | 'proof' | 'device';   // route config `mobileAuth`, default 'device'
  declare module 'fastify' { interface FastifyRequest { mobile?: { device: Device; user: User } | { proofJwk: JsonWebKey; jwkThumbprint: string } } }
  export interface MobileAuthDeps { repos: Repositories; publicUrl: string; minAppVersion: string | null; jtis: JtiCache }
  export function buildMobileAuthHook(deps: MobileAuthDeps): preHandlerAsyncHookHandler;
  export function clientLocation(request: FastifyRequest): { ip: string; country: string | null; city: string | null }; // request.ip, cf-ipcountry, cf-ipcity
  // app.ts
  export interface MobileDeps { repos; agents: HostAgents; chat: ChatService; transcriptions: TranscriptionService; mailer: Mailer; log: FastifyBaseLogger; upgrades: ReturnType<typeof createUpgradeRouter> }
  export async function registerMobileApi(fastify: FastifyInstance, deps: MobileDeps): Promise<{ push: MobilePushService; sockets: MobileSocketRegistry }>;
  ```
  Inside `registerMobileApi`: `const guardedMobile = (resource: Resource, plugin, prefix) => m.register(async (a) => { a.addHook('onRoute', (route) => { const cfg = (route.config ?? {}) as {...}; route.config = { ...cfg, resource: cfg.resource ?? resource, action: cfg.action ?? actionForMethod(String(route.method)), mobileAuth: cfg.mobileAuth ?? 'device' }; }); await plugin(a); }, { prefix })` — the same shape as `guarded` in `app.ts:151-159`, plus `mobileAuth`.

- [ ] **Step 1: Write the failing tests**

`auth.test.ts` builds a bare Fastify app with `applyErrorHandler`, registers the hook with fake repos and one route per mode, and signs proofs with `jose` as in Task 5:
1. **`mobileAuth: 'none'`** answers without any header.
2. **`'device'`** with a valid `Authorization: Bearer thb_mob_…` + a valid DPoP (with `ath`) sets `request.user`, `request.scope` (`ownerId === createAs === user.id`, `viewAs.kind === 'self'`) and `request.mobile.device`, and calls `devices.touchSeen`.
3. A cookie `termhub_session=…` alone → 401 `UNAUTHORIZED` (the hook never reads cookies); a `thb_pat_…` bearer → 401 `UNAUTHORIZED`.
4. A valid token with a proof signed by another key → 401 `PROOF_INVALID`; a replayed `jti` → 401 `PROOF_REPLAYED`; a proof for another path → 401 `PROOF_URL`.
5. A token of a revoked device (`findValidToken` returns undefined because the join requires `active`) → 401 `DEVICE_REVOKED` when `devices.findById` shows `status: 'revoked'`, else 401 `TOKEN_INVALID`.
6. **Permission:** a route with `resource: 'chat'` and a user whose `canAccess` is false → 403 with `Sem permissão: chat:read` (mock `../auth/permissions.js` like `mcp/gate.e2e.test.ts` does).
7. **App version:** `X-Termhub-App: ios/0.9.0+1` with `minAppVersion: '1.0.0'` → 426 `APP_TOO_OLD` with error `Atualize o app do termhub para continuar`; a missing header is tolerated (a command-line client); a malformed header → 400.
8. **`'proof'`** mode (no token): a valid DPoP without `ath` sets `request.mobile.proofJwk` and `jwkThumbprint`; a proof with `ath` present is still accepted (extra claims are ignored here).

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

```ts
export function buildMobileAuthHook(deps: MobileAuthDeps) {
  return async (request: FastifyRequest) => {
    const cfg = (request.routeOptions.config ?? {}) as { mobileAuth?: MobileAuthMode; resource?: string; action?: string };
    const appHeader = request.headers['x-termhub-app'];
    if (appHeader !== undefined) {
      const app = parseAppHeader(String(appHeader));
      if (!app) throw badRequest('Cabeçalho X-Termhub-App inválido');
      if (deps.minAppVersion && compareVersions(app.version, deps.minAppVersion) < 0) throw new HttpError(426, 'Atualize o app do termhub para continuar', 'APP_TOO_OLD');
    }
    const mode = cfg.mobileAuth ?? 'device';
    if (mode === 'none') return;
    const htm = request.method.toUpperCase();
    const htu = canonicalHtu(deps.publicUrl, request.url);
    const proof = String(request.headers['dpop'] ?? '');
    if (mode === 'proof') {
      let jwk: JsonWebKey;
      try { jwk = decodeProtectedHeader(proof).jwk as JsonWebKey; } catch { throw new HttpError(401, 'Prova inválida', 'PROOF_INVALID'); }
      if (!jwk) throw new HttpError(401, 'Prova inválida', 'PROOF_INVALID');
      const r = await verifyProof({ proof, htm, htu, publicKeyJwk: jwk });
      if (!r.ok) throw new HttpError(401, 'Prova inválida', r.code);
      if (!deps.jtis.claim(r.jwkThumbprint, r.jti)) throw new HttpError(401, 'Prova repetida', 'PROOF_REPLAYED');
      request.mobile = { proofJwk: jwk, jwkThumbprint: r.jwkThumbprint };
      return;
    }
    const auth = String(request.headers.authorization ?? '');
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!MOBILE_TOKEN_RE.test(raw)) throw unauthorized();
    const found = await deps.repos.deviceSessions.findValidToken(hashToken(raw), new Date());
    if (!found) {
      // Distinguish "revoked" from "expired/unknown" only when the device is known, so the app wipes itself on 4401-class answers.
      throw new HttpError(401, 'Token inválido', 'TOKEN_INVALID');
    }
    const device = found.device;
    const r = await verifyProof({ proof, htm, htu, publicKeyJwk: JSON.parse(device.public_key), accessToken: raw });
    if (!r.ok) throw new HttpError(401, 'Prova inválida', r.code);
    if (!deps.jtis.claim(device.id, r.jti)) throw new HttpError(401, 'Prova repetida', 'PROOF_REPLAYED');
    const user = await deps.repos.users.findById(device.user_id);
    if (!user) throw unauthorized();
    request.user = user;
    request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id };
    request.mobile = { device, user };
    void deps.repos.devices.touchSeen(device.id, request.ip, new Date()).catch(() => {});
    if (cfg.resource) {
      const action = cfg.action ?? actionForMethod(request.method);
      if (!(await canAccess(deps.repos, user, cfg.resource, action))) throw forbidden(`Sem permissão: ${cfg.resource}:${action}`);
    }
  };
}
```

For the revoked case: in `findValidToken`'s `undefined` path, look the token up without the status filter (`deviceSessions.findTokenAny(hash)` → add it to the repository: returns `{ device_id }`), then `devices.findById`; if `status === 'revoked'` throw `401 DEVICE_REVOKED` ("Este aparelho foi removido da conta"). (`findTokenAny` is Task 3's.)

`app.ts` (`registerMobileApi`): `fastify.register(async (m) => { m.addHook('preHandler', buildMobileAuthHook(...)); const guardedMobile = ...; /* routes are added in Tasks 8, 9, 13, 15, 16 */ m.setNotFoundHandler(...) }, { prefix: '/api/m/v1' })`. Do **not** register `fastifyCookie` handling here; the plugin lives outside `/api`, so `buildAuthHook` never runs on it. In `apps/server/src/app.ts`, after `mcpRoutes`: `if (config.mobile) await registerMobileApi(fastify, { repos, agents, chat, transcriptions, mailer, log: fastify.log, upgrades });` — `chat` must be hoisted out of the `/api` register callback to be in scope (declare it before the `/api` block and pass it into both).

`config.ts`: add `MOBILE_PUBLIC_URL: z.string().url().optional()`, `MOBILE_MIN_APP_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).optional()`, `EXPO_PUSH_ACCESS_TOKEN: z.string().optional()` to the env schema and `mobile: env.MOBILE_PUBLIC_URL ? { publicUrl: env.MOBILE_PUBLIC_URL.replace(/\/$/, ''), minAppVersion: env.MOBILE_MIN_APP_VERSION ?? null, expoPushToken: env.EXPO_PUSH_ACCESS_TOKEN ?? null } : null` to `config`. Comment it the way `MCP_URL` is commented: the base is the landing host, never `PUBLIC_URL`.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/mobile/auth.ts apps/server/src/mobile/auth.test.ts apps/server/src/mobile/app.ts apps/server/src/config.ts apps/server/src/app.ts apps/server/src/db/repositories/device-sessions.ts
git commit -m "Mobile: the /api/m/v1 prefix with its own device-token and DPoP auth"
```

---

### Task 7: `EnrolmentService`

**Files:**
- Create: `apps/server/src/mobile/enrolment.ts`
- Modify: `apps/server/src/email/templates.ts` (`deviceRequestMail`)
- Test: `apps/server/src/mobile/enrolment.test.ts`, `apps/server/src/email/templates.test.ts` (one case)

**Interfaces:**
- Consumes: Task 3 repositories, Task 4 codes and `SlidingWindow`, `canAccess`, `encryptSecret`, `hashToken`, `Mailer`.
- Produces:
  ```ts
  export const REQUEST_TTL_MS = 10 * 60_000, ACTIVATE_TTL_MS = 10 * 60_000, MAX_ACTIVE_DEVICES = 5, MAX_PENDING_PER_USER = 3, POLL_AFTER_MS = 2000;
  export interface EnrolmentHooks { onRequestCreated?: (user: User, request: DeviceRequest) => Promise<void> }   // push, Task 16
  export class EnrolmentService {
    constructor(deps: { repos: Repositories; mailer: Mailer; appUrl: string; log: FastifyBaseLogger; hooks?: EnrolmentHooks; now?: () => Date })
    request(input: z.infer<typeof deviceRequestBody>, ctx: { ip: string; country: string | null; city: string | null }): Promise<z.infer<typeof deviceRequestResponse>>   // throws 429 RATE_LIMITED
    poll(id: string, secret: string): Promise<{ status: 'pending' | 'approved' | 'closed' }>
    approve(id: string, user: User, ctx): Promise<DeviceRequest>   // 404 / 409 CODE_EXPIRED / 409 DEVICE_LIMIT
    deny(id: string, user: User, ctx): Promise<DeviceRequest>
    activate(input: { request_id; request_secret }, proof: { jwk: JsonWebKey; thumbprint: string }, ctx): Promise<{ device: Device; pin_secret: string; access_token: string; expires_in: number }>
    expire(): Promise<number>   // hourly: expireOlderThan + events request_expired for real rows
  }
  ```

- [ ] **Step 1: Write the failing tests**

Fake repos with `vi.fn`, a fake mailer collecting `Mail`s, `canAccess` mocked per test, `now` injected. Cases:
1. **Neutral response.** For (a) an existing user with `devices:create`, (b) an unknown e-mail, (c) a user without the grant: the three responses have identical keys, all codes match `verificationCodeSchema`, `expires_at` is `now + 10 min`, `poll_after` is 2000; `deviceRequests.create` is called exactly once in each case; in (b) and (c) `user_id` is `null` and no `email` string appears in any argument (only `email_hash`); the mailer received a mail only in (a).
2. **E-mail is normalised before lookup and limiting**: `'  Pedro@X.com '` looks up `pedro@x.com` and counts against `hashEmail('pedro@x.com')`. *(Review Focus 3.)*
3. **Limits.** 4th request for the same e-mail inside 10 min → 429 `RATE_LIMITED`; 11th from one IP → 429; an account with 3 pending → the 4th is created as a decoy (`user_id: null`) and no mail is sent; the 6th mail in an hour for one account is not sent but the row is still real.
4. **Review.** With `review_enabled_until` in the future: the row is created with `status: 'approved'`, `activate_until` set, an event `review_auto_approved` with actor `system`, and the mail still goes. With the flag in the past: ordinary pending. *(Review Focus 5:)* the flag is read once at request time — a later change to the user row does not alter a pending request (assert `decide` is never called by `request`).
5. **poll.** Unknown id → `closed`; wrong secret → `closed`; pending → `pending`; approved inside `activate_until` → `approved`; approved past it, denied, expired, activated, decoy → `closed`. The secret comparison uses `safeEqual` on hashes (assert `hashToken` is applied to the input).
6. **approve.** Calls `decide(id, user.id, 'approved', now, now+10min)`; when `countActive` is 5 → 409 `DEVICE_LIMIT` "Revogue um aparelho antes"; when `decide` returns undefined and the row is not this user's → 404; when the row is pending but expired → 409 `CODE_EXPIRED`. Records `request_approved` with ip/country/city of the *web* caller.
7. **activate.** Happy path: secret matches, status approved, inside the window, thumbprint equals the request's `key_thumbprint`, `countActive < 5` → `devices.create` with `pin_secret_enc = encryptSecret(secret)`, `deviceSessions.createToken` with a 15-min expiry, `markActivated`, event `device_activated`; the result's `access_token` matches `MOBILE_TOKEN_RE` and `expires_in` is 900. Wrong thumbprint → 401 `PROOF_KEY_MISMATCH`; status pending → 409 `NOT_APPROVED`; window passed → 409 `CODE_EXPIRED`.
8. **The plain pin secret and access token never reach the repositories** (`JSON.stringify(allCalls)` contains neither).

`templates.test.ts`: `deviceRequestMail('a@b.c', { deviceLabel: 'iPhone 15 (iOS 18.1)', code: 'K7F2QD', place: 'São Paulo, BR', ip: '1.2.3.4', appUrl: 'https://app.termhub.dev' })` has subject `Um aparelho pede acesso à sua conta`, the formatted code `K7F-2QD` in both text and html, the link to `${appUrl}/settings/devices`, and escapes `<` in the device label.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

The order inside `request()` is the security property; keep it:

```ts
async request(input, ctx) {
  const now = this.now();
  const email = input.email;                        // already trim().toLowerCase() by the schema
  const emailHash = hashEmail(email);
  if (!this.byEmail.take(emailHash) || !this.byIp.take(ctx.ip)) throw new HttpError(429, 'Muitos pedidos; tente de novo em alguns minutos', 'RATE_LIMITED');
  const user = await this.deps.repos.users.findByEmail(email);
  const allowed = user ? await canAccess(this.deps.repos, user, 'devices', 'create') : false;
  const pending = user && allowed ? await this.deps.repos.deviceRequests.countPendingForUser(user.id, now) : 0;
  const real = !!user && allowed && pending < MAX_PENDING_PER_USER;
  const review = real && user!.review_enabled_until !== null && new Date(user!.review_enabled_until) > now;
  const code = newVerificationCode();
  const secret = newRequestSecret();
  const row = await this.deps.repos.deviceRequests.create({
    user_id: real ? user!.id : null, email_hash: emailHash, public_key: JSON.stringify(input.public_key), key_thumbprint: await thumbprint(input.public_key),
    platform: input.device.platform, model: input.device.model, os_version: input.device.os_version, device_name: input.device.name, app_version: input.app_version,
    verification_code: code, request_secret_hash: hashToken(secret), ip: ctx.ip, country: ctx.country, city: ctx.city,
    expires_at: new Date(now.getTime() + REQUEST_TTL_MS),
    status: review ? 'approved' : 'pending', activate_until: review ? new Date(now.getTime() + ACTIVATE_TTL_MS) : null,
  });
  if (real) {
    await this.deps.repos.deviceEvents.record({ user_id: user!.id, request_id: row.id, kind: 'request_created', actor: 'user', ...ctx, meta: { model: row.model, platform: row.platform } });
    if (review) await this.deps.repos.deviceEvents.record({ user_id: user!.id, request_id: row.id, kind: 'review_auto_approved', actor: 'system', ...ctx });
    if (this.mailPerUser.take(user!.id)) await this.deps.mailer.send(deviceRequestMail(user!.email, { deviceLabel: `${row.model} (${row.platform === 'ios' ? 'iOS' : 'Android'} ${row.os_version})`, code, place: [row.city, row.country].filter(Boolean).join(', ') || 'local desconhecido', ip: row.ip, appUrl: this.deps.appUrl })).catch((err) => this.deps.log.warn({ err: failureLabel(err), requestId: row.id }, 'device request mail failed'));
    await this.deps.hooks?.onRequestCreated?.(user!, row);
  }
  return { request_id: row.id, request_secret: secret, verification_code: code, expires_at: row.expires_at, poll_after: POLL_AFTER_MS };
}
```

`byEmail = new SlidingWindow(10 * 60_000, 3)`, `byIp = new SlidingWindow(10 * 60_000, 10)`, `mailPerUser = new SlidingWindow(60 * 60_000, 5)`. `poll` maps every non-`pending`/non-`approved-inside-window` state to `closed` in one `switch` with a default. `approve`/`deny` go through `decide` and record events. `activate` re-checks `countActive` (the approval checked it too, but two approvals in the window could race). The `deviceRequestMail` template copies the structure of `loginCodeMail` (§4.4 copy: title "Um aparelho pede acesso à sua conta", the code big and monospaced, the device label, the place and IP, the sentence "Confira o código na tela do celular antes de aprovar. Se você não pediu isso, recuse.", a button "Ver pedido" to `${appUrl}/settings/devices`).

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/mobile/enrolment.ts apps/server/src/mobile/enrolment.test.ts apps/server/src/email/templates.ts apps/server/src/email/templates.test.ts
git commit -m "Mobile: enrolment service with a neutral response, decoys, limits and review auto-approval"
```

---

### Task 8: Mobile device routes

**Files:**
- Create: `apps/server/src/routes/m-devices.ts`
- Modify: `apps/server/src/mobile/app.ts` (register under `guardedMobile('devices', …, '/devices')`, plus `PUT /push-token` under the same plugin)
- Test: `apps/server/src/routes/m-devices.test.ts`

**Interfaces:**
- Consumes: `EnrolmentService`, `revokeDevice` (Task 9 — stub it in this task's tests with `vi.fn`; the import path is `../mobile/revocation.js`, created in Task 9. To keep this task green on its own, create `mobile/revocation.ts` here with the signature below and a body that Task 9 completes).
- Produces routes (all under `/api/m/v1`):
  | Route | `mobileAuth` | resource:action |
  |---|---|---|
  | `POST /devices/requests` | `none` | — |
  | `GET /devices/requests/:id` | `none` (bearer = request secret, checked in the handler) | — |
  | `POST /devices/activate` | `proof` | — (the user's `devices:create` was checked at request time; re-checked here) |
  | `GET /devices/self` | `device` | `devices:read` |
  | `POST /devices/self/revoke` | `device` | `devices:delete` (explicit `action`) |
  | `PUT /push-token` | `device` | `devices:update` |
  And `export interface RevokeInput { reason: 'user'|'admin'|'pin_bruteforce'|'review'; actor: string; ip?: string|null }` with `export async function revokeDevice(deps: { repos; sockets: MobileSocketRegistry; mailer: Mailer }, deviceId: string, input: RevokeInput): Promise<Device | undefined>`.

- [ ] **Step 1: Write the failing tests**

Bare Fastify + `applyErrorHandler` + a `preHandler` that mimics the mobile hook (sets `request.mobile` from a test option, or `proofJwk` for activate), fake `EnrolmentService` methods with `vi.fn`:
1. `POST /devices/requests` validates with `deviceRequestBody` (a bad body → 400 `VALIDATION`), passes `clientLocation(request)` (`ip`, `cf-ipcountry` → `country`, `cf-ipcity` → `city`) and answers **202** with the service's result; a 429 from the service passes through with `retry-after: 600`.
2. `GET /devices/requests/:id` without a bearer → 401; with `Bearer thb_req_…` calls `poll(id, secret)` and returns `{ status }`; the handler never calls `poll` when the bearer does not match `REQUEST_SECRET_RE` (answers `{ status: 'closed' }` directly — same shape, no DB hit).
3. `POST /devices/activate` passes `request.mobile.proofJwk`/`jwkThumbprint` to `activate` and answers 201 with `{ device_id, pin_secret, access_token, expires_in }`; the response never contains `pin_secret_enc`.
4. `GET /devices/self` returns the `deviceSelf` shape of `request.mobile.device`.
5. `POST /devices/self/revoke` calls `revokeDevice(deps, device.id, { reason: 'user', actor: 'user', ip })` and answers `{ ok: true }`.
6. `PUT /push-token` validates the Expo token format, calls `devices.setPushToken(device.id, token)`, records `push_token_set`, answers `{ ok: true }`; a token already on another device of any user is moved (`findByPushToken` → `setPushToken(other.id, null)` first).

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Handlers are thin: parse with the package schemas, call the service, shape the reply. `GET /devices/requests/:id` reads `request.headers.authorization`, strips `Bearer `, tests `REQUEST_SECRET_RE`. `clientLocation` lives in `mobile/auth.ts` (Task 6) and reads `request.ip`, `request.headers['cf-ipcountry']`, `request.headers['cf-ipcity']` (each a string or null).

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/routes/m-devices.ts apps/server/src/routes/m-devices.test.ts apps/server/src/mobile/app.ts apps/server/src/mobile/revocation.ts
git commit -m "Mobile: device request, poll, activate, self and push-token routes"
```

---

### Task 9: `SessionService`, revocation and the session routes

**Files:**
- Create: `apps/server/src/mobile/session.ts`, `apps/server/src/routes/m-session.ts`
- Complete: `apps/server/src/mobile/revocation.ts` (`revokeDevice`, `MobileSocketRegistry`)
- Modify: `apps/server/src/email/templates.ts` (`deviceRevokedMail`), `apps/server/src/mobile/app.ts`
- Test: `apps/server/src/mobile/session.test.ts`, `apps/server/src/mobile/revocation.test.ts`, `apps/server/src/routes/m-session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ACCESS_TOKEN_TTL_MS = 15 * 60_000, CHALLENGE_TTL_MS = 60_000, PIN_LOCK_AT = 3, PIN_LOCK_MS = 15 * 60_000, PIN_REVOKE_AT = 6;
  export type PinCheck = { ok: true } | { ok: false; code: 'DEVICE_LOCKED'; retryAfterMs: number } | { ok: false; code: 'PIN_INVALID'; failures: number } | { ok: false; code: 'DEVICE_REVOKED' };
  export class SessionService {
    constructor(deps: { repos: Repositories; revoke: (deviceId: string, input: RevokeInput) => Promise<unknown>; now?: () => Date })
    challenge(deviceId: string, purpose: 'refresh'|'decision', actionId: string | null): Promise<{ challenge: string; expires_at: string }>   // 404 DEVICE_NOT_FOUND, 401 DEVICE_REVOKED
    /** Verifies the pin proof for `message` and counts. Call ONLY after the device signature was verified. */
    checkPin(device: Device, message: string, pinProof: string, ctx: { ip: string | null }): Promise<PinCheck>
    refresh(input: { device: Device; challenge: string; pin_proof: string }, ctx): Promise<{ access_token: string; expires_in: number }>   // 400 CHALLENGE_INVALID, then checkPin → 423 / 401
    consumeDecisionChallenge(device: Device, challenge: string, actionId: string): Promise<boolean>
  }
  export class MobileSocketRegistry { add(deviceId: string, ws: WebSocket, userId: string): () => void; closeDevice(deviceId: string, code: number, reason: string): number; hasLive(deviceId: string): boolean; liveDevices(userId: string): Set<string> }   // userId → device ids, kept on add for liveDevices()
  ```

- [ ] **Step 1: Write the failing tests**

`session.test.ts` (fake repos; `revoke` is a `vi.fn`):
1. `challenge` creates a row with `hashToken(challenge)`, purpose and `expires_at = now + 60 s`, and returns the plain challenge (base64url, 43 chars).
2. `refresh`: with a consumed challenge and a correct `pin_proof = pinProofFor(secret, challenge)` → `deviceSessions.createToken(device.id, hash, now+15min)`, `devices.resetPin`, event `token_refreshed`, returns `{ access_token: /^thb_mob_/, expires_in: 900 }`.
3. `consumeChallenge` returning undefined → 400 `CHALLENGE_INVALID`, and **no** PIN counting.
4. Wrong proof → `recordPinFailure`; failures 1 and 2 → 401 `PIN_INVALID` with `failures`; failure 3 → `lockUntil(now+15min)`, event `pin_locked`, 423 `DEVICE_LOCKED` with `retry-after` 900; while `pin_locked_until > now` → 423 without counting; failure 6 → `revoke(device.id, { reason: 'pin_bruteforce', actor: 'system' })` and 401 `DEVICE_REVOKED`.
5. `checkPin` compares with `safeEqual` (a proof of the wrong length is `PIN_INVALID`, never a throw).
6. `consumeDecisionChallenge` is false for a challenge with another `action_id` or purpose `refresh`.

`revocation.test.ts`: `revokeDevice` sets `revoke(id, reason)`, deletes tokens, clears the push token, records `device_revoked` with the actor, closes live sockets with `4401`, and sends `deviceRevokedMail` only for `pin_bruteforce`; a second call on an already-revoked device returns `undefined` and does nothing. `MobileSocketRegistry.closeDevice` calls `ws.close(4401, 'device revoked')` on every socket of that device and removes them; `liveDevices(userId)` lists the devices with an open socket.

`m-session.test.ts` (routes over a fake `SessionService` + a real proof from `jose`):
1. `POST /session/challenge` (`mobileAuth: 'none'`) validates `challengeBody` and answers `challengeResponse`.
2. `POST /session/token` (`mobileAuth: 'none'` — the handler verifies the signature itself against the device's stored key, because there is no access token yet): loads `devices.findActiveById(body.device_id)` (404/401), verifies the DPoP with `extra: { chal: body.challenge }` **before** calling `refresh`. *(Review Focus 1:)* a bad signature answers 401 `PROOF_INVALID` and `refresh` (hence `checkPin`) is never called. A replayed `jti` → 401 `PROOF_REPLAYED`.
3. A 423 from the service carries `retry-after` in seconds.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

`checkPin`:
```ts
async checkPin(device, message, pinProof, ctx): Promise<PinCheck> {
  const now = this.now();
  const fresh = await this.deps.repos.devices.findActiveById(device.id);
  if (!fresh) return { ok: false, code: 'DEVICE_REVOKED' };
  if (fresh.pin_locked_until && new Date(fresh.pin_locked_until) > now) return { ok: false, code: 'DEVICE_LOCKED', retryAfterMs: new Date(fresh.pin_locked_until).getTime() - now.getTime() };
  const enc = await this.deps.repos.devices.pinSecretEnc(device.id);
  const expected = pinProofFor(decryptSecret(enc!), message);
  if (safeEqual(expected, pinProof)) { await this.deps.repos.devices.resetPin(device.id); return { ok: true }; }
  const { failures } = await this.deps.repos.devices.recordPinFailure(device.id);
  await this.deps.repos.deviceEvents.record({ user_id: device.user_id, device_id: device.id, kind: 'pin_failed', actor: 'user', ip: ctx.ip, meta: { failures } });
  if (failures >= PIN_REVOKE_AT) { await this.deps.revoke(device.id, { reason: 'pin_bruteforce', actor: 'system', ip: ctx.ip }); return { ok: false, code: 'DEVICE_REVOKED' }; }
  if (failures === PIN_LOCK_AT) { await this.deps.repos.devices.lockUntil(device.id, new Date(now.getTime() + PIN_LOCK_MS)); await this.deps.repos.deviceEvents.record({ user_id: device.user_id, device_id: device.id, kind: 'pin_locked', actor: 'system', ip: ctx.ip }); return { ok: false, code: 'DEVICE_LOCKED', retryAfterMs: PIN_LOCK_MS }; }
  return { ok: false, code: 'PIN_INVALID', failures };
}
```
`refresh` = consume challenge (`purpose 'refresh'`) → `checkPin(device, challenge, pin_proof)` → map `PinCheck` to `HttpError`s (`423 'Aparelho bloqueado por tentativas de PIN'` with `retryAfterMs` carried on the error for the route's `retry-after`; `401 'PIN incorreto'`; `401 'Este aparelho foi removido da conta'`) → create the token → event `token_refreshed`.

The token route's own proof check: `verifyProof({ proof, htm: 'POST', htu, publicKeyJwk: JSON.parse(device.public_key), extra: { chal: body.challenge } })` then `jtis.claim(device.id, jti)` — the same `JtiCache` instance the hook uses (pass it through `MobileDeps`).

`revokeDevice` order: `devices.revoke` (undefined → return) → `deviceSessions.deleteTokensForDevice` → `devices.setPushToken(id, null)` → `deviceEvents.record({ kind: 'device_revoked', actor, meta: { reason } })` → `sockets.closeDevice(id, 4401, 'device revoked')` → if `reason === 'pin_bruteforce'`: `mailer.send(deviceRevokedMail(user.email, { deviceLabel }))` (subject "Um aparelho foi removido da sua conta por tentativas de PIN"; body says which device, when, and that nothing else changed).

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/mobile/session.ts apps/server/src/mobile/session.test.ts apps/server/src/mobile/revocation.ts apps/server/src/mobile/revocation.test.ts apps/server/src/routes/m-session.ts apps/server/src/routes/m-session.test.ts apps/server/src/email/templates.ts apps/server/src/mobile/app.ts
git commit -m "Mobile: challenges, token renewal with a server-counted PIN, and device revocation"
```

---

### Task 10: Web device routes (cookie world)

**Files:**
- Create: `apps/server/src/routes/devices.ts`
- Modify: `apps/server/src/app.ts` (`await guarded('devices', (a) => deviceRoutes(a, repos, { enrolment, revoke }), '/devices')` — `enrolment` and `revoke` come from `registerMobileApi`'s result, so register the mobile API **before** the `/api` block, or export the services from a small factory both can call; the cleanest is `createMobileServices(deps)` in `mobile/app.ts` returning `{ enrolment, session, revoke, sockets, push }`, used by both registrations)
- Test: `apps/server/src/routes/devices.test.ts`

**Interfaces:**
- Consumes: `EnrolmentService.approve/deny`, `revokeDevice`, Task 3 repositories.
- Produces (under `/api/devices`, always `request.user`, never the view-as scope — like `api-tokens.ts`):
  | Route | action | Answer |
  |---|---|---|
  | `GET /requests` | read | `{ requests: DeviceRequestView[] }` — pending, not expired; view = `{ id, device_name, model, platform, os_version, country, city, ip, verification_code (formatted), created_at, expires_at }` |
  | `POST /requests/:id/approve` | create | `{ request }` |
  | `POST /requests/:id/deny` | create | `{ request }` |
  | `GET /` | read | `{ devices: Device[] }` (DTO from Task 3, never `pin_secret_enc`) |
  | `PATCH /:id` | update | body `{ name: z.string().trim().min(1).max(60) }` → `{ device }` |
  | `DELETE /:id` | delete | `revokeDevice(id, { reason: 'user', actor: 'user' })` → `{ device }`; 404 for another user's |
  | `GET /events` | read | `{ events: DeviceEventView[] }` — the last 50, with a pt-BR `text` built server-side by `describeDeviceEvent(e)` |
  | `GET /summary` | read | `{ pending_requests: number; active_devices: number }` |

- [ ] **Step 1: Write the failing tests**

Pattern of `api-tokens.test.ts` (a `preHandler` that sets `request.user = { id: 'u1' }`):
1. `GET /requests` lists only pending rows of `u1` and formats the code as `K7F-2QD`.
2. `POST /requests/r1/approve` calls `enrolment.approve('r1', user, ctx)` and returns the row; a 409 `DEVICE_LIMIT` from the service passes through with its pt-BR message.
3. `DELETE /d1` calls `revoke('d1', { reason: 'user', actor: 'user', ip })` only when `devices.findById` returns a device of `u1`; another user's → 404 and `revoke` not called.
4. `PATCH /d1` trims and renames; a 61-character name → 400.
5. `GET /events` returns rows with `text`: `describeDeviceEvent` maps `request_approved` → "Pedido aprovado de iPhone 15", `pin_locked` → "PIN errado 3 vezes, aparelho bloqueado por 15 min", `device_revoked` + `meta.reason === 'pin_bruteforce'` → "Aparelho revogado por tentativas de PIN", `device_revoked` + `user` → "Aparelho revogado por você", `review_auto_approved` → "Aprovado automaticamente (conta de revisão)", `token_refreshed` → "Sessão renovada"; unknown kind → the kind itself.
6. An admin "viewing as" `u2` still sees and acts on `u1`'s devices (assert `listByUser('u1')`).

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Straightforward handlers; `describeDeviceEvent` is a pure function exported from `routes/devices.ts` (a `switch` over `kind`, using `meta.model` / `meta.reason`).

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/routes/devices.ts apps/server/src/routes/devices.test.ts apps/server/src/app.ts apps/server/src/mobile/app.ts
git commit -m "Web: device requests, device list, revocation and activity routes"
```

---

### Task 11: Web — Configurações → Aparelhos and the global banner

**Files:**
- Create: `apps/web/src/components/DevicesView.tsx`, `apps/web/src/components/DeviceRequestBanner.tsx`
- Modify: `apps/web/src/lib/settings-sections.ts` (`'devices'` in the union; `{ key: 'devices', label: 'Aparelhos', resource: 'devices', group: 'account' }` after `api-tokens`), `apps/web/src/components/settings-icons.ts` (`devices: Smartphone` from lucide), `apps/web/src/pages/SettingsPage.tsx` (`case 'devices'` → `<PageFrame title={current.label}><DevicesView /></PageFrame>`), `apps/web/src/lib/api.ts` (`api.devices.{requests, approve, deny, list, rename, revoke, events, summary}`), `apps/web/src/lib/types.ts` (`DeviceRequestView`, `Device`, `DeviceEventView`, `DevicesSummary`), `apps/web/src/components/Layout.tsx` (`<DeviceRequestBanner />` above `<Outlet />` inside `<main>`)
- Test: `apps/web/src/components/DevicesView.test.tsx`, `apps/web/src/components/DeviceRequestBanner.test.tsx`

**Interfaces:**
- Consumes: Task 10's routes and shapes; `useAuth().can`; `ConfirmDialog` from `components/Modal.tsx`; `ApiError`.
- Produces: `DevicesView` (three parts, §10.1) and `DeviceRequestBanner` (props none; polls `api.devices.summary()` every 60 s while `can('devices')`, re-fetches on `window` event `termhub:devices-changed`, which `DevicesView` dispatches after approve/deny/revoke).

- [ ] **Step 1: Write the failing tests**

`DevicesView.test.tsx` (Testing Library, `vi.mock('../lib/api')`, `useAuth` mocked to `can: () => true`):
1. Renders the empty state text "Instale o app termhub no celular e entre com seu e-mail. O pedido de acesso aparece aqui." when there are no requests and no devices.
2. A pending request renders its code `K7F-2QD`, the model, the place and "Se você não pediu isso, recuse."; clicking **Aprovar** opens a dialog titled "Aprovar aparelho" whose message contains "O código na tela do celular é K7F-2QD?"; confirming calls `api.devices.approve('r1')` and removes the card; **Recusar** calls `deny` without a dialog.
3. With 5 active devices, **Aprovar** is disabled and the card shows "Revogue um aparelho antes".
4. The devices table shows name, model/OS, added date, last seen ("nunca" when null) and situation: "ativo", "bloqueado por PIN até 14:30" when `pin_locked_until` is in the future, "revogado (tentativas de PIN)" for `revoked_reason: 'pin_bruteforce'`, "revogado" otherwise; revoked rows have `text-fg-dim`.
5. **Revogar** opens `ConfirmDialog` "Revogar aparelho" with "Ele perde o acesso na hora. Isso não pode ser desfeito."; confirm calls `api.devices.revoke('d1')` and the row shows "revogado".
6. Clicking the name shows an inline input; Enter calls `api.devices.rename('d1', 'Meu iPhone')`.
7. The activity list renders each event's `text` and date.

`DeviceRequestBanner.test.tsx`: with `summary` → `{ pending_requests: 1 }` it renders "Um aparelho pede acesso à sua conta" and a link "Ver pedido" to `/settings/devices`; with 0 it renders nothing; with `can('devices')` false it never calls the API.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- Devices`

- [ ] **Step 3: Implement**

Copy the skeleton of `ApiTokensView.tsx` (state `null` = "Carregando…", `ApiError` → `text-danger` line, `ConfirmDialog` with `danger`). The verification code: `<code className="font-mono text-2xl tracking-widest">`. Dates with `toLocaleDateString('pt-BR')` / `toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })`. The banner is a `div` with `bg-attention/10 border-b border-attention/40 px-4 py-2 text-sm` and a `Link`. Every string pt-BR; component names and comments English.

- [ ] **Step 4: Green, build, commit**

`npm test -w @termhub/web && npm run build -w @termhub/web`

```bash
git add apps/web/src
git commit -m "Web: Aparelhos section with pending requests, device list and activity"
```

---

### Task 12: `ChatService.start()` and the `run_finished` event

**Files:**
- Modify: `apps/server/src/chat/service.ts` (`sendIn` → `startIn` + `finishRun`; `send` keeps its signature; new public `start`), `apps/server/src/chat/bus.ts` (`run_finished` variant)
- Test: `apps/server/src/chat/service.test.ts` (add cases; every existing case must keep passing unchanged)

**Interfaces:**
- Produces:
  ```ts
  export interface StartedRun { conversation_id: string; user_message_id: string; assistant_message_id: string; done: Promise<ChatMessage> }
  // ChatService
  async start(user: User, text: string, opts: { projectId?: string | null } = {}): Promise<StartedRun>
  async send(user: User, text: string, opts = {}): Promise<ChatMessage>   // = (await this.start(user, text, opts)).done — unchanged for the web
  // bus.ts
  | { type: 'run_finished'; user_id: string; conversation_id: string; message_id: string | null; ok: boolean; error_code: string | null }
  ```

- [ ] **Step 1: Write the failing tests**

In `service.test.ts`, with the existing fake runner:
1. `start` resolves as soon as both messages are stored — before the runner has yielded a single frame (use a runner whose iterator awaits a deferred promise; assert `start` resolved and `done` is still pending; then release the runner and `await done`).
2. `start`'s ids match the two `message` events published, and `done` resolves to the final assistant message with the collected text.
3. Host errors (`CHAT_NO_MACHINE`), `CHAT_BUSY` and `CHAT_ARCHIVED` still **reject `start` itself** (nothing stored), exactly as `send` did.
4. After a successful run a `run_finished` event is published with `ok: true` and `message_id` = the assistant message; after a runner error frame, `ok: false` and `error_code` = the stored code; after a setup failure (the `isSetupFailure` path) `run_finished` carries `message_id: null, ok: false, error_code: 'SETUP_FAILED'` and `done` rejects with the original error.
5. `send` still returns the final message and still throws on setup failure (the existing tests cover this; leave them).
6. `resumeAfterDecision` and `drainNextDecision` keep awaiting the whole run (their tests are the contract).

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Split `sendIn` at the line after the assistant message is published: everything above it (host, prompt, lock, re-read, pin, `beforeRun`, the two inserts and their events) stays in `startIn`, which then calls `const done = this.finishRun(user, conversation, question, answer, runner, host, appendSystemPrompt)` **without awaiting** and returns `{ conversation_id, user_message_id: question.id, assistant_message_id: answer.id, done }`. `finishRun` holds the body of the old `try` from `let collected = ''` onward, including the `finally` that releases the lock and schedules the drain — the lock is taken in `startIn` and released in `finishRun`, so a `start` whose `finishRun` is never awaited still releases it. In `finishRun`, publish `run_finished` right after the final `message` event (`ok: errorCode === null`), and in the setup-failure `catch` publish `run_finished` with `message_id: null` before rethrowing. `sendIn` becomes `return (await this.startIn(...)).done;`. Add `done.catch(() => {})` on the promise returned by `start` **only** in the mobile route (Task 13), never here: `send` must keep rejecting.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/chat/service.ts apps/server/src/chat/service.test.ts apps/server/src/chat/bus.ts
git commit -m "Chat: split a run into start and finish, and announce when it ends"
```

---

### Task 13: Mobile chat routes and `GET me`

**Files:**
- Create: `apps/server/src/routes/m-chat.ts`
- Modify: `apps/server/src/mobile/app.ts` (`guardedMobile('chat', (a) => mobileChatRoutes(a, repos, { chat, agents, session }), '/chat')`, and `GET /me` under `guardedMobile('chat', …, '')`)
- Test: `apps/server/src/routes/m-chat.test.ts`

**Interfaces:**
- Consumes: `ChatService.start/conversationFor/hostFor/reset/projectStatuses/resumeAfterDecision`, `SessionService.checkPin/consumeDecisionChallenge`, `HostAgents`, `repos.projects.list({ owner })`, `repos.machines.list(ownerId)`, `repos.aiAccounts.list(ownerId)`, `describeActions`, `decisionProofMessage`.
- Produces the routes of §6's table for `me` and `chat/*`. `GET /me` answers `{ user: { id, email, name, nickname }, permissions: string[], device: deviceSelf, unread_notifications: number }` (`permissionsOf` from `auth/permissions.ts`).

- [ ] **Step 1: Write the failing tests**

Fake `ChatService` (`vi.fn` methods) behind a `preHandler` that sets `request.user`, `request.scope` and `request.mobile.device`:
1. `GET /chat` and `GET /chat?project=p1` return `{ conversation, messages, actions, host }` exactly like `routes/chat.ts` (same calls: `conversationFor`, `listMessages`, `listByConversation`, `hostFor`, `describeActions`).
2. `GET /chat/projects` joins `projectStatuses` with `projects.list({ owner: user.id })` into `chatProjectsResponse` items (`name`, `key`, `last_message_at` from the conversation rows via `chat.listActiveProjectConversations`), and includes projects with no conversation yet with `busy: false, pending_confirmations: 0, last_message_at: null`.
3. `GET /chat/host/options` returns only `type === 'agent'` machines of the user with `online: agents.capabilities(id) !== null`, `agent_version` from `agents.info(id)`, and each machine's Claude accounts (`aiAccounts.list(user.id)` filtered by `machine_id` and `provider === 'claude'`).
4. `POST /chat/host` and `POST /chat/reset` behave as the web's (copy the assertions from `chat.test.ts`).
5. `POST /chat/messages` answers **202** `{ conversation_id, user_message_id, assistant_message_id }` while `done` is still pending; a rejected `done` is swallowed by the route (`done.catch`), never an unhandled rejection; `CHAT_BUSY` from `start` → 409.
6. `POST /chat/actions/:id/decision` with `deny` → `decide` + the `decision` event + `resumeAfterDecision`, no PIN involvement. With `approve`: *(Review Focus 4)* an already-decided action answers 409 "Esta ação já foi decidida" **before** `consumeDecisionChallenge` or `checkPin` are called; then `consumeDecisionChallenge(device, challenge, id)` false → 400 `CHALLENGE_INVALID`; `checkPin(device, decisionProofMessage(challenge, id, 'approve'), pin_proof)` not ok → 423 / 401 mapped as in Task 9 and the action stays pending (`decide` not called); ok → `decide(id, user.id, 'approved')`, the event, `resumeAfterDecision`, and `{ action, message }` or `{ action, queued: true, note }` on `CHAT_BUSY`.
7. `GET /me` shape as above; the device part never includes `pin_secret_enc` or `public_key`.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

For `approve`: first `repos.chatActions.findByIdForUser(id, user.id)`; if absent → 404; if `status !== 'pending'` → 409; then the challenge, then `checkPin`, then `decide` (which is still conditional in SQL, so a race with the web ends in the same 409 path as today). `POST /chat/messages`:
```ts
const started = await deps.chat.start(request.scope.user, text, { projectId: project_id ?? null });
started.done.catch((err) => request.log.warn({ code: failureLabel(err), conversationId: started.conversation_id }, 'mobile run failed after start'));
return reply.code(202).send({ conversation_id: started.conversation_id, user_message_id: started.user_message_id, assistant_message_id: started.assistant_message_id });
```

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/routes/m-chat.ts apps/server/src/routes/m-chat.test.ts apps/server/src/mobile/app.ts
git commit -m "Mobile: chat routes with a 202 send and PIN-proved approvals"
```

---

### Task 14: `/ws/m/chat`

**Files:**
- Create: `apps/server/src/mobile/ws.ts`
- Modify: `apps/server/src/mobile/app.ts` (call `registerMobileChatWs(upgrades, { repos, jtis, publicUrl, sockets, log })`)
- Test: `apps/server/src/mobile/ws.test.ts`

**Interfaces:**
- Consumes: `upgrades.addPublic`, `rejectUpgrade`, `verifyProof`, `JtiCache`, `deviceSessions.findValidToken`, `chatBus`, `MobileSocketRegistry`, `canAccess`.
- Produces: the upgrade route `/^\/ws\/m\/chat\/?$/`, protocol `?v=1`, `hello` frame, close codes `4400` / `4401`, and `sockets.add(device.id, ws)` so revocation reaches it.

- [ ] **Step 1: Write the failing tests**

Follow `chat/ws.test.ts`'s approach (a real `http.Server`, `createUpgradeRouter`, a `ws` client). `AuthContext` is not needed for a public route; pass a stub.
1. A client with `Authorization` + a valid DPoP (`htm: 'GET'`, `htu: '<publicUrl>/ws/m/chat'`, `ath`) connects and receives `{ type: 'hello', protocol: 1, server_time }` first; a `chatBus.publish` for that user then arrives as JSON; one for another user does not.
2. No `Authorization` → `401`; a bad proof → `401`; a proof with a replayed `jti` → `401`; a user without `chat:read` → `403`.
3. **An `Origin` header → `403`** even with valid credentials.
4. `?v=2` (or no `v`) → the upgrade succeeds and the socket is closed at once with `4400` and reason `protocol`.
5. `sockets.closeDevice(device.id, 4401, 'device revoked')` closes the client with code `4401`.
6. The heartbeat terminates a client that stops answering pings (fake timers, 30 s).

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

```ts
router.addPublic(/^\/ws\/m\/chat\/?$/, async ({ req, socket, head, url }) => {
  if (req.headers.origin) return rejectUpgrade(socket, 403, 'Forbidden');
  const raw = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!MOBILE_TOKEN_RE.test(raw)) return rejectUpgrade(socket, 401, 'Unauthorized');
  const found = await deps.repos.deviceSessions.findValidToken(hashToken(raw), new Date());
  if (!found) return rejectUpgrade(socket, 401, 'Unauthorized');
  const proof = await verifyProof({ proof: String(req.headers.dpop ?? ''), htm: 'GET', htu: canonicalHtu(deps.publicUrl, url.pathname), publicKeyJwk: JSON.parse(found.device.public_key), accessToken: raw });
  if (!proof.ok || !deps.jtis.claim(found.device.id, proof.jti)) return rejectUpgrade(socket, 401, 'Unauthorized');
  const user = await deps.repos.users.findById(found.device.user_id);
  if (!user || !(await canAccess(deps.repos, user, 'chat', 'read'))) return rejectUpgrade(socket, 403, 'Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.searchParams.get('v') !== String(MOBILE_API_VERSION)) return ws.close(4400, 'protocol');
    const release = deps.sockets.add(found.device.id, ws, user.id);
    ws.send(JSON.stringify({ type: 'hello', protocol: MOBILE_API_VERSION, server_time: new Date().toISOString() }));
    const unsubscribe = chatBus.subscribe((event) => { if (event.user_id === user.id && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); });
    ws.on('close', () => { unsubscribe(); release(); });
    ws.on('error', () => { unsubscribe(); release(); });
    // heartbeat: copy the isAlive/ping loop from chat/ws.ts
  });
});
```
`MobileSocketRegistry.add(deviceId, ws, userId)` is Task 9's registry.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/mobile/ws.ts apps/server/src/mobile/ws.test.ts apps/server/src/mobile/app.ts apps/server/src/mobile/revocation.ts
git commit -m "Mobile: /ws/m/chat with proof-of-possession, hello and revocation close"
```

---

### Task 15: Mobile transcriptions

**Files:**
- Create: `apps/server/src/routes/m-transcriptions.ts`
- Modify: `apps/server/src/terminal/transcription.ts` (`start(userId, audio, mime, seconds, opts?: { maxSeconds?: number })`; when the whisper result's `duration > maxSeconds` the job ends `error` with `error: 'Áudio longo demais'` and a new `code: 'TOO_LONG'` on the view — add `code?: string` to `TranscriptionView`), `apps/server/src/mobile/app.ts`
- Test: `apps/server/src/routes/m-transcriptions.test.ts`, `apps/server/src/routes/transcriptions.test.ts` (one added case for `maxSeconds`; existing cases unchanged)

**Interfaces:**
- Produces: `GET /transcriptions/config`, `POST /transcriptions?seconds=` (202), `GET /transcriptions/:id`, guarded `terminals`; `export const MOBILE_AUDIO_TYPES = new Set(['audio/mp4','audio/m4a','audio/x-m4a','audio/aac','audio/3gpp','audio/webm','audio/ogg','audio/wav'])`, `MOBILE_MAX_SECONDS = 300`, `MOBILE_TOO_LONG_SECONDS = 330`, `MOBILE_UPLOADS_PER_10MIN = 10`.

- [ ] **Step 1: Write the failing tests**

Mirror `transcriptions.test.ts`'s fake service:
1. `POST` with `content-type: audio/mp4`, `?seconds=12` and a body → 202 and `start(user.id, body, 'audio/mp4', 12, { maxSeconds: 330 })`.
2. `content-type: audio/flac` → 400 "Formato de áudio não aceito"; `audio/mp4;codecs=mp4a` is accepted (parameters stripped).
3. Missing `seconds` → 400; `seconds=301` → 400.
4. The 11th upload from the same device inside 10 minutes → 429 `RATE_LIMITED` (limiter keyed by `request.mobile.device.id`).
5. `GET /:id` and `/config` behave as the web's.
6. In `transcriptions.test.ts`: a whisper result with `duration: 400` under `maxSeconds: 330` ends the job with `status: 'error'`, `code: 'TOO_LONG'`.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

The route registers the same `audio/*` content-type parser (`bodyLimit: TRANSCRIPTION_MAX_BYTES`) and a `SlidingWindow(10 * 60_000, 10)`. Everything else delegates to `TranscriptionService`.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/routes/m-transcriptions.ts apps/server/src/routes/m-transcriptions.test.ts apps/server/src/terminal/transcription.ts apps/server/src/routes/transcriptions.test.ts apps/server/src/mobile/app.ts
git commit -m "Mobile: dictation upload with an audio allowlist, a duration cap and a per-device limit"
```

---

### Task 16: Push, the notification history and its routes

**Files:**
- Create: `apps/server/src/mobile/push-text.ts`, `apps/server/src/mobile/push.ts`, `apps/server/src/routes/m-notifications.ts`
- Modify: `apps/server/src/mobile/app.ts` (construct `MobilePushService`, pass `hooks: { onRequestCreated: (u, r) => push.deviceRequest(u, r) }` to `EnrolmentService`, register `guardedMobile('chat', notificationRoutes, '/notifications')`)
- Test: `apps/server/src/mobile/push-text.test.ts`, `apps/server/src/mobile/push.test.ts`, `apps/server/src/routes/m-notifications.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // push-text.ts — pure
  export interface PushContext { projectName: string | null; tabName: string | null; machineName: string | null }
  export function confirmationText(ctx: PushContext): { title: string; body: string };
  export function replyText(ctx: PushContext): { title: string; body: string };
  export function deviceRequestText(r: { model: string; city: string | null; country: string | null }): { title: string; body: string };
  // push.ts
  export interface PushMessage { to: string; title: string; body: string; data: Record<string, unknown>; collapseId?: string }
  export interface PushSender { send(messages: PushMessage[]): Promise<{ to: string; error?: 'DeviceNotRegistered' | string }[]> }
  export class ExpoPushSender implements PushSender { constructor(accessToken: string | null, fetchImpl = fetch) }   // POST https://exp.host/--/api/v2/push/send, chunks of 100, header Authorization: Bearer <token> when set
  export class MobilePushService {
    constructor(deps: { repos: Repositories; sender: PushSender; sockets: MobileSocketRegistry; log: FastifyBaseLogger; now?: () => Date })
    start(): () => void                                          // subscribes to chatBus; returns unsubscribe
    deviceRequest(user: User, request: DeviceRequest): Promise<void>
  }
  ```
  Routes: `GET /notifications?before=<iso>` → `notificationsResponse`; `POST /notifications/:id/read` → `{ ok: true }` (404 for another user's).

- [ ] **Step 1: Write the failing tests**

`push-text.test.ts`:
```ts
it('names the project, tab and machine and never anything else', () => {
  expect(confirmationText({ projectName: 'termhub', tabName: 'api', machineName: 'jarvis' })).toEqual({ title: 'termhub precisa de você', body: 'O chat do projeto termhub pediu confirmação para agir na aba api (jarvis).' });
  expect(confirmationText({ projectName: null, tabName: 'api', machineName: 'jarvis' }).body).toBe('O chat geral pediu confirmação para agir na aba api (jarvis).');
  expect(confirmationText({ projectName: 'termhub', tabName: null, machineName: null }).body).toBe('O chat do projeto termhub pediu sua confirmação.');
  expect(replyText({ projectName: 'termhub', tabName: null, machineName: null })).toEqual({ title: 'Resposta pronta em termhub', body: 'O chat do projeto termhub terminou de responder.' });
  expect(replyText({ projectName: null, tabName: null, machineName: null })).toEqual({ title: 'Resposta pronta', body: 'O chat geral terminou de responder.' });
  expect(deviceRequestText({ model: 'iPhone 15', city: 'São Paulo', country: 'BR' })).toEqual({ title: 'Novo aparelho pede acesso', body: 'iPhone 15 (São Paulo) pediu acesso à sua conta. Confira o código e aprove ou recuse na web.' });
  expect(deviceRequestText({ model: 'Pixel 8', city: null, country: null }).body).toMatch(/^Pixel 8 pediu acesso/);
});
```

`push.test.ts` (fake sender records messages; fake repos; `sockets.liveDevices` controllable):
1. On a `confirmation` bus event for `u1` with `project_id: 'p1'`, `tab_id: 't1'`, `machine_id: 'm1'`: resolves names through `projects.findByIdsForOwner(['p1'], 'u1')`, `tabs.findByIdsForOwner`, `machines.findByIdsForOwner`; creates **one** `user_notifications` row (`kind: 'confirmation'`, `data: { kind, conversation_id, project_id, action_id }`); sends to every device in `listActiveWithPush('u1')` **minus** `sockets.liveDevices('u1')`; the sent payload's `data` has no `summary`, `args` or `tool`, and `JSON.stringify(messages)` does not contain the event's `summary`.
2. On `run_finished` with `ok: true`: `kind: 'reply'`, `collapseId: 'reply:<conversation_id>'`; a second `run_finished` for the same conversation inside 60 s creates a row but sends nothing (rate limit per conversation); `ok: false` sends nothing and creates no row.
3. `deviceRequest(user, request)` → row `kind: 'device_request'` and a push to all live-or-not devices of the user (this one goes everywhere: the person must act on the web).
4. A sender result `DeviceNotRegistered` → `devices.setPushToken(id, null)`; a thrown sender error is logged with ids only and does not reject.
5. A user with no devices with a push token still gets the history row.

`m-notifications.test.ts`: `GET` returns rows newest first with `unread` and `next_before` (the last row's `created_at` when 50 were returned, else null); `POST /:id/read` → `markRead(id, user.id, now)`, 404 when it returns false.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

`ExpoPushSender.send` posts `messages.map(m => ({ to: m.to, title: m.title, body: m.body, data: m.data, sound: 'default', priority: 'high', ...(m.collapseId ? { collapseId: m.collapseId } : {}) }))` and maps the response's `data[i].details?.error` to `error`. `MobilePushService.start()` subscribes to `chatBus` and dispatches on `event.type`; name resolution is owner-scoped (`findByIdsForOwner`) so a card never names something the user cannot see. The per-conversation reply limiter is a `SlidingWindow(60_000, 1)` keyed by `conversation_id`.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/mobile/push-text.ts apps/server/src/mobile/push-text.test.ts apps/server/src/mobile/push.ts apps/server/src/mobile/push.test.ts apps/server/src/routes/m-notifications.ts apps/server/src/routes/m-notifications.test.ts apps/server/src/mobile/app.ts
git commit -m "Mobile: push through Expo, with a per-user notification history"
```

---

### Task 17: The store-review switch (server and web)

**Files:**
- Modify: `apps/server/src/routes/users.ts` (three routes), `apps/server/src/db/repositories/users.ts` (`setReview(userId, until: Date | null, by: string | null): Promise<User>`; `mapUser` gains `review_enabled_until`, `review_enabled_by`), `apps/server/src/db/repositories/types.ts` (the two fields on `User`)
- Create: `apps/web/src/components/ReviewAccountPanel.tsx`; modify `apps/web/src/pages/SettingsPage.tsx` (render the panel inside the user detail of the Usuários section, admin only), `apps/web/src/lib/api.ts` (`api.users.setReview`, `api.users.devices`, `api.users.revokeDevice`), `apps/web/src/lib/types.ts`
- Test: `apps/server/src/routes/users.test.ts` (added cases), `apps/web/src/components/ReviewAccountPanel.test.tsx`

**Interfaces:**
- Produces (guarded `users`; the whole Usuários section is admin territory already):
  | Route | action | Behaviour |
  |---|---|---|
  | `POST /users/:id/review` | update (explicit) | body `{ days: z.union([z.literal(1), z.literal(3), z.literal(7)]).nullable(), revoke_devices: z.boolean().default(false) }`. `days` null → off. Refuses an admin target with 400 `REVIEW_ADMIN` "A conta de revisão não pode ser admin." Records `review_changed` (actor `admin:<id>`, meta `{ until }`). With `revoke_devices`, revokes every active device of the target with reason `review`. Answers `{ user }`. |
  | `GET /users/:id/devices` | read | `{ devices, events }` (the target's, last 50 events) |
  | `DELETE /users/:id/devices/:deviceId` | delete | `revokeDevice(deviceId, { reason: 'admin', actor: 'admin:<id>' })`; 404 unless the device belongs to `:id` |

- [ ] **Step 1: Write the failing tests**

Server: the three routes as above, plus "the response `user` carries `review_enabled_until` as an ISO string `now + days`". Web (`ReviewAccountPanel.test.tsx`): renders the switch "Modo revisão" off; turning it on asks for a duration (radio 1 / 3 / 7 dias) and a confirm "Ligar"; calls `api.users.setReview('u2', { days: 3, revoke_devices: false })`; when on, shows "ligado até <data> por <nome>", "Desligar agora" and "Desligar e revogar os aparelhos" (the latter through a `ConfirmDialog`); an admin target shows "A conta de revisão não pode ser admin." and no switch; lists the target's devices with Revogar; renders the note "Essa conta precisa estar no role que tem Chat e Aparelhos (BETA); caso contrário os pedidos do app são ignorados." when the target's role lacks `devices`.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Server: `users.ts` already has the admin-only user detail routes; add the three beside them, using `isAdmin(repos, target)` from `auth/permissions.ts` for the refusal. Web: the panel is a section under the existing user detail (same `PageFrame`/table idioms as the Usuários view); the switch reuses the `role="switch"` markup of `PublishControl.tsx`.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/routes/users.ts apps/server/src/routes/users.test.ts apps/server/src/db/repositories/users.ts apps/server/src/db/repositories/types.ts apps/web/src
git commit -m "Store review: an admin switch with an expiry, and the reviewer's devices"
```

---

### Task 18: Purge, nginx, env, docs and the command-line client

**Files:**
- Modify: `apps/server/src/app.ts` (hourly purge: `enrolment.expire()`, `deviceSessions.purgeExpired(now)`, `deviceRequests.purgeBefore(now - 24h past expiry)`, `deviceEvents.purgeBefore(now - 90d)`, `userNotifications.purgeBefore(now - 30d)`; `push.start()` on boot and its unsubscribe in `onClose`)
- Modify: `deploy/nginx/termhub.dev.conf.tmpl` (the `location` blocks of §12.1, inside the `termhub.dev` server), `.env.example` (`MOBILE_PUBLIC_URL`, `MOBILE_MIN_APP_VERSION`, `EXPO_PUSH_ACCESS_TOKEN` with one-line comments), `README.md` (a "Mobile API" subsection: the prefix, the env vars, the nginx locations, the Cloudflare notes of §12.1 verbatim — WAF rate rule, the challenge-skip rule, the location-headers transform)
- Create: `apps/server/scripts/mobile-client.ts` — a `tsx` script that plays the phone: generates a P-256 key with `jose`, runs the enrolment (`request` → prints the code → polls until approved → asks for a PIN on stdin → `activate`), wraps the secret with a PIN-derived key (scrypt from `node:crypto`, XOR, no tag — exactly what the app will do), then offers `chat`, `send <text>`, `refresh`, `approve <action_id>` and `ws` commands, signing every call with a DPoP proof. State in `~/.cache/termhub/mobile-client.json`.
- Test: `apps/server/src/mobile/purge.test.ts` (the purge function called from `app.ts` is extracted to `mobile/purge.ts: purgeMobile(repos, enrolment, now)` and unit-tested: each repository method called with the right cutoff)

- [ ] **Step 1: Write the failing test**

`purge.test.ts`: with `now = 2026-09-24T12:00:00Z`, `purgeMobile` calls `enrolment.expire()`, `deviceSessions.purgeExpired(now)`, `deviceRequests.purgeBefore(now - 24h)`, `deviceEvents.purgeBefore(now - 90d)`, `userNotifications.purgeBefore(now - 30d)`, and returns the sum.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

`mobile/purge.ts` as specified; `app.ts` adds `void purgeMobile(...).catch(() => {})` to the existing hourly `setInterval`. nginx:

```nginx
    # Mobile API (spec 2026-09-24): per-client budgets; the app authenticates every call itself
    limit_req_zone $http_cf_connecting_ip zone=termhub_mobile:1m rate=10r/s;
    limit_req_zone $http_cf_connecting_ip zone=termhub_mobile_enrol:1m rate=2r/s;
    limit_conn_zone $http_cf_connecting_ip zone=termhub_mobile_conn:1m;
```
(at the top, beside the other zones) and, in the `termhub.dev` server:
```nginx
    location /api/m/v1/devices/requests { limit_req zone=termhub_mobile_enrol burst=5 nodelay; limit_req_status 429; proxy_pass http://$upstream_app:3000; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $http_cf_connecting_ip; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto https; proxy_set_header CF-IPCountry $http_cf_ipcountry; proxy_set_header CF-IPCity $http_cf_ipcity; client_max_body_size 64k; proxy_read_timeout 30s; }
    location /api/m/v1/session/ { limit_req zone=termhub_mobile_enrol burst=5 nodelay; limit_req_status 429; ...same proxy lines...; client_max_body_size 64k; proxy_read_timeout 30s; }
    location = /api/m/v1/transcriptions { limit_except POST { deny all; } limit_req zone=termhub_mobile burst=20 nodelay; limit_req_status 429; ...same proxy lines...; proxy_request_buffering off; client_max_body_size 32m; proxy_read_timeout 120s; }
    location /api/m/ { limit_req zone=termhub_mobile burst=20 nodelay; limit_req_status 429; ...same proxy lines...; client_max_body_size 64k; proxy_read_timeout 60s; }
    location /ws/m/ { limit_conn termhub_mobile_conn 4; proxy_pass http://$upstream_app:3000; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; proxy_set_header X-Real-IP $http_cf_connecting_ip; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto https; proxy_read_timeout 3600s; }
```
Write each block out in full in the template (no "same proxy lines" in the real file). Check the template with a throwaway container named `th-nginx-check` (`nginx -t`), never the live proxy. `MOBILE_PUBLIC_URL` on jarvis is `https://termhub.dev`.

- [ ] **Step 4: Green, end-to-end with the client, commit**

`npm test -w @termhub/server`, then against a local server: run `mobile-client.ts`, approve the request in the web's Aparelhos section (or with `curl` against `/api/devices/requests/:id/approve` using a session cookie), create the PIN, `send "o que está rodando?"`, watch `ws` stream, `approve` a pending action with the PIN, revoke the device on the web and confirm the client gets `DEVICE_REVOKED` and the socket `4401`. Record the transcript (ids only) in the PR description.

```bash
git add apps/server/src/app.ts apps/server/src/mobile/purge.ts apps/server/src/mobile/purge.test.ts deploy/nginx/termhub.dev.conf.tmpl .env.example README.md apps/server/scripts/mobile-client.ts
git commit -m "Mobile: hourly purge, nginx locations, env and a command-line phone"
```

---

## After the last task

- Open the PR against `main` with the spec and this plan linked; the deploy needs `MOBILE_PUBLIC_URL` in `/mnt/hd2tb/projetos/termhub/.env` **before** the merge (the prefix is disabled without it) and the nginx template is rendered by `deploy/blue-green.sh` on the next deploy.
- The manual Cloudflare steps (§12.1: the WAF rate rule and the challenge-skip rule on `/api/m/*`, the optional location-headers transform) are done in the dashboard after the deploy and ticked in the PR.
- The next plan, `2026-09-24-mobile-chat-app.md`, covers `apps/mobile` (Expo), EAS and the store submission, and is written against the contract this plan ships.
