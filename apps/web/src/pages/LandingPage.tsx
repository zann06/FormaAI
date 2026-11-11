import { Link } from 'react-router-dom';
import { useSession } from '../lib/session';

export function LandingPage() {
  const { user } = useSession();
  const primaryTo = user ? '/dashboard' : '/signup';
  const primaryLabel = user ? 'Go to projects' : 'Get started';

  return (
    <div className="min-h-full bg-white">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2 text-base font-semibold text-ink-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
            F
          </span>
          FormaAI
        </div>
        <nav className="flex items-center gap-2">
          {user ? (
            <Link to="/dashboard" className="btn-primary">
              Go to projects
            </Link>
          ) : (
            <>
              <Link to="/signin" className="btn-ghost">
                Sign in
              </Link>
              <Link to="/signup" className="btn-primary">
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-14 text-center sm:px-6 sm:pt-20">
          <p className="mb-4 inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
            Open source · Bring your own API key
          </p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-ink-900 sm:text-5xl">
            Turn your Word template into a finished, editable report.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg text-ink-600">
            Upload the template your organisation already uses plus the source documents. FormaAI reads the structure,
            maps evidence to each section, flags what is missing, and drafts the report — using your own AI provider key.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to={primaryTo} className="btn-primary px-5 py-2.5">
              {primaryLabel}
            </Link>
            <a href="#how-it-works" className="btn-secondary px-5 py-2.5">
              How it works
            </a>
          </div>
        </section>

        <section id="how-it-works" className="border-t border-ink-100 bg-ink-50/60">
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
            {[
              {
                step: '1',
                title: 'Upload your template',
                body: 'A .docx template is parsed into an editable outline. Your formatting and styles stay intact.',
              },
              {
                step: '2',
                title: 'Add source documents',
                body: 'PDF, DOCX and TXT sources are extracted and indexed. Nothing is generated from thin air.',
              },
              {
                step: '3',
                title: 'Review the mapping',
                body: 'See which evidence each section uses, and which requirements are missing or conflicting.',
              },
              {
                step: '4',
                title: 'Draft and export',
                body: 'Generate section by section, edit freely, then export an editable DOCX or a PDF.',
              },
            ].map((item) => (
              <div key={item.step} className="card p-5">
                <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
                  {item.step}
                </div>
                <h3 className="font-semibold text-ink-900">{item.title}</h3>
                <p className="mt-1 text-sm text-ink-600">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6">
          <h2 className="text-2xl font-semibold text-ink-900">Built for real, private work</h2>
          <div className="mx-auto mt-8 grid gap-6 text-left sm:grid-cols-3">
            {[
              ['Your keys, your account', 'API keys are encrypted at rest and never shared across accounts. No platform-wide key.'],
              ['Facts stay sourced', 'Numbers and dates must appear in the evidence you uploaded, or they are flagged for review.'],
              ['Template fidelity', 'Exports are a copy of your original template with the body filled in — never a rebuilt document.'],
            ].map(([title, body]) => (
              <div key={title}>
                <h3 className="font-semibold text-ink-900">{title}</h3>
                <p className="mt-1 text-sm text-ink-600">{body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-ink-100 py-8 text-center text-sm text-ink-500">
        FormaAI — open-source, template-driven report generation.
      </footer>
    </div>
  );
}
