import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../lib/session';
import { ToastProvider } from '../lib/toast';
import { DashboardPage } from '../pages/DashboardPage';
import { installFetchMock } from '../test/fetchMock';

/**
 * Zero-delay typing and clicking.
 *
 * The default `userEvent` instance waits between keystrokes. On a loaded CI
 * runner those waits can push a single test past its 30 s budget, and a test
 * aborted mid-`type` never runs its teardown — its tree stays mounted and the
 * next test then sees two copies of the page. `delay: null` is user-event's
 * documented way to skip the artificial wait without changing behaviour.
 */
const user = userEvent.setup({ delay: null });

/**
 * Archive and Delete are different promises: archive is reversible, delete is
 * not. These tests pin that the UI never lets one stand in for the other, and
 * that the destructive call is only sent after the user confirms it.
 */
function renderDashboard() {
  return render(
    <SessionProvider>
      <ToastProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ToastProvider>
    </SessionProvider>,
  );
}

const session = {
  user: { id: 'u1', email: 'a@b.test', role: 'user', displayName: 'A' },
  fallbackCredentialId: null,
  registrationEnabled: true,
};

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    title: 'Test 6',
    reportType: null,
    language: 'id',
    tone: null,
    audience: null,
    instructions: null,
    targetLength: null,
    status: 'needs_review',
    templateReady: true,
    mappingReady: true,
    archivedAt: null,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    documentCount: 1,
    sourceCount: 18,
    ...overrides,
  };
}

describe('DashboardPage archive and delete', () => {
  it('archives without deleting, and says it can be restored', async () => {
    const { calls } = installFetchMock({
      'GET /api/auth/session': () => ({ json: session }),
      'GET /api/projects': () => ({ json: { projects: [project()] } }),
      'POST /api/projects/p1/archive': () => ({ json: { project: project({ archivedAt: new Date().toISOString() }) } }),
    });

    renderDashboard();
    await screen.findByText('Test 6');

    await user.click(screen.getByRole('button', { name: /Actions for Test 6/i }));
    await user.click(screen.getByRole('menuitem', { name: /Archive project/i }));

    // A confirmation explains that nothing is lost before anything is sent.
    expect(await screen.findByText(/can restore it any time/i)).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/archive'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.path === '/api/projects/p1/archive')).toBe(true);
    });
    // Archiving must never call DELETE — that is the whole point of having both.
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('deletes only after the confirmation, quoting what is lost', async () => {
    const { calls } = installFetchMock({
      'GET /api/auth/session': () => ({ json: session }),
      'GET /api/projects': () => ({ json: { projects: [project()] } }),
      'DELETE /api/projects/p1': () => ({ json: { ok: true } }),
    });

    renderDashboard();
    await screen.findByText('Test 6');

    await user.click(screen.getByRole('button', { name: /Actions for Test 6/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete permanently/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/source documents/i)).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: /Delete permanently/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/projects/p1')).toBe(true);
    });
  });

  it('keeps the project when the delete confirmation is cancelled', async () => {
    const { calls } = installFetchMock({
      'GET /api/auth/session': () => ({ json: session }),
      'GET /api/projects': () => ({ json: { projects: [project()] } }),
    });

    renderDashboard();
    await screen.findByText('Test 6');

    await user.click(screen.getByRole('button', { name: /Actions for Test 6/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete permanently/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('offers Restore instead of Archive on an archived project', async () => {
    const { calls } = installFetchMock({
      'GET /api/auth/session': () => ({ json: session }),
      'GET /api/projects': () => ({
        json: { projects: [project({ archivedAt: new Date().toISOString(), status: 'archived' })] },
      }),
      'POST /api/projects/p1/restore': () => ({ json: { project: project() } }),
    });

    renderDashboard();
    await screen.findByText('Test 6');

    // The inline Restore button is visible without opening the menu.
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.path === '/api/projects/p1/restore')).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: /Actions for Test 6/i }));
    expect(screen.queryByRole('menuitem', { name: /Archive project/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Delete permanently/i })).toBeInTheDocument();
  });
});
