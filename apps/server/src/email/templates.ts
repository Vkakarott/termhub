import type { Mail } from './mailer.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function loginCodeMail(to: string, code: string, ttlMinutes: number): Mail {
  const subject = `${code} — seu código de acesso ao termhub`;
  const text = `Seu código de acesso ao termhub é: ${code}\n\nEle expira em ${ttlMinutes} minutos. Se você não pediu este código, ignore este e-mail.`;
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Código de acesso</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 20px;text-align:center;font-size:14px;color:#9aa1b1;">Seu código de acesso é</td></tr>
        <tr><td style="padding:0 32px;">
          <div style="background:rgba(79,140,255,0.08);border:1px solid rgba(79,140,255,0.25);border-radius:10px;padding:20px;text-align:center;">
            <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#4f8cff;font-family:'SF Mono',Menlo,Consolas,monospace;">${esc(code)}</span>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;text-align:center;font-size:12px;color:#6b7280;line-height:1.6;">
          Expira em ${ttlMinutes} minutos.<br/>Se você não pediu este código, ignore este e-mail.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject, html, text };
}

/** Invite: the user already exists (created with the chosen role); they just need to sign in. */
export function inviteMail(to: string, opts: { invitedBy: string; appUrl: string; roleLabel: string; accessAllowlisted: boolean }): Mail {
  const subject = `${opts.invitedBy} convidou você para o termhub`;
  const howTo = 'Entre com sua conta Google usando este mesmo e-mail, ou peça um código de acesso na tela de login.';
  const text = `${opts.invitedBy} convidou você para o termhub como ${opts.roleLabel}.\n\nAcesse: ${opts.appUrl}\n\n${howTo}${
    opts.accessAllowlisted ? '\n\nSeu e-mail já foi liberado no Cloudflare Access; use-o na tela de identificação que aparece antes do app.' : ''
  }\n\nSe você não esperava este convite, ignore este e-mail.`;
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Convite para o termhub</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 8px;text-align:center;font-size:14px;color:#e6e8ee;line-height:1.6;">
          <strong>${esc(opts.invitedBy)}</strong> convidou você para o termhub como <strong>${esc(opts.roleLabel)}</strong>.
        </td></tr>
        <tr><td style="padding:12px 32px 20px;text-align:center;">
          <a href="${esc(opts.appUrl)}" style="display:inline-block;background:#4f8cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:10px;">Acessar o termhub</a>
        </td></tr>
        <tr><td style="padding:0 32px 8px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">${esc(howTo)}</td></tr>
        ${
          opts.accessAllowlisted
            ? `<tr><td style="padding:0 32px 8px;text-align:center;font-size:12px;color:#9aa1b1;line-height:1.6;">Seu e-mail já foi liberado no Cloudflare Access; use-o na tela de identificação que aparece antes do app.</td></tr>`
            : ''
        }
        <tr><td style="padding:16px 32px 28px;text-align:center;font-size:12px;color:#6b7280;line-height:1.6;">
          Link: <a href="${esc(opts.appUrl)}" style="color:#4f8cff;">${esc(opts.appUrl)}</a><br/>Se você não esperava este convite, ignore este e-mail.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject, html, text };
}

/** Links the landing's footer shows; mirrored at the bottom of the alpha e-mail. */
const REPO_URL = 'https://github.com/engenhariainversa/termhub';
const COFFEE_URL = 'https://buymeacoffee.com/pedrogoiania';

const ALPHA_COPY = {
  pt: {
    subject: 'Você está na alpha do termhub 🚀',
    hi: (name: string) => `Oi, ${name}!`,
    intro: 'Obrigado por entrar na waitlist do termhub Cloud. Chegou a sua vez: liberamos o seu acesso à alpha.',
    cta: 'Acessar o termhub',
    howTo: 'Entre com sua conta Google usando este mesmo e-mail, ou peça um código de acesso na tela de login.',
    communityTitle: 'Grupo dos alpha testers',
    communityBody: 'Criamos um grupo no WhatsApp para os alpha testers: é por lá que a gente combina o que testar, ouve seus feedbacks e avisa das novidades.',
    communityCta: 'Entrar no grupo do WhatsApp',
    link: 'Link',
    ignore: 'Se você não esperava este convite, ignore este e-mail.',
    footer: { docs: 'Documentação', brand: 'Marca', coffee: '☕ Buy me a coffee', made: 'feito em Goiânia' },
  },
  en: {
    subject: "You're in the termhub alpha 🚀",
    hi: (name: string) => `Hi, ${name}!`,
    intro: "Thanks for joining the termhub Cloud waitlist. It's your turn: your alpha access is now open.",
    cta: 'Open termhub',
    howTo: 'Sign in with your Google account using this same e-mail, or request an access code on the login screen.',
    communityTitle: 'Alpha testers group',
    communityBody: "There's a WhatsApp group for the alpha testers: that's where we decide what to test next, hear your feedback and share what's new.",
    communityCta: 'Join the WhatsApp group',
    link: 'Link',
    ignore: "If you weren't expecting this invite, ignore this e-mail.",
    footer: { docs: 'Documentation', brand: 'Brand', coffee: '☕ Buy me a coffee', made: 'made in Goiânia' },
  },
} as const;

export type AlphaLocale = keyof typeof ALPHA_COPY;

/**
 * Alpha-tester invite sent to waitlist sign-ups: the user already exists (like inviteMail),
 * plus the WhatsApp community link. Written in the language the person used on the landing.
 */
export function alphaInviteMail(to: string, opts: { appUrl: string; communityUrl: string; firstName: string; locale: AlphaLocale }): Mail {
  const c = ALPHA_COPY[opts.locale];
  const year = new Date().getFullYear();
  const text = `${c.hi(opts.firstName)}\n\n${c.intro}\n\n${c.cta}: ${opts.appUrl}\n${c.howTo}\n\n${c.communityTitle}\n${c.communityBody}\n${c.communityCta}: ${opts.communityUrl}\n\n${c.ignore}\n\n© ${year} termhub · MIT · ${REPO_URL} · ${c.footer.made}`;
  const footerLink = (href: string, label: string) =>
    `<a href="${esc(href)}" style="color:#9aa1b1;text-decoration:none;white-space:nowrap;margin:0 8px;">${esc(label)}</a>`;
  const html = `<!DOCTYPE html>
<html lang="${opts.locale === 'pt' ? 'pt-BR' : 'en'}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 8px;text-align:center;font-size:14px;color:#e6e8ee;line-height:1.6;">
          <strong>${esc(c.hi(opts.firstName))}</strong><br/>${esc(c.intro)}
        </td></tr>
        <tr><td style="padding:12px 32px 20px;text-align:center;">
          <a href="${esc(opts.appUrl)}" style="display:inline-block;background:#4f8cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:10px;">${esc(c.cta)}</a>
        </td></tr>
        <tr><td style="padding:0 32px 20px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">${esc(c.howTo)}</td></tr>
        <tr><td style="padding:0 32px 8px;">
          <div style="background:rgba(37,211,102,0.08);border:1px solid rgba(37,211,102,0.3);border-radius:10px;padding:18px 20px;text-align:center;">
            <div style="font-size:14px;font-weight:700;color:#e6e8ee;margin-bottom:6px;">${esc(c.communityTitle)}</div>
            <div style="font-size:13px;color:#9aa1b1;line-height:1.6;margin-bottom:14px;">${esc(c.communityBody)}</div>
            <a href="${esc(opts.communityUrl)}" style="display:inline-block;background:#25d366;color:#0f1115;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:10px;">${esc(c.communityCta)}</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;text-align:center;font-size:12px;color:#6b7280;line-height:1.6;">
          ${esc(c.link)}: <a href="${esc(opts.communityUrl)}" style="color:#4f8cff;">${esc(opts.communityUrl)}</a><br/>${esc(c.ignore)}
        </td></tr>
        <tr><td style="padding:16px 32px 22px;border-top:1px solid #2a2f3a;font-size:11px;color:#6b7280;line-height:1.8;">
          <div style="text-align:center;">
            ${footerLink(REPO_URL, 'GitHub')}${footerLink(`${REPO_URL}/blob/main/README.md`, c.footer.docs)}${footerLink('https://termhub.dev/brand/', c.footer.brand)}${footerLink(COFFEE_URL, c.footer.coffee)}
          </div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:11px;color:#6b7280;">© ${year} termhub · MIT</td>
            <td style="font-size:11px;color:#6b7280;text-align:right;">${esc(c.footer.made)}</td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject: c.subject, html, text };
}
