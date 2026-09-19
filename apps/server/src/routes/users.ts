import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { toPublicUser, type User } from '../db/repositories/types.js';
import type { Role } from '../db/repositories/roles.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { Mailer } from '../email/mailer.js';
import { alphaInviteMail, inviteMail, type AlphaLocale } from '../email/templates.js';
import type { Mail } from '../email/mailer.js';
import type { AccessAllowlist } from '../cloudflare/access.js';
import { config } from '../config.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const patchBody = z.object({ role_id: z.string().min(1).max(64) });
const inviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(120).optional(),
  role_id: z.string().min(1).max(64),
});
const inviteFromWaitlistBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
  role_id: z.string().min(1).max(64),
});

export interface UserRouteDeps {
  mailer: Mailer;
  access: AccessAllowlist;
}

/** Outcome of the two side effects of an invite; the user row itself is never rolled back. */
interface InviteSideEffects {
  access: { configured: boolean; synced: boolean; error?: string };
  mail: { sent: boolean; error?: string };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withRoleInfo(u: User, role: Role | undefined) {
  return { ...toPublicUser(u), role_info: role ? { id: role.id, name: role.name, label: role.label, is_admin: role.is_admin } : null };
}

/** User administration. Guarded as resource "users" (see app.ts). */
export async function userRoutes(app: FastifyInstance, repos: Repositories, deps: UserRouteDeps) {
  /** Allowlist the e-mail and send the invite; failures are reported, not thrown (the user already exists). */
  async function runInvite(user: User, role: Role, invitedBy: string, log: FastifyBaseLogger, mail?: (accessAllowlisted: boolean) => Mail): Promise<InviteSideEffects> {
    const out: InviteSideEffects = { access: { configured: !!config.cloudflareAccess, synced: false }, mail: { sent: false } };
    if (config.cloudflareAccess) {
      try {
        await deps.access.add(user.email);
        out.access.synced = true;
      } catch (err) {
        out.access.error = errMessage(err);
        log.warn({ err, userId: user.id }, 'invite: cloudflare access allowlist failed');
      }
    }
    try {
      await deps.mailer.send(
        mail ? mail(out.access.synced) : inviteMail(user.email, { invitedBy, appUrl: config.publicUrl, roleLabel: role.label, accessAllowlisted: out.access.synced }),
      );
      out.mail.sent = true;
    } catch (err) {
      out.mail.error = errMessage(err);
      log.warn({ err, userId: user.id }, 'invite: e-mail failed');
    }
    return out;
  }

  app.get('/', async () => {
    const [users, roles] = await Promise.all([repos.users.list(), repos.roles.list()]);
    const byId = new Map(roles.map((r) => [r.id, r]));
    return { users: users.map((u) => withRoleInfo(u, u.role_id ? byId.get(u.role_id) : undefined)) };
  });

  /** Cloudflare Access allowlist as seen from the API (which e-mails can reach the app). */
  app.get('/access', async () => {
    try {
      return await deps.access.status();
    } catch (err) {
      return { configured: true, domain: config.cloudflareAccess?.appDomain, emails: [], error: errMessage(err) };
    }
  });

  /** Invite = create the user with a role (no password: Google or e-mail code), allowlist and e-mail. */
  app.post('/invite', async (request, reply) => {
    const body = inviteBody.parse(request.body);
    const role = await repos.roles.findById(body.role_id);
    if (!role) throw badRequest('Role inexistente');
    if (await repos.users.findByEmail(body.email)) throw conflict('Já existe um usuário com este e-mail');
    const user = await repos.users.create({
      email: body.email,
      name: body.name || body.email.split('@')[0]!,
      role_id: role.id,
      role: role.is_admin ? 'owner' : 'member',
      invited_at: new Date(),
    });
    const effects = await runInvite(user, role, request.user?.name ?? 'Alguém', request.log);
    request.log.info({ userId: user.id, roleId: role.id, access: effects.access.synced, mail: effects.mail.sent }, 'user invited');
    return reply.code(201).send({ user: withRoleInfo(user, role), ...effects });
  });

  /**
   * Alpha invite from the Waitlist tab: for each entry, create the user with the chosen role
   * (or reuse the account that already has that e-mail), run the invite side effects with the
   * alpha-tester e-mail (app link + WhatsApp community, in the entry's language) and stamp
   * invited_at on the entry. Per-entry outcomes are reported, never thrown, so one bad
   * address does not stop the batch.
   */
  app.post('/invite-from-waitlist', async (request) => {
    const body = inviteFromWaitlistBody.parse(request.body);
    const role = await repos.roles.findById(body.role_id);
    if (!role) throw badRequest('Role inexistente');
    const entries = new Map((await repos.waitlist.findByIds(body.ids)).map((e) => [e.id, e]));
    const results: Array<{ id: string; error: string } | ({ id: string; user_id: string; existing: boolean } & InviteSideEffects)> = [];
    const invited: string[] = [];
    for (const id of body.ids) {
      const entry = entries.get(id);
      if (!entry) {
        results.push({ id, error: 'Entry not found' });
        continue;
      }
      let user = await repos.users.findByEmail(entry.email);
      const existing = !!user;
      if (!user) {
        user = await repos.users.create({
          email: entry.email,
          name: `${entry.first_name} ${entry.last_name}`.trim(),
          role_id: role.id,
          role: role.is_admin ? 'owner' : 'member',
          invited_at: new Date(),
        });
      }
      const locale: AlphaLocale = entry.locale === 'en' ? 'en' : 'pt';
      const effects = await runInvite(user, role, request.user?.name ?? 'Alguém', request.log, () =>
        alphaInviteMail(user!.email, { appUrl: config.publicUrl, communityUrl: config.alphaCommunityUrl, firstName: entry.first_name, locale }),
      );
      invited.push(id);
      results.push({ id, user_id: user.id, existing, ...effects });
    }
    await repos.waitlist.markInvited(invited);
    request.log.info({ invited: invited.length, roleId: role.id }, 'alpha invites sent from waitlist');
    return { results };
  });

  /** Re-run the invite side effects (e-mail bounced, allowlist edited by hand, …). */
  app.post('/:id/invite', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const user = await repos.users.findById(id);
    if (!user) throw notFound('Usuário não encontrado');
    const role = user.role_id ? await repos.roles.findById(user.role_id) : undefined;
    if (!role) throw badRequest('Usuário sem role; defina uma antes de reenviar o convite');
    const effects = await runInvite(user, role, request.user?.name ?? 'Alguém', request.log);
    return { user: withRoleInfo(user, role), ...effects };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { role_id } = patchBody.parse(request.body);
    const user = await repos.users.findById(id);
    if (!user) throw notFound('Usuário não encontrado');
    const role = await repos.roles.findById(role_id);
    if (!role) throw badRequest('Role inexistente');
    // never leave the system without an admin
    if (!role.is_admin && user.role_id) {
      const current = await repos.roles.findById(user.role_id);
      if (current?.is_admin && (await repos.users.countAdmins()) <= 1) throw badRequest('Este é o único administrador; promova outro antes');
    }
    const updated = await repos.users.setRole(id, role.id, role.is_admin ? 'owner' : 'member');
    return { user: updated && withRoleInfo(updated, role) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    if (id === request.user?.id) throw badRequest('Você não pode excluir a si mesmo');
    const user = await repos.users.findById(id);
    if (!user) throw notFound('Usuário não encontrado');
    if (user.role_id) {
      const role = await repos.roles.findById(user.role_id);
      if (role?.is_admin && (await repos.users.countAdmins()) <= 1) throw badRequest('Este é o único administrador');
    }
    await repos.users.delete(id);
    // Best effort: the account is gone either way; a stale allowlist entry only lets them reach the login screen.
    let accessRemoved = false;
    try {
      await deps.access.remove(user.email);
      accessRemoved = true;
    } catch (err) {
      request.log.warn({ err, userId: id }, 'user delete: cloudflare access allowlist removal failed');
    }
    return { ok: true, access_removed: accessRemoved };
  });
}
