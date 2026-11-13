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

  /**
   * Typing a model identifier by hand is how a report ends up failing with HTTP
   * 404 on every section. A router such as 9router publishes its catalogue at
   * `GET /models`, so the real list must be offered as a picker.
   */
  it('loads the providerâ€™s real model list and keeps the current model selected', async () => {
    const { calls } = installFetchMock({
      'GET /api/auth/session': () => ({
        json: { user: { id: 'u1', email: 'a@b.test', role: 'user', displayName: 'A' }, fallbackCredentialId: null, registrationEnabled: true },
      }),
      'GET /api/provider-credentials': () => ({
        json: { credentials: [credential], supportedTypes: ['openai-compatible'], devProviderEnabled: false },
      }),
      'GET /api/provider-credentials/cred-1/models': () => ({
        json: {
          models: ['cbai/deepseek-v3-2-volc', 'cbai/deepseek-v4.1-flash', 'cbai/glm-5.0'],
          message: '3 models available.',
          supported: true,
        },
      }),
    });

    renderProviders();
    await screen.findByText('OpenAI');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(await screen.findByRole('button', { name: /Load models from server/i }));

    // The picker is now the branded combobox, not the browser's native <select>,
    // so its options live in a listbox that is only mounted while it is open.
    const picker = (await screen.findByLabelText('Model')) as HTMLButtonElement;
    await waitFor(() => expect(picker.getAttribute('role')).toBe('combobox'));
    await userEvent.click(picker);

    // The catalogue comes from the server, and the still-configured model stays
    // selectable even though this provider no longer lists it â€” otherwise saving
    // the form would silently switch the user's model to the first entry.
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(options.map((option) => option.textContent?.replace(/[✓\s]/g, ''))).toEqual([
      'gpt-4o-mini',
      'cbai/deepseek-v3-2-volc',
      'cbai/deepseek-v4.1-flash',
      'cbai/glm-5.0',
    ]);
    // The current model is still the selected one.
    expect(picker.textContent).toContain('gpt-4o-mini');
    await userEvent.keyboard('{Escape}');
    // Escape closed the list, not the whole dialog: the form and its warning are
    // still on screen. (Before the fix one Escape closed both and lost the form.)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.tagName === 'P' && /not in that list/.test(element.textContent ?? '')),
    ).toBeInTheDocument();    expect(calls.some((call) => call.path === '/api/provider-credentials/cred-1/models')).toBe(true);
  });

  /**
   * Choosing a model has to actually change the value, not just open a list. The
   * combobox is hand-written, so this is the behaviour that would silently break.
   */
  it('selects a model from the combobox with the keyboard', async () => {
    installFetchMock({
      'GET /api/auth/session': () => ({
        json: { user: { id: 'u1', email: 'a@b.test', role: 'user', displayName: 'A' }, fallbackCredentialId: null, registrationEnabled: true },
      }),
      'GET /api/provider-credentials': () => ({
        json: { credentials: [credential], supportedTypes: ['openai-compatible'], devProviderEnabled: false },
      }),
      'GET /api/provider-credentials/cred-1/models': () => ({
        json: {
          models: ['cbai/deepseek-v3-2-volc', 'cbai/glm-5.0'],
          message: '2 models available.',
          supported: true,
        },
      }),
    });

    renderProviders();
    await screen.findByText('OpenAI');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(await screen.findByRole('button', { name: /Load models from server/i }));

    const picker = (await screen.findByLabelText('Model')) as HTMLButtonElement;
    await waitFor(() => expect(picker.getAttribute('role')).toBe('combobox'));

    // Open, step down to the last option and confirm â€” the native-select keyboard
    // contract. Arrow presses are counted from the real list so the test does not
    // depend on how many models the mock happens to return.
    picker.focus();
    await userEvent.keyboard('{ArrowDown}');
    const count = (await screen.findAllByRole('option')).length;
    for (let index = 1; index < count; index += 1) await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(picker.textContent).toContain('cbai/glm-5.0'));
    // The list is closed after choosing, as a native select does.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('falls back to manual entry when the provider has no model catalogue', async () => {
    installFetchMock({
      'GET /api/auth/session': () => ({
        json: { user: { id: 'u1', email: 'a@b.test', role: 'user', displayName: 'A' }, fallbackCredentialId: null, registrationEnabled: true },
      }),
      'GET /api/provider-credentials': () => ({
        json: { credentials: [credential], supportedTypes: ['openai-compatible'], devProviderEnabled: false },
      }),
      'GET /api/provider-credentials/cred-1/models': () => ({
        json: {
          models: [],
          message: 'The provider returned HTTP 404 for /models. Enter the model ID manually.',
          supported: false,
        },
      }),
    });

    renderProviders();
    await screen.findByText('OpenAI');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(await screen.findByRole('button', { name: /Load models from server/i }));

    // The field stays a free-text input and explains why, instead of erroring out.
    const field = (await screen.findByLabelText('Model')) as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field.value).toBe('gpt-4o-mini');
    expect(screen.getByText(/HTTP 404 for \/models/)).toBeInTheDocument();
  });
});
