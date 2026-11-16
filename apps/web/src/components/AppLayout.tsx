import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { errorMessage } from '../lib/api';
import { Logo } from './Logo';

const NAV = [
  { to: '/dashboard', label: 'Projects', end: false },
  { to: '/settings/providers', label: 'AI providers', end: false },
  { to: '/settings/usage', label: 'Usage', end: false },
  { to: '/settings/account', label: 'Account', end: false },
  { to: '/about', label: 'About', end: false },
];

/** Circular initials chip shown in the header instead of a bare email address. */
function Avatar({ label }: { label: string }) {
  const initials =
    label
      .split(/[\s.@_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'F';
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-accent-300 text-xs font-semibold text-white ring-2 ring-white"
    >
      {initials}
    </span>
  );
}

export function AppLayout() {
  const { user, signOut } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile sheet when the viewport grows past the breakpoint, so it
  // cannot be left open and invisible after a rotation or resize.
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const onChange = () => setMenuOpen(false);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  async function handleSignOut() {
    try {
      await signOut();
      navigate('/signin');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const displayLabel = user?.displayName ?? user?.email ?? '';

  return (
    <div className="flex min-h-full flex-col bg-ink-50">
      {/*
        The sticky header used to have only a hairline border, so once it stuck to
        the top it merged into the page and read as part of the content. The shadow
        below gives it real height above the scrolling page, and the gradient behind
        the app keeps the top of the viewport from looking flat.
      */}
      <header className="sticky top-0 z-30 border-b border-ink-200/70 bg-white/80 shadow-[0_1px_2px_rgba(9,49,141,0.04),0_8px_24px_-16px_rgba(9,49,141,0.28)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Logo to="/dashboard" size={30} />

          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `relative rounded-lg px-3 py-2 text-sm font-medium ${
                    isActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {item.label}
                    {isActive && (
                      <span
                        aria-hidden
                        className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full bg-gradient-to-r from-brand-600 to-accent-300"
                      />
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/projects/new"
              className="btn-primary btn-sm hidden sm:inline-flex"
              aria-label="Create a new project"
            >
              <span aria-hidden>+</span> New project
            </Link>
            <div className="hidden items-center gap-2 sm:flex">
              <Avatar label={displayLabel} />
              <span className="max-w-32 truncate text-sm text-ink-600" title={user?.email}>
                {displayLabel}
              </span>
            </div>
            <button type="button" className="btn-ghost btn-sm" onClick={handleSignOut}>
              Sign out
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? 'Close' : 'Menu'}
            </button>
          </div>
        </div>

        {menuOpen && (
          <nav
            id="mobile-nav"
            className="animate-fade-up border-t border-ink-200 bg-white px-4 py-3 md:hidden"
            aria-label="Mobile"
          >
            <div className="mb-2 flex items-center gap-2 border-b border-ink-100 pb-3">
              <Avatar label={displayLabel} />
              <span className="min-w-0 flex-1 truncate text-sm text-ink-600">{user?.email}</span>
            </div>
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `block rounded-lg px-3 py-2.5 text-sm font-medium ${
                    isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-600 hover:bg-ink-100'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <Link
              to="/projects/new"
              onClick={() => setMenuOpen(false)}
              className="btn-primary mt-2 w-full"
            >
              New project
            </Link>
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 animate-fade-in px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
