import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 text-center">
      <p className="text-sm font-medium text-brand-700">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">Page not found</h1>
      <p className="mt-1 text-sm text-ink-600">The page you are looking for does not exist.</p>
      <Link to="/dashboard" className="btn-primary mt-6">
        Go to projects
      </Link>
    </div>
  );
}
