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
