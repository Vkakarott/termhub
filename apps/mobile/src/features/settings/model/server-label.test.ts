import { serverLabel } from './server-label';

describe('serverLabel', () => {
  it('says mock in mock mode, whatever the URL', () => {
    expect(serverLabel('mock', 'https://staging.termhub.dev')).toBe('Servidor: mock');
  });

  it("names the host of TERMHUB_URL in http mode, port included, path dropped", () => {
    expect(serverLabel('http', 'https://termhub.dev')).toBe('Servidor: termhub.dev');
    expect(serverLabel('http', 'https://staging.termhub.dev/')).toBe('Servidor: staging.termhub.dev');
    expect(serverLabel('http', 'http://192.168.0.10:3000/base')).toBe('Servidor: 192.168.0.10:3000');
  });
});
