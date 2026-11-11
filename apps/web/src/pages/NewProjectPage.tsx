import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PROVIDER_PRESETS, REPORT_LANGUAGES, REPORT_TONES } from '@formaai/shared';
import { api, errorMessage } from '../lib/api';
import type { Project } from '../lib/types';
import { PageHeader } from '../components/Feedback';

type TargetLength = 'short' | 'medium' | 'long';

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ar: 'العربية',
  zh: '中文',
  ja: '日本語',
};

export function NewProjectPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [reportType, setReportType] = useState('');
  const [language, setLanguage] = useState('en');
  const [tone, setTone] = useState('formal');
  const [audience, setAudience] = useState('');
  const [targetLength, setTargetLength] = useState<TargetLength>('medium');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('Give the project a title.');
      return;
    }
    setSubmitting(true);
    try {
      const { project } = await api.post<{ project: Project }>('/api/projects', {
        title: title.trim(),
        language,
        tone,
        targetLength,
        ...(reportType.trim() ? { reportType: reportType.trim() } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      navigate(`/projects/${project.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New project"
        description="Describe the report you want. You will upload the Word template and source documents next."
      />

      <form onSubmit={onSubmit} className="card space-y-5 p-6" noValidate>
        <div>
          <label className="label" htmlFor="title">
            Project title
          </label>
          <input
            id="title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Q3 2026 Activity Report"
            required
            maxLength={160}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="reportType">
              Report type <span className="font-normal text-ink-400">(optional)</span>
            </label>
            <input
              id="reportType"
              className="input"
              list="report-type-presets"
              value={reportType}
              onChange={(event) => setReportType(event.target.value)}
              placeholder="Activity report"
              maxLength={80}
            />
            <datalist id="report-type-presets">
              {['Activity report', 'Quarterly report', 'Annual report', 'Research report', 'Proposal', 'Minutes'].map(
                (preset) => (
                  <option key={preset} value={preset} />
                ),
              )}
            </datalist>
          </div>
          <div>
            <label className="label" htmlFor="language">
              Report language
            </label>
            <select
              id="language"
              className="input"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              {REPORT_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {LANGUAGE_LABELS[code] ?? code}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="tone">
              Tone
            </label>
            <select id="tone" className="input" value={tone} onChange={(event) => setTone(event.target.value)}>
              {REPORT_TONES.map((value) => (
                <option key={value} value={value}>
                  {value[0]!.toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="targetLength">
              Target section length
            </label>
            <select
              id="targetLength"
              className="input"
              value={targetLength}
              onChange={(event) => setTargetLength(event.target.value as TargetLength)}
            >
              <option value="short">Short — 120–180 words</option>
              <option value="medium">Medium — 250–350 words</option>
              <option value="long">Long — 450–700 words</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="audience">
            Audience <span className="font-normal text-ink-400">(optional)</span>
          </label>
          <input
            id="audience"
            className="input"
            value={audience}
            onChange={(event) => setAudience(event.target.value)}
            placeholder="e.g. Board of directors"
            maxLength={160}
          />
        </div>

        <div>
          <label className="label" htmlFor="instructions">
            Standing instructions <span className="font-normal text-ink-400">(optional)</span>
          </label>
          <textarea
            id="instructions"
            className="input min-h-24"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Any house style or content rules every section should follow."
            maxLength={8000}
          />
          <p className="hint">These guide tone and structure. Facts still come only from your source documents.</p>
        </div>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => navigate('/dashboard')}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>

      <p className="mt-4 text-xs text-ink-500">
        Tip: FormaAI works with any OpenAI-compatible endpoint plus native Anthropic and Gemini adapters. You can add a
        provider key under{' '}
        <span className="font-medium text-ink-700">AI providers</span> at any time.
      </p>
      <p className="mt-1 text-xs text-ink-400">
        {PROVIDER_PRESETS.length} built-in provider presets are available; custom base URLs are supported too.
      </p>
    </div>
  );
}
