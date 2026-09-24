import { describe, expect, it } from 'vitest';
import { alphaInviteMail, deviceRequestMail, deviceRevokedMail } from './templates.js';

const opts = { appUrl: 'https://app.termhub.dev', communityUrl: 'https://77a.it/comunidadetermhub', firstName: 'Ana' };

describe('alphaInviteMail', () => {
  it('writes the Portuguese variant with the app and community links', () => {
    const mail = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'pt' });
    expect(mail.to).toBe('ana@gmail.com');
    expect(mail.subject).toContain('alpha');
    expect(mail.text).toContain('Ana');
    expect(mail.text).toContain(opts.appUrl);
    expect(mail.text).toContain(opts.communityUrl);
    expect(mail.text).toContain('WhatsApp');
    expect(mail.html).toContain(`href="${opts.communityUrl}"`);
  });

  it('writes the English variant for locale en', () => {
    const mail = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'en' });
    expect(mail.subject).toMatch(/alpha/i);
    expect(mail.text).toContain('WhatsApp');
    expect(mail.text).toContain(opts.communityUrl);
    expect(mail.text).not.toMatch(/você|grupo/i);
    expect(mail.html).toContain('lang="en"');
  });

  it('carries the site footer (license, GitHub, docs, coffee, made in Goiânia)', () => {
    const pt = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'pt' });
    expect(pt.html).toContain('termhub · MIT');
    expect(pt.html).toContain('href="https://github.com/engenhariainversa/termhub"');
    expect(pt.html).toContain('href="https://github.com/engenhariainversa/termhub/blob/main/README.md"');
    expect(pt.html).toContain('href="https://buymeacoffee.com/pedrogoiania"');
    expect(pt.html).toContain('feito em Goiânia');
    const en = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'en' });
    expect(en.html).toContain('made in Goiânia');
  });

  it('escapes the first name in the html', () => {
    const mail = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'pt', firstName: '<b>Ana</b>' });
    expect(mail.html).not.toContain('<b>Ana</b>');
    expect(mail.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });
});

describe('deviceRequestMail', () => {
  it('carries the formatted code, the place, the link and escapes the device label', () => {
    const appUrl = 'https://app.termhub.dev';
    const mail = deviceRequestMail('a@b.c', { deviceLabel: 'iPhone 15 (iOS 18.1)', code: 'K7F2QD', place: 'São Paulo, BR', ip: '1.2.3.4', appUrl });
    expect(mail.to).toBe('a@b.c');
    expect(mail.subject).toBe('Um aparelho pede acesso à sua conta');
    expect(mail.text).toContain('K7F-2QD');
    expect(mail.html).toContain('K7F-2QD');
    expect(mail.text).toContain('São Paulo, BR');
    expect(mail.text).toContain('1.2.3.4');
    expect(mail.text).toContain('iPhone 15 (iOS 18.1)');
    expect(mail.text).toContain(`${appUrl}/settings/devices`);
    expect(mail.html).toContain(`href="${appUrl}/settings/devices"`);
    const evil = deviceRequestMail('a@b.c', { deviceLabel: '<script>x</script>', code: 'K7F2QD', place: 'X', ip: '1.2.3.4', appUrl });
    expect(evil.html).not.toContain('<script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });
});

describe('deviceRevokedMail', () => {
  it('names the device and the time, says nothing else changed, and escapes the label', () => {
    const at = new Date('2026-09-24T15:30:00.000Z');
    const mail = deviceRevokedMail('a@b.c', { deviceLabel: 'iPhone de Ana (iPhone 15)', at });
    expect(mail.to).toBe('a@b.c');
    expect(mail.subject).toBe('Um aparelho foi removido da sua conta por tentativas de PIN');
    expect(mail.text).toContain('iPhone de Ana (iPhone 15)');
    expect(mail.text).toContain('24/09/2026');
    expect(mail.text).toContain('Nada mais foi alterado');
    const evil = deviceRevokedMail('a@b.c', { deviceLabel: '<script>x</script>' });
    expect(evil.html).not.toContain('<script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });
});
