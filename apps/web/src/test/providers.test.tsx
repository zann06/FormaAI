import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../lib/session';
import { ToastProvider } from '../lib/toast';
import { ProvidersPage } from '../pages/ProvidersPage';
import { installFetchMock } from '../test/fetchMock';

function renderProviders() {
  return render(
    <SessionProvider>
      <ToastProvider>
        <MemoryRouter>
          <ProvidersPage />
        </MemoryRouter>
      </ToastProvider>
    </SessionProvider>,
  );
}

const credential = {
  id: 'cred-1',
  displayName: 'OpenAI',
  providerType: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  keyLast4: '1234',
  keyFingerprint: 'abc',
  sessionOnly: false,
  isDefault: true,
  lastTestStatus: null,
  lastTestMessage: null,
  lastTestedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('ProvidersPage', () => {
  it('creates a provider with the exact API payload and never stores the key in the DOM', async () => {
    let created = false;
    const { calls } = installFetchMock({
      'GET /api/auth/session': () => ({
        json: { user: { id: 'u1', email: 'a@b.test', role: 'user', displayName: 'A' }, fallbackCredentialId: null, registrationEnabled: true },
      }),
      'GET /api/provider-credentials': () => ({
        json: { credentials: created ? [credential] : [], supportedTypes: ['openai-compatible', 'anthropic', 'gemini'], devProviderEnabled: false },
      }),
      'POST /api/provider-credentials': () => {
        created = true;
        return { status: 201, json: { credential } };
      },
    });

    renderProviders();
    await screen.findByText('No AI provider configured');

    await userEvent.click(screen.getByRole('button', { name: 'Add your first provider' }));
    await userEvent.type(screen.getByLabelText('Name'), 'OpenAI');
    await userEvent.type(screen.getByLabelText('Model'), 'gpt-4o-mini');
    await userEvent.type(screen.getByLabelText('API key'), 'sk-super-secret-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save provider' }));

    await waitFor(() => {
      const create = calls.find((call) => call.method === 'POST' && call.path === '/api/provider-credentials');
      expect(create?.body).toMatchObject({
        displayName: 'OpenAI',
        providerType: 'openai-compatible',
        model: 'gpt-4o-mini',
        apiKey: 'sk-super-secret-key',
        baseUrl: 'https://api.openai.com/v1',
      });
    });

    // After saving, the key must not be rendered anywhere.
    await screen.findByText('OpenAI');
    expect(document.body.textContent).not.toContain('sk-super-secret-key');
    expect(document.body.textContent).toContain('1234');
  });

  it('blocks saving a provider without an API key', async () => {
    const { calls } = installFetchMock({
      'GET /api/auth/session': () => ({
        json: { user: { id: 'u1', email: 'a@b.test', role: 'user', displayName: 'A' }, fallbackCredentialId: null, registrationEnabled: true },
      }),
      'GET /api/provider-credentials': () => ({ json: { credentials: [], supportedTypes: [], devProviderEnabled: false } }),
    });

    renderProviders();
    await screen.findByText('No AI provider configured');
    await userEvent.click(screen.getByRole('button', { name: 'Add your first provider' }));
    await userEvent.type(screen.getByLabelText('Name'), 'X');
    await userEvent.type(screen.getByLabelText('Model'), 'm');
    await userEvent.click(screen.getByRole('button', { name: 'Save provider' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your API key');
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/provider-credentials')).toBe(false);
  });
});
