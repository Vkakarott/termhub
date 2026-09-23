// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BetaForm } from './BetaForm';

const fetchMock = vi.fn();
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** A complete, valid sign-up, as a person would type it. */
function fill(email = 'ana@gmail.com') {
  type(/^nome$/i, 'Ana');
  type(/sobrenome/i, 'Souza');
  type(/e-mail/i, email);
  type(/ddd/i, '11');
  type(/número/i, '98765-4321');
}

const submit = () => screen.getByRole('button', { name: /entrar no beta gratuito/i });

describe('BetaForm', () => {
  it('posts the waitlist body to /api/waitlist and says the sign-up was received', async () => {
    fetchMock.mockResolvedValueOnce(answer(201, { ok: true, already: false }));
    render(<BetaForm />);
    fill();
    fireEvent.click(submit());

    expect(await screen.findByText(/inscrição recebida/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/waitlist');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toEqual({
      first_name: 'Ana',
      last_name: 'Souza',
      email: 'ana@gmail.com',
      phone_country: '55',
      phone_area: '11',
      phone_number: '987654321',
      linkedin: null,
      github: null,
      locale: 'pt',
      website: '',
    });
  });

  it('says so when the address is already on the list', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { ok: true, already: true }));
    render(<BetaForm />);
    fill();
    fireEvent.click(submit());

    expect(await screen.findByText(/já está inscrito/i)).toBeTruthy();
  });

  it('keeps the button off and explains a non-Gmail address before anything is sent', () => {
    render(<BetaForm />);
    fill('ana@hotmail.com');
    fireEvent.blur(screen.getByLabelText(/e-mail/i));

    expect(screen.getByText(/use um endereço @gmail\.com/i)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it('puts the server gmail_only answer under the e-mail field', async () => {
    fetchMock.mockResolvedValueOnce(answer(400, { error: 'Use um endereço @gmail.com', code: 'gmail_only' }));
    render(<BetaForm />);
    fill();
    fireEvent.click(submit());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/@gmail\.com/);
    expect(screen.getByLabelText(/e-mail/i).getAttribute('aria-invalid')).toBe('true');
  });

  it('marks the field a validation error points at', async () => {
    fetchMock.mockResolvedValueOnce(answer(400, { error: 'Dados inválidos', code: 'VALIDATION', issues: [{ path: ['phone_area'], message: 'only digits' }] }));
    render(<BetaForm />);
    fill();
    fireEvent.click(submit());

    await screen.findByRole('alert');
    expect(screen.getByLabelText(/ddd/i).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(/^nome$/i).getAttribute('aria-invalid')).toBe('false');
  });

  it('shows a generic error when the server could not take it', async () => {
    fetchMock.mockResolvedValueOnce(answer(500, { error: 'Erro interno', code: 'ERROR' }));
    render(<BetaForm />);
    fill();
    fireEvent.click(submit());

    expect((await screen.findByRole('alert')).textContent).toMatch(/não foi possível enviar/i);
    // the form stays, so the person can try again
    expect(submit()).toBeTruthy();
  });
});
