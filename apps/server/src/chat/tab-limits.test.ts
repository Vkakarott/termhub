import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAccountUsage, swapAccount, publish } = vi.hoisted(() => ({ getAccountUsage: vi.fn(), swapAccount: vi.fn(), publish: vi.fn() }));
vi.mock('../ai/index.js', () => ({ getAccountUsage }));
vi.mock('../control/account-swap.js', async (orig) => ({ ...(await orig<typeof import('../control/account-swap.js')>()), swapAccount }));
vi.mock('./bus.js', () => ({ chatBus: { publish } }));

import type { Repositories } from '../db/repositories/index.js';
import type { TabLimitNotice } from '../db/repositories/tab-limit-notices.js';
import type { AiAccount, Machine, Tab } from '../db/repositories/types.js';
import { ControlError, type ControlContext } from '../control/context.js';
import { normalizeSetup } from '../setup/schema.js';
import { answerTabLimit, notifyLimitInChat } from './tab-limits.js';

const machine = { id: 'm1', name: 'jarvis', owner_id: 'u1', type: 'agent', capabilities: ['claude'] } as unknown as Machine;
const acc = (id: string, over: Partial<AiAccount> = {}): AiAccount => ({ id, provider: 'claude', label: `conta ${id}`, machine_id: 'm1', config_dir: null, created_at: '', ...over });
const accounts = [acc('a1'), acc('a2'), acc('a3'), acc('c1', { provider: 'chatgpt' }), acc('x1', { machine_id: 'm2' })];
const tab = (over: Partial<Tab> = {}) => ({ id: 't1', name: 'api', project_id: 'p1', machine_id: 'm1', ai_account_id: 'a1', rate_limited_at: '2026-09-30T02:30:00.000Z', ...over }) as Tab;
const usage = (peak: number | null, resets: string | null = null) =>
  peak === null ? { ok: false, windows: [] } : { ok: true, windows: [{ key: '5h', label: '5h', utilization: peak, resets_at: resets }, { key: '7d', label: '7d', utilization: 10, resets_at: 'later' }] };
const log = { info: vi.fn(), warn: vi.fn() };

let setup: Record<string, unknown>;
function build() {
  let row: TabLimitNotice | undefined;
  const r = {
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    chat: { findLatestActiveForProject: vi.fn(async () => ({ id: 'c1' })) },
    projectSetup: { get: vi.fn(async () => ({ data: normalizeSetup(setup, 2) })) },
    aiAccounts: { list: vi.fn(async () => accounts) },
    tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) },
    tabLimitNotices: {
      open: vi.fn(async (input: { tab_id: string; project_id: string; conversation_id: string; limited_at: Date; payload: TabLimitNotice['payload'] }) => {
        row = { id: 'n1', user_id: 'u1', status: 'open', result: null, created_at: 'now', closed_at: null, ...input, limited_at: input.limited_at.toISOString() };
        return row;
      }),
      findForUser: vi.fn(async (_id: string, userId: string) => (userId === 'u1' ? row : undefined)),
      close: vi.fn(async (_id: string, status: TabLimitNotice['status'], result: string | null = null) => (row && row.status === 'open' ? (row = { ...row, status, result }) : undefined)),
    },
  };
  return { r, repos: r as unknown as Repositories, row: () => row };
}

beforeEach(() => {
  vi.clearAllMocks();
  setup = { ai: { accounts: ['a1', 'a3', 'a2'] } };
  getAccountUsage.mockImplementation(async (a: AiAccount) => usage(a.id === 'a1' ? 100 : 20, a.id === 'a1' ? '2026-09-30T03:20:00.000Z' : null));
});

describe('notifyLimitInChat', () => {
  it("opens a card in the project's chat offering the project's other accounts with room, in order", async () => {
    const { r, repos } = build();
    await notifyLimitInChat(repos, log, tab(), machine);
    expect(r.tabLimitNotices.open).toHaveBeenCalledWith({
      tab_id: 't1', project_id: 'p1', conversation_id: 'c1', limited_at: new Date('2026-09-30T02:30:00.000Z'),
      payload: { account: { id: 'a1', label: 'conta a1' }, machine: { id: 'm1', name: 'jarvis' }, resets_at: '2026-09-30T03:20:00.000Z', candidates: [{ id: 'a3', label: 'conta a3' }, { id: 'a2', label: 'conta a2' }] },
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab_limit', user_id: 'u1', conversation_id: 'c1', notice: expect.objectContaining({ id: 'n1', tab_name: 'api' }) }));
  });

  it('leaves out the accounts at their limit, and opens nothing when none has room', async () => {
    getAccountUsage.mockImplementation(async (a: AiAccount) => usage(a.id === 'a3' ? 95 : a.id === 'a2' ? 30 : 100));
    const { r, repos } = build();
    await notifyLimitInChat(repos, log, tab(), machine);
    expect(r.tabLimitNotices.open.mock.calls[0][0].payload.candidates).toEqual([{ id: 'a2', label: 'conta a2' }]);
    getAccountUsage.mockResolvedValue(usage(99));
    const other = build();
    await notifyLimitInChat(other.repos, log, tab(), machine);
    expect(other.r.tabLimitNotices.open).not.toHaveBeenCalled();
  });

  it('opens nothing for a project without accounts on the machine, or with only the tab own account', async () => {
    for (const s of [{}, { ai: { accounts: ['x1', 'c1'] } }, { ai: { accounts: ['a1'] } }]) {
      setup = s;
      const { r, repos } = build();
      await notifyLimitInChat(repos, log, tab(), machine);
      expect(r.tabLimitNotices.open).not.toHaveBeenCalled();
    }
  });

  it('opens nothing without a chat for the project, or once the limit is over', async () => {
    const { r, repos } = build();
    r.chat.findLatestActiveForProject.mockResolvedValue(undefined as never);
    await notifyLimitInChat(repos, log, tab(), machine);
    await notifyLimitInChat(repos, log, tab({ rate_limited_at: null }), machine);
    expect(r.tabLimitNotices.open).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { r, repos } = build();
    r.projectSetup.get.mockRejectedValue(new Error('db down'));
    await expect(notifyLimitInChat(repos, log, tab(), machine)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('answerTabLimit', () => {
  async function opened(grants = ['terminals:update']) {
    const built = build();
    await notifyLimitInChat(built.repos, log, tab(), machine);
    const scoped = { tab: vi.fn(async () => ({ tab: tab(), machine })) };
    const ctx = { repos: built.repos, scope: { user: { id: 'u1' } }, scoped, can: async (res: string, act: string) => grants.includes(`${res}:${act}`) } as unknown as ControlContext;
    return { ...built, ctx, scoped };
  }

  it('swaps the tab to the chosen account and closes the card as swapped', async () => {
    const { ctx } = await opened();
    swapAccount.mockResolvedValue({ from: null, to: { id: 'a3', label: 'conta a3' } });
    const view = await answerTabLimit(ctx, log as never, 'n1', 'a3');
    expect(swapAccount).toHaveBeenCalledWith(ctx.repos, log, expect.objectContaining({ id: 't1' }), machine, { accountId: 'a3', auto: false });
    expect(view).toMatchObject({ status: 'swapped', result: 'a3' });
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'tab_limit_closed' }));
  });

  it('"Esperar" dismisses the card without touching the tab', async () => {
    const { ctx } = await opened();
    expect((await answerTabLimit(ctx, log as never, 'n1', null)).status).toBe('dismissed');
    expect(swapAccount).not.toHaveBeenCalled();
  });

  it('keeps the card open and says why when the swap fails', async () => {
    const { ctx, row } = await opened();
    swapAccount.mockRejectedValue(new ControlError('RELINK_FAILED', 'A sessão não pôde ser preparada'));
    await expect(answerTabLimit(ctx, log as never, 'n1', 'a3')).rejects.toMatchObject({ statusCode: 409, message: 'A sessão não pôde ser preparada' });
    expect(row()?.status).toBe('open');
  });

  it('refuses an account the card did not offer, another user, a closed card, and a missing grant', async () => {
    const { ctx } = await opened();
    await expect(answerTabLimit(ctx, log as never, 'n1', 'a1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(answerTabLimit({ ...ctx, scope: { user: { id: 'u2' } } } as never, log as never, 'n1', 'a3')).rejects.toMatchObject({ statusCode: 404 });
    const { ctx: noGrant } = await opened([]);
    await expect(answerTabLimit(noGrant, log as never, 'n1', 'a3')).rejects.toMatchObject({ statusCode: 403 });
    await answerTabLimit(ctx, log as never, 'n1', null);
    await expect(answerTabLimit(ctx, log as never, 'n1', null)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('expires the card when its tab is gone', async () => {
    const { ctx, scoped, row } = await opened();
    scoped.tab.mockRejectedValue(new Error('404'));
    await expect(answerTabLimit(ctx, log as never, 'n1', 'a3')).rejects.toMatchObject({ statusCode: 409 });
    expect(row()?.status).toBe('expired');
  });
});
