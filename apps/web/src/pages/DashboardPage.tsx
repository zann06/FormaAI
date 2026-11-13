import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import type { Project } from '../lib/types';
import { PageHeader, EmptyState, ErrorState, SkeletonLines, Spinner } from '../components/Feedback';
import { ProjectStatusBadge } from '../components/StatusBadges';
import { ConfirmDialog } from '../components/Dialog';
import { formatRelative, pluralize } from '../lib/format';
import { useToast } from '../lib/toast';

type PendingAction =
  | { kind: 'archive'; project: Project }
  | { kind: 'delete'; project: Project };

/** A small overflow menu so Archive and Delete are never one stray click apart. */
function ProjectMenu({
  project,
  onArchive,
  onRestore,
  onDelete,
}: {
  project: Project;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // Defer so the click that opened the menu does not immediately close it.
    const handle = window.setTimeout(() => document.addEventListener('click', close), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(handle);
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-ghost btn-sm px-2"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${project.title}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden>⋮</span>
      </button>
      {open && (
        <div
          role="menu"
          className="animate-scale-in absolute bottom-full right-0 z-20 mb-1 w-44 origin-bottom-right overflow-hidden rounded-xl border border-ink-200 bg-white py-1 shadow-lift"
          onClick={(event) => event.stopPropagation()}
        >
          {project.archivedAt ? (
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"
              onClick={() => {
                setOpen(false);
                onRestore();
              }}
            >
              Restore project
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"
              onClick={() => {
                setOpen(false);
                onArchive();
              }}
            >
              Archive project
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete permanently
          </button>
        </div>
      )}
    </div>
  );
}

export function DashboardPage() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function runPending() {
    if (!pending) return;
    const { kind, project } = pending;
    setBusy(true);
    try {
      if (kind === 'delete') {
        await api.del(`/api/projects/${project.id}`);
        toast.success(`Deleted “${project.title}”.`);
      } else if (kind === 'archive') {
        await api.post(`/api/projects/${project.id}/archive`);
        toast.success(`Archived “${project.title}”. You can restore it from here.`);
      }
      setPending(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Restore runs immediately rather than through a confirmation.
   *
   * It is the safe direction of the archive/delete pair: asking the user to
   * confirm getting their own project back would be friction with no benefit.
   */
  async function restoreNow(project: Project) {
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/restore`);
      toast.success(`Restored “${project.title}”.`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const archivedCount = (projects ?? []).filter((project) => project.archivedAt).length;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Projects"
        description="Each project pairs one Word template with the source documents it should draw from."
        actions={
          <Link to="/projects/new" className="btn-primary">
            New project
          </Link>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
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
        <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived
          {includeArchived && archivedCount > 0 && (
            <span className="badge bg-ink-100 text-ink-600">{archivedCount}</span>
          )}
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
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <li
              key={project.id}
              className={`card-hover group relative flex flex-col p-5 ${
                project.archivedAt ? 'bg-ink-50/60' : ''
              }`}
            >
              {/* A gradient hairline that appears on hover: the only decoration. */}
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 rounded-t-xl bg-brand-line transition-transform duration-500 ease-brand group-hover:scale-x-100"
              />
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
                  <dd className={project.templateReady ? 'text-brand-700' : ''}>
                    {project.templateReady ? 'Ready' : 'Pending'}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-400">Mapping</dt>
                  <dd className={project.mappingReady ? 'text-brand-700' : ''}>
                    {project.mappingReady ? 'Ready' : 'Pending'}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 flex items-center justify-between gap-2 border-t border-ink-100 pt-3 text-xs text-ink-500">
                <span>
                  {project.archivedAt ? 'Archived' : 'Updated'} {formatRelative(project.lastActivityAt)}
                </span>
                <div className="flex items-center gap-1">
                  {project.archivedAt && (
                    <button
                      type="button"
                      className="btn-ghost btn-sm text-brand-700"
                      onClick={() => void restoreNow(project)}
                      disabled={busy}
                    >
                      Restore
                    </button>
                  )}
                  <Link to={`/projects/${project.id}`} className="btn-ghost btn-sm text-ink-600">
                    Open
                  </Link>
                  <ProjectMenu
                    project={project}
                    onArchive={() => setPending({ kind: 'archive', project })}
                    onRestore={() => void restoreNow(project)}
                    onDelete={() => setPending({ kind: 'delete', project })}
                  />
                </div>
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

      <ConfirmDialog
        open={pending?.kind === 'archive'}
        title="Archive this project?"
        description={`“${pending?.project.title ?? ''}” will be hidden from the main list. Nothing is deleted — you can restore it any time from “Show archived”.`}
        confirmLabel="Archive"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void runPending()}
      />

      <ConfirmDialog
        open={pending?.kind === 'delete'}
        title="Delete this project permanently?"
        description={`“${pending?.project.title ?? ''}”, its template, source documents, generated sections and exports will be removed from storage. This cannot be undone. To keep it instead, archive it.`}
        confirmLabel="Delete permanently"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void runPending()}
      />
    </div>
  );
}
