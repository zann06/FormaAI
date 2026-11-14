import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { PageHeader, ErrorState, Spinner } from '../components/Feedback';
import { Badge } from '../components/StatusBadges';
import { LogoMark } from '../components/Logo';

/**
 * The "About" screen.
 *
 * It exists for the two audiences the project is published for:
 *
 *  - **Operators** (self-hosters) need to know what this instance can actually
 *    do. The capability list is read from `GET /api/health` at runtime rather
 *    than hard-coded, so a deployment with no LibreOffice or no OCR says so
 *    instead of advertising features it cannot run.
 *  - **Readers/reviewers** need the factual identity of the software: version,
 *    licence, provider support, and the trust model that explains where their
 *    data and keys live.
 *
 * Nothing here is decorative copy that could drift out of date: anything that
 * varies per deployment comes from the API, and anything that is a promise
 * ("your key never leaves your database") is repeated from the README because
 * that is the behaviour the code actually implements.
 */

interface HealthResponse {
  status: string;
  time: string;
  features: {
    pdfConversion: boolean;
    ocr: boolean;
    devProvider: boolean;
    registration: boolean;
  };
}

const VERSION = '0.1.0';
const LICENSE = 'AGPL-3.0-or-later';

/** One row of the capability table. */
function Capability({
  label,
  enabled,
  on,
  off,
}: {
  label: string;
  enabled: boolean;
  on: string;
  off: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-100 py-2.5 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900">{label}</p>
        <p className="mt-0.5 text-xs text-ink-500">{enabled ? on : off}</p>
      </div>
      <Badge tone={enabled ? 'green' : 'neutral'}>{enabled ? 'Available' : 'Off'}</Badge>
    </div>
  );
}

export function AboutPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setHealth(await api.get<HealthResponse>('/api/health'));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="About FormaAI"
        description="Template-driven report generation. Self-hostable, bring-your-own-key, and open source."
      />

      <section className="card mb-6 overflow-hidden">
        <div className="relative flex flex-wrap items-center gap-4 bg-brand-hero px-6 py-6 text-white">
          <span className="pointer-events-none absolute inset-0 hero-particles opacity-40" aria-hidden />
          <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20">
            <LogoMark size={28} />
          </div>
          <div className="relative">
            <h2 className="text-lg font-semibold">FormaAI</h2>
            <p className="mt-0.5 text-sm text-white/75">
              Version {VERSION} · licensed {LICENSE}
            </p>
          </div>
        </div>
        <div className="px-6 py-5">
          <p className="text-sm text-ink-700">
            Upload a Word template, attach your source documents, and get a finished, editable report
            that keeps your template&rsquo;s exact structure and formatting — exported as DOCX or PDF.
            Every sentence is written from your sources; anything the sources cannot support is left as
            a visible <code className="rounded bg-ink-100 px-1 py-0.5 text-xs">[PERLU DICEK]</code> marker
            rather than invented.
          </p>
          <dl className="mt-5 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-500">Version</dt>
              <dd className="font-medium text-ink-900">{VERSION}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Licence</dt>
              <dd className="font-medium text-ink-900">{LICENSE}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Deployment</dt>
              <dd className="font-medium text-ink-900">One instance per person</dd>
            </div>
            <div>
              <dt className="text-ink-500">API keys</dt>
              <dd className="font-medium text-ink-900">Bring your own, encrypted at rest</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="card mb-6 p-6">
        <h2 className="text-base font-semibold text-ink-900">What this instance can do</h2>
        <p className="mt-1 text-xs text-ink-500">
          Read live from this deployment, so it reflects what is actually installed here.
        </p>
        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {!error && !health && (
          <div className="mt-4">
            <Spinner label="Checking this instance…" />
          </div>
        )}
        {health && (
          <div className="mt-4">
            <Capability
              label="PDF export"
              enabled={health.features.pdfConversion}
              on="Documents are converted to PDF with LibreOffice."
              off="No converter is configured, so exports are DOCX only."
            />
            <Capability
              label="OCR for scanned sources"
              enabled={health.features.ocr}
              on="Scanned PDFs and images are read with Tesseract."
              off="Only text-bearing documents can be read; scanned pages are skipped."
            />
            <Capability
              label="Offline development provider"
              enabled={health.features.devProvider}
              on="A local provider is enabled for testing without an API key."
              off="Every generation needs a real provider credential."
            />
            <Capability
              label="Open sign-up"
              enabled={health.features.registration}
              on="New accounts can register from the sign-in page."
              off="Accounts are created by the instance owner only."
            />
          </div>
        )}
      </section>

      <section className="card mb-6 p-6">
        <h2 className="text-base font-semibold text-ink-900">Bring your own key</h2>
        <p className="mt-1 text-sm text-ink-600">
          There is no platform-wide API key and no central server. You add a provider once, and only your
          own account can use it.
        </p>
        <ul className="mt-3 grid gap-2 text-sm text-ink-700 sm:grid-cols-2">
          <li className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2">
            <span className="font-medium text-ink-900">OpenAI-compatible</span>
            <span className="mt-0.5 block text-xs text-ink-500">
              Any endpoint that speaks the OpenAI chat API
            </span>
          </li>
          <li className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2">
            <span className="font-medium text-ink-900">Anthropic</span>
            <span className="mt-0.5 block text-xs text-ink-500">Claude models</span>
          </li>
          <li className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2">
            <span className="font-medium text-ink-900">Gemini</span>
            <span className="mt-0.5 block text-xs text-ink-500">Google&rsquo;s generative models</span>
          </li>
          <li className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2">
            <span className="font-medium text-ink-900">Offline (dev)</span>
            <span className="mt-0.5 block text-xs text-ink-500">
              Deterministic stub for testing, never calls the network
            </span>
          </li>
        </ul>
        {health && !health.features.devProvider && (
          <p className="mt-3 text-xs text-ink-500">
            The offline provider is disabled on this instance.
          </p>
        )}
      </section>

      <section className="card mb-6 p-6">
        <h2 className="text-base font-semibold text-ink-900">Trust model</h2>
        <ul className="mt-3 space-y-2 text-sm text-ink-700">
          <li className="flex gap-2">
            <span aria-hidden className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" />
            <span>
              <span className="font-medium text-ink-900">Keys stay local.</span> Provider credentials are
              encrypted with your instance&rsquo;s encryption key and never sent anywhere except the
              provider you chose.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" />
            <span>
              <span className="font-medium text-ink-900">Accounts are isolated.</span> Even on a shared
              instance, projects, documents and keys belong to one user and are checked on every request.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" />
            <span>
              <span className="font-medium text-ink-900">No telemetry.</span> The app talks only to your
              own API, your database, and the AI provider you configured.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" />
            <span>
              <span className="font-medium text-ink-900">No invented content.</span> Text the sources do not
              support is marked, not guessed; the export tells you which markers remain.
            </span>
          </li>
        </ul>
      </section>

      <section className="card p-6">
        <h2 className="text-base font-semibold text-ink-900">Related</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/settings/providers" className="btn-secondary btn-sm">
            Manage AI providers
          </Link>
          <Link to="/settings/usage" className="btn-secondary btn-sm">
            View usage
          </Link>
          <Link to="/dashboard" className="btn-ghost btn-sm">
            Back to projects
          </Link>
        </div>
        <p className="mt-4 text-xs text-ink-500">
          FormaAI is free software under the {LICENSE} licence. It comes with no warranty; you run it on
          your own infrastructure and keep your own data.
        </p>
      </section>
    </div>
  );
}
