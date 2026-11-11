import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../lib/session';
import { ToastProvider } from '../lib/toast';
import { SignInPage, SignUpPage } from '../pages/AuthPages';
import { installFetchMock } from '../test/fetchMock';

function renderAuth(ui: React.ReactElement) {
  return render(
    <SessionProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={['/signin']}>{ui}</MemoryRouter>
      </ToastProvider>
    </SessionProvider>,
  );
}

const anonymousRoutes = {
  'GET /api/auth/session': () => ({
    status: 401,
    json: { error: { code: 'UNAUTHENTICATED', message: 'Not signed in' } },
  }),
  'GET /api/auth/signup-availability': () => ({ json: { registrationEnabled: true } }),
};

describe('SignInPage', () => {
  it('submits credentials and loads the session afterwards', async () => {
    const { calls } = installFetchMock({
      ...anonymousRoutes,
      'POST /api/auth/signin': () => ({
        json: { user: { id: 'u1', email: 'a@b.test', role: 'user', displayName: 'A' } },
      }),
    });

    renderAuth(<SignInPage />);
    await screen.findByRole('heading', { name: 'Sign in' });

    await userEvent.type(screen.getByLabelText('Email'), 'a@b.test');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      const signIn = calls.find((call) => call.method === 'POST' && call.path === '/api/auth/signin');
      expect(signIn).toBeTruthy();
      expect(signIn!.body).toEqual({ email: 'a@b.test', password: 'secret-password' });
    });
  });

  it('shows the server error message when sign-in fails', async () => {
    installFetchMock({
      ...anonymousRoutes,
      'POST /api/auth/signin': () => ({
        status: 401,
        json: { error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' } },
      }),
    });

    renderAuth(<SignInPage />);
    await screen.findByRole('heading', { name: 'Sign in' });
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });
});

describe('SignUpPage', () => {
  it('blocks submission when the password is shorter than 10 characters', async () => {
    const { calls } = installFetchMock({ ...anonymousRoutes });

    renderAuth(<SignUpPage />);
    await screen.findByRole('heading', { name: 'Create your account' });
    await userEvent.type(screen.getByLabelText('Email'), 'new@b.test');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('at least 10 characters');
    // The API must never be called with an invalid password.
    expect(calls.some((call) => call.path === '/api/auth/signup')).toBe(false);
  });

  it('hides the form when registration is disabled', async () => {
    installFetchMock({
      'GET /api/auth/session': () => ({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'x' } } }),
      'GET /api/auth/signup-availability': () => ({ json: { registrationEnabled: false } }),
    });

    renderAuth(<SignUpPage />);
    expect(await screen.findByRole('heading', { name: 'Registration closed' })).toBeInTheDocument();
  });
});
