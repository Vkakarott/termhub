import { describe, expect, it } from 'vitest';
import { alphaInviteMail } from './templates.js';

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
