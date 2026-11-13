import { Link } from 'react-router-dom';
import { useSession } from '../lib/session';
import { Logo, LogoMark } from '../components/Logo';

const HIGHLIGHTS = [
  'Evidence-mapped drafting',
  'Template fidelity kept',
  'Missing facts flagged',
];

const STEPS = [
  {
    step: '01',
    title: 'Upload your template',
    body: 'A .docx template is parsed into an editable outline. Your formatting and styles stay intact.',
  },
  {
    step: '02',
    title: 'Add source documents',
    body: 'PDF, DOCX, TXT and screenshots are extracted and indexed. Nothing is generated from thin air.',
  },
  {
    step: '03',
    title: 'Review the mapping',
    body: 'See which evidence each section uses, and which requirements are missing or conflicting.',
  },
  {
    step: '04',
    title: 'Draft and export',
    body: 'Generate section by section, edit freely, then export an editable DOCX or a PDF.',
  },
];

/**
 * The animated backdrop shared by the hero and the closing band.
 *
 * Three layers: a fine white dot field, a coarser pink field on a slower reverse
 * clock, and a handful of larger sparks. The two dot layers drift at different
 * speeds and directions, which is what makes the field read as depth instead of a
 * repeating wallpaper. All of it is `aria-hidden` and `pointer-events-none`, and
 * every animation is disabled by the global `prefers-reduced-motion` rule.
 */
function ParticleField({ dense = false }: { dense?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 hero-particles" />
      <div className="absolute inset-0 hero-particles-slow" />
      {dense && (
        <>
          <span className="hero-spark left-[12%] top-[28%] h-1.5 w-1.5" />
          <span className="hero-spark left-[24%] top-[68%] h-1 w-1" style={{ animationDelay: '1.4s' }} />
          <span className="hero-spark left-[78%] top-[22%] h-2 w-2" style={{ animationDelay: '2.6s' }} />
          <span className="hero-spark left-[86%] top-[62%] h-1 w-1" style={{ animationDelay: '0.7s' }} />
          <span className="hero-spark left-[46%] top-[80%] h-1.5 w-1.5" style={{ animationDelay: '3.1s' }} />
          <span className="hero-spark left-[64%] top-[12%] h-1 w-1" style={{ animationDelay: '1.9s' }} />
        </>
      )}
      {/* Vignette keeps the dots from competing with the text sitting on top. */}
      <div className="absolute inset-0 bg-brand-hero opacity-45" />
    </div>
  );
}

export function LandingPage() {
  const { user } = useSession();
  const primaryTo = user ? '/dashboard' : '/signup';
  const primaryLabel = user ? 'Go to projects' : 'Start writing';

  return (
    <div className="min-h-full bg-white">
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden bg-brand-hero">
        <ParticleField dense />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-brand-glow" />

        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <header className="flex h-20 items-center justify-between gap-4">
            <Logo to="/" size={32} variant="inverted" />

            <nav className="nav-pill hidden items-center lg:flex" aria-label="Sections">
              <a href="#how-it-works" className="nav-pill-link">
                How it works
              </a>
              <a href="#guarantees" className="nav-pill-link">
                Guarantees
              </a>
              <a href="#privacy" className="nav-pill-link">
                Privacy
              </a>
            </nav>

            <div className="flex items-center gap-2">
              {user ? (
                <Link to="/dashboard" className="btn-accent btn-sm sm:px-4 sm:py-2">
                  Go to projects
                </Link>
              ) : (
                <>
                  <Link to="/signin" className="rounded-full px-4 py-2 text-sm font-medium text-white/85 hover:text-white">
                    Sign in
                  </Link>
                  <Link to="/signup" className="btn-accent rounded-full px-5 py-2">
                    Request access
                  </Link>
                </>
              )}
            </div>
          </header>

          <div className="animate-fade-up pb-24 pt-14 text-center sm:pb-32 sm:pt-20">
            <div className="mb-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-2 text-xs font-medium text-white/70">
              {HIGHLIGHTS.map((item) => (
                <span key={item} className="inline-flex items-center gap-2">
                  <span aria-hidden className="h-px w-4 bg-accent-300/80" />
                  {item}
                </span>
              ))}
            </div>

            <h1 className="text-balance text-4xl font-semibold tracking-tight text-white sm:text-6xl lg:text-[4.2rem] lg:leading-[1.05]">
              Reports that keep
              <br className="hidden sm:block" /> your template&rsquo;s shape
            </h1>

            <p className="mx-auto mt-7 max-w-2xl text-pretty text-base leading-relaxed text-white/80 sm:text-lg">
              FormaAI reads the Word template your organisation already uses, maps your own source documents to
              every section, and drafts the report with your own AI provider key — so nothing is invented.
            </p>

            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Link to={primaryTo} className="btn-accent rounded-full px-7 py-3 text-[15px]">
                {primaryLabel}
              </Link>
              <a
                href="#how-it-works"
                className="btn rounded-full border border-white/35 bg-white/10 px-7 py-3 text-[15px] text-white backdrop-blur hover:border-white/60 hover:bg-white/20"
              >
                See how it works
              </a>
            </div>

            <p className="mt-7 text-xs text-white/60">
              Open source · Bring your own API key · No shared platform key
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- steps */}
      <section id="how-it-works" className="relative border-b border-ink-100 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="mb-12 max-w-2xl">
            <p className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-brand-600">
              <span aria-hidden className="h-px w-6 bg-accent-300" /> Workflow
            </p>
            <h2 className="text-balance text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
              Four steps from a blank template to a reviewed report
            </h2>
          </div>

          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((item) => (
              <li key={item.step} className="card-hover group relative overflow-hidden p-6">
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 bg-brand-line transition-transform duration-500 ease-brand group-hover:scale-x-100"
                />
                <span className="text-xs font-semibold tracking-widest text-accent-500">{item.step}</span>
                <h3 className="mt-3 font-semibold text-ink-900">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* --------------------------------------------------------- guarantees */}
      <section id="guarantees" className="bg-ink-50/70">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <p className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-brand-600">
                <span aria-hidden className="h-px w-6 bg-accent-300" /> What you can rely on
              </p>
              <h2 className="text-balance text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
                Built for real, private work
              </h2>
              <p className="mt-4 max-w-md text-pretty text-ink-600">
                A report is only useful if you can defend every sentence in it. FormaAI is designed around that
                constraint rather than around generating the most text.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {[
                [
                  'Your keys, your account',
                  'API keys are encrypted at rest with AES-256-GCM and never shared across accounts.',
                ],
                [
                  'Facts stay sourced',
                  'Numbers and dates must appear in the evidence you uploaded, or they are flagged for review.',
                ],
                [
                  'Template fidelity',
                  'Exports are your original template with the body filled in — never a rebuilt document.',
                ],
                [
                  'Nothing hidden',
                  'Every section shows which sources it used and which gaps were left open.',
                ],
              ].map(([title, body]) => (
                <div key={title} className="card p-5">
                  <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50">
                    <span aria-hidden className="h-2 w-2 rounded-full bg-accent-300" />
                  </div>
                  <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- cta */}
      <section id="privacy" className="relative overflow-hidden bg-brand-hero">
        <ParticleField />
        <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
          <LogoMark size={44} className="mx-auto mb-6 animate-float" />
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Start from the template you already have
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-white/80">
            No migration, no new format, no retyping. Upload the .docx, add your sources, and review the draft.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link to={primaryTo} className="btn-accent rounded-full px-7 py-3 text-[15px]">
              {primaryLabel}
            </Link>
            {!user && (
              <Link
                to="/signin"
                className="btn rounded-full border border-white/35 bg-white/10 px-7 py-3 text-[15px] text-white hover:border-white/60 hover:bg-white/20"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </section>

      <footer className="border-t border-ink-100 bg-white py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 sm:flex-row sm:px-6">
          <Logo to="/" size={22} />
          <p className="text-xs text-ink-500">
            Open-source, template-driven report generation. Your keys never leave your account.
          </p>
        </div>
      </footer>
    </div>
  );
}
