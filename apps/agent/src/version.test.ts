import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_VERSION } from './version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(here, '..', 'package.json');

describe('AGENT_VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(AGENT_VERSION).toBe(pkg.version);
  });
});
