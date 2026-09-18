import { describe, expect, it } from 'vitest';
import { parseSetupOutput, wdaSetupScript } from './setup.js';

describe('parseSetupOutput', () => {
  it('lê estado, versão e tail', () => {
    const out = 'STATE:ok\nVERSION:16.12.8\nTAIL:\nlinha 1\nlinha 2\n';
    expect(parseSetupOutput(out)).toEqual({ state: 'ok', version: '16.12.8', tail: ['linha 1', 'linha 2'] });
  });

  it('sem versão devolve null e sem tail devolve []', () => {
    expect(parseSetupOutput('STATE:idle\nVERSION:\nTAIL:\n')).toEqual({ state: 'idle', version: null, tail: [] });
  });

  it('estado desconhecido vira failed', () => {
    expect(parseSetupOutput('lixo').state).toBe('failed');
  });
});

describe('wdaSetupScript', () => {
  it('clona ou atualiza, compila sem assinatura e grava status', () => {
    const s = wdaSetupScript();
    expect(s).toContain('git clone --depth 1 https://github.com/appium/WebDriverAgent');
    expect(s).toContain('git -C "$HOME/.termhub/WebDriverAgent" pull --ff-only');
    expect(s).toContain("-destination 'generic/platform=iOS Simulator'");
    expect(s).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(s).toContain('wda-setup.status');
  });
});
