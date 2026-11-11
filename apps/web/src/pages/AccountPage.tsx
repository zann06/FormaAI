import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import type { SessionInfo } from '../lib/types';
import { useSession } from '../lib/session';
import { PageHeader, ErrorState, Spinner } from '../components/Feedback';
import { Badge } from '../components/StatusBadges';
import { Dialog } from '../components/Dialog';
import { useToast } from '../lib/toast';
import { formatDate, formatRelative } from '../lib/format';

export function AccountPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user, signOut, refresh } = useSession();

  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changing, setChanging] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);

  const loadSessions = useCallback(async () => {
    setSessionsError(null);
    try {
      const result = await api.get<{ sessions: SessionInfo[] }>('/api/auth/sessions');
      setSessions(result.sessions);
    } catch (err) {
      setSessionsError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword.length < 10) {
      toast.error('New password must be at least 10 characters.');
      return;
    }
    setChanging(true);
    try {
      await api.patch('/api/auth/password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      toast.success('Password updated. Other sessions were signed out.');
      await refresh();
      await loadSessions();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setChanging(false);
    }
  }

  async function revokeOtherSessions() {
    try {
      await api.del('/api/auth/sessions');
      toast.success('All other sessions were signed out.');
      await loadSessions();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    try {
      await api.del('/api/auth/account', { password: deletePassword, confirm: deleteConfirm });
      toast.success('Your account was deleted.');
      await signOut().catch(() => undefined);
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Account" description="Manage your profile, password, sessions and data." />

      <section className="card mb-6 p-6">
        <h2 className="text-base font-semibold text-ink-900">Profile</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-500">Email</dt>
            <dd className="font-medium text-ink-900">{user?.email}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Display name</dt>
            <dd className="font-medium text-ink-900">{user?.displayName ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="card mb-6 p-6">
        <h2 className="text-base font-semibold text-ink-900">Change password</h2>
        <form onSubmit={changePassword} className="mt-3 space-y-4" noValidate>
          <div>
            <label className="label" htmlFor="currentPassword">
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              className="input"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="newPassword">
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              className="input"
              minLength={10}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p className="hint">At least 10 characters. Changing it signs out your other sessions.</p>
          </div>
          <div className="flex justify-end">
            <button type="submit" className="btn-primary" disabled={changing}>
              {changing ? 'Updating…' : 'Update password'}
            </button>
          </div>
        </form>
      </section>

      <section className="card mb-6 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-900">Active sessions</h2>
          <button type="button" className="btn-secondary" onClick={() => void revokeOtherSessions()}>
            Sign out other sessions
          </button>
        </div>
        {sessionsError && <ErrorState message={sessionsError} onRetry={() => void loadSessions()} />}
        {!sessionsError && !sessions && (
          <div className="mt-3">
            <Spinner label="Loading sessions…" />
          </div>
        )}
        {sessions && (
          <ul className="mt-3 divide-y divide-ink-100">
            {sessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="truncate text-ink-700" title={session.userAgent ?? 'Unknown device'}>
                  {session.userAgent ?? 'Unknown device'}
                </span>
                {session.current && <Badge tone="blue">This device</Badge>}
                <span className="ml-auto text-xs text-ink-400">
                  Started {formatRelative(session.createdAt)} · expires {formatDate(session.expiresAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card border-red-200 p-6">
        <h2 className="text-base font-semibold text-red-700">Delete account</h2>
        <p className="mt-1 text-sm text-ink-600">
          This permanently deletes your account, projects, uploaded documents, generated reports and stored API keys.
          This cannot be undone.
        </p>
        <button type="button" className="btn-danger mt-4" onClick={() => setDeleteOpen(true)}>
          Delete my account
        </button>
      </section>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setDeletePassword('');
          setDeleteConfirm('');
        }}
        title="Delete your account permanently?"
        description="Every project, document, report and stored key will be erased. This cannot be undone."
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setDeleteOpen(false);
                setDeletePassword('');
                setDeleteConfirm('');
              }}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn bg-red-600 text-white hover:bg-red-700"
              onClick={() => void deleteAccount()}
              disabled={deleting || deleteConfirm !== 'DELETE' || !deletePassword}
            >
              {deleting ? 'Deleting…' : 'Delete account'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="deletePassword">
              Password
            </label>
            <input
              id="deletePassword"
              type="password"
              className="input"
              value={deletePassword}
              onChange={(event) => setDeletePassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="label" htmlFor="deleteConfirm">
              Type DELETE to confirm
            </label>
            <input
              id="deleteConfirm"
              className="input"
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
              placeholder="DELETE"
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
