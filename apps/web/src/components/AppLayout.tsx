import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { errorMessage } from '../lib/api';

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 text-base font-semibold text-ink-900">
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
      >
        F
      </span>
      FormaAI
    </Link>
  );
}

const NAV = [
  { to: '/dashboard', label: 'Projects', end: false },
  { to: '/settings/providers', label: 'AI providers', end: false },
  { to: '/settings/usage', label: 'Usage', end: false },
  { to: '/settings/account', label: 'Account', end: false },
];

export function AppLayout() {
  const { user, signOut } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleSignOut() {
    try {
      await signOut();
      navigate('/signin');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Brand />
          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive ? 'bg-ink-100 text-ink-900' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden truncate text-sm text-ink-500 sm:block" title={user?.email}>
              {user?.displayName ?? user?.email}
            </span>
            <button type="button" className="btn-secondary" onClick={handleSignOut}>
              Sign out
            </button>
            <button
              type="button"
              className="btn-ghost md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              onClick={() => setMenuOpen((open) => !open)}
            >
              Menu
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="mobile-nav" className="border-t border-ink-200 bg-white px-4 py-2 md:hidden" aria-label="Mobile">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-2 text-sm font-medium ${
                    isActive ? 'bg-ink-100 text-ink-900' : 'text-ink-600 hover:bg-ink-100'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
