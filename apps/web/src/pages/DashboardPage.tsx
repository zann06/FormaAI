import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import type { Project } from '../lib/types';
import { PageHeader, EmptyState, ErrorState, SkeletonLines, Spinner } from '../components/Feedback';
import { ProjectStatusBadge } from '../components/StatusBadges';
import { formatRelative, pluralize } from '../lib/format';
import { useToast } from '../lib/toast';

export function DashboardPage() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (includeArchived) query.set('includeArchived', 'true');
      if (search.trim()) query.set('search', search.trim());
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = await api.get<{ projects: Project[] }>(`/api/projects${suffix}`);
      setProjects(result.projects);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [includeArchived, search]);

  useEffect(() => {
    // Debounce so typing in the search box does not spam the API.
    const handle = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(handle);
  }, [load, search]);

  async function archive(project: Project) {
    try {
      await api.post(`/api/projects/${project.id}/archive`);
      toast.success(`Archived “${project.title}”.`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Each project pairs one Word template with the source documents it should draw from."
        actions={
          <Link to="/projects/new" className="btn-primary">
            New project
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-56">
          <label htmlFor="project-search" className="sr-only">
            Search projects
          </label>
          <input
            id="project-search"
            type="search"
            className="input"
            placeholder="Search by title…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived
        </label>
      </div>

      {loading && !projects && (
        <div className="card p-6">
          <SkeletonLines count={5} />
        </div>
      )}

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {!error && projects && projects.length === 0 && (
        <EmptyState
          title={search ? 'No matching projects' : 'No projects yet'}
          description={
            search
              ? 'Try a different search term.'
              : 'Create your first project by uploading a Word template and the source documents to fill it in.'
          }
          action={
            !search && (
              <Link to="/projects/new" className="btn-primary">
                Create a project
              </Link>
            )
          }
        />
      )}

      {!error && projects && projects.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id} className="card flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <Link
                  to={`/projects/${project.id}`}
                  className="text-base font-semibold text-ink-900 hover:text-brand-700"
                >
                  {project.title}
                </Link>
                <ProjectStatusBadge status={project.status} />
              </div>
              <p className="mt-1 text-xs text-ink-500">
                {pluralize(project.sourceCount, 'source document')} ·{' '}
                {project.documentCount > 0 ? 'template attached' : 'no template yet'}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-600">
                <div>
                  <dt className="text-ink-400">Template</dt>
                  <dd>{project.templateReady ? 'Ready' : 'Pending'}</dd>
                </div>
                <div>
                  <dt className="text-ink-400">Mapping</dt>
                  <dd>{project.mappingReady ? 'Ready' : 'Pending'}</dd>
                </div>
              </dl>
              <div className="mt-4 flex items-center justify-between text-xs text-ink-500">
                <span>Updated {formatRelative(project.lastActivityAt)}</span>
                {!project.archivedAt && (
                  <button
                    type="button"
                    className="text-ink-500 hover:text-red-600"
                    onClick={() => void archive(project)}
                  >
                    Archive
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {loading && projects && (
        <div className="mt-4">
          <Spinner label="Refreshing…" />
        </div>
      )}
    </div>
  );
}
