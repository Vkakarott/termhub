// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityLink } from './types';

const { getMock, putMock, deleteMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn(), deleteMock: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  api: { auth: { cityLink: getMock, setCustomCityLink: putMock, clearCustomCityLink: deleteMock } },
}));

import { ApiError } from './api';
import { useCityLink } from './city-link';

const PARTNER: CityLink = { enabled: true, city_url: 'https://termhub.dev/city/@pedro', short_url: 'https://77a.it/pedro', source: 'partner', partner_url: 'https://77a.it/pedro' };

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(PARTNER);
  putMock.mockReset();
  deleteMock.mockReset();
});

describe('useCityLink', () => {
  it('asks nothing while inactive (no nickname yet)', () => {
    const { result } = renderHook(() => useCityLink(false));
    expect(result.current.link).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('loads the link when active', async () => {
    const { result } = renderHook(() => useCityLink(true));
    await waitFor(() => expect(result.current.link).toEqual(PARTNER));
  });

  it('keeps the server’s refusal as the error and says the save failed', async () => {
    putMock.mockRejectedValue(new ApiError(400, 'Esse link leva para https://termhub.dev/city/@ana, não para a sua cidade (https://termhub.dev/city/@pedro).', 'SHORT_LINK_MISMATCH'));
    const { result } = renderHook(() => useCityLink(true));
    await waitFor(() => expect(result.current.link).not.toBeNull());
    let ok = true;
    await act(async () => {
      ok = await result.current.setCustom('https://77a.it/meu');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toMatch(/leva para https:\/\/termhub\.dev\/city\/@ana/);
    expect(result.current.link).toEqual(PARTNER);
  });

  it('takes the answer of a save and of a restore as the new link', async () => {
    const custom: CityLink = { ...PARTNER, short_url: 'https://77a.it/meu', source: 'custom' };
    putMock.mockResolvedValue(custom);
    deleteMock.mockResolvedValue(PARTNER);
    const { result } = renderHook(() => useCityLink(true));
    await waitFor(() => expect(result.current.link).not.toBeNull());
    await act(async () => {
      expect(await result.current.setCustom('https://77a.it/meu')).toBe(true);
    });
    expect(result.current.link).toEqual(custom);
    await act(async () => {
      await result.current.restorePartner();
    });
    expect(result.current.link).toEqual(PARTNER);
  });

  it('keeps a failed restore as the error, and clears it on demand', async () => {
    deleteMock.mockRejectedValue(new ApiError(502, 'Não foi possível criar o link da parceria agora. Seu link curto continua valendo; tente de novo mais tarde.', 'SHORT_LINK_PARTNER_UNAVAILABLE'));
    const { result } = renderHook(() => useCityLink(true));
    await waitFor(() => expect(result.current.link).not.toBeNull());
    await act(async () => {
      await result.current.restorePartner();
    });
    expect(result.current.error).toMatch(/continua valendo/);
    expect(result.current.link).toEqual(PARTNER);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
