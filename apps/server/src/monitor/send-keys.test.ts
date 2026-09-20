import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';

const { sendTextToSession } = vi.hoisted(() => ({ sendTextToSession: vi.fn() }));
vi.mock('../terminal/session-ops.js', () => ({ INPUT_MAX_CHARS: 4000, sendTextToSession }));

const { sendKeysToSession } = await import('./send-keys.js');

const machine = { id: 'm1', type: 'local' } as Machine;

beforeEach(() => vi.resetAllMocks());

describe('sendKeysToSession', () => {
  it('reports success', async () => {
    sendTextToSession.mockResolvedValue(undefined);
    await expect(sendKeysToSession(machine, 's1', 'oi', true)).resolves.toEqual({ ok: true, error: null });
  });

  it('surfaces an HttpError message as-is — it is already pt-BR and meant for the user', async () => {
    sendTextToSession.mockRejectedValue(new HttpError(504, 'A máquina não respondeu', 'MACHINE_TIMEOUT'));
    await expect(sendKeysToSession(machine, 's1', 'oi', true)).resolves.toEqual({ ok: false, error: 'A máquina não respondeu' });
  });

  it('never leaks a non-HttpError message (e.g. a Node/OS error) to the user, and logs it instead', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const internal = new TypeError("The argument 'args[1]' must be a string without null bytes.");
    sendTextToSession.mockRejectedValue(internal);

    const result = await sendKeysToSession(machine, 's1', 'oi\u0000', true);

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/null bytes/i);
    expect(result.error).toBe('Não foi possível enviar o texto para o terminal. Tente novamente.');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('sendKeysToSession'), internal);

    consoleError.mockRestore();
  });

  it('still throws synchronously for text over INPUT_MAX_CHARS, before touching the session', async () => {
    const long = 'x'.repeat(4001);
    await expect(sendKeysToSession(machine, 's1', long, true)).rejects.toThrow('Texto longo demais');
    expect(sendTextToSession).not.toHaveBeenCalled();
  });
});
