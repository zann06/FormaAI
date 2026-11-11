import { useCallback, useEffect, useState } from 'react';
import { PROVIDER_PRESETS } from '@formaai/shared';
import { api, errorMessage } from '../lib/api';
import type { Credential, CredentialsResponse } from '../lib/types';
import { PageHeader, EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { Badge } from '../components/StatusBadges';
import { Dialog, ConfirmDialog } from '../components/Dialog';
import { useToast } from '../lib/toast';
import { useSession } from '../lib/session';
import { formatRelative } from '../lib/format';

interface FormState {
  id: string | null;
  displayName: string;
  providerType: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  isDefault: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  displayName: '',
  providerType: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  apiKey: '',
  isDefault: false,
};

const TYPE_LABELS: Record<string, string> = {
  'openai-compatible': 'OpenAI-compatible',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  'dev-offline': 'Offline (development)',
};

export function ProvidersPage() {
  const toast = useToast();
  const { fallbackCredentialId, setFallbackCredential } = useSession();
  const [data, setData] = useState<CredentialsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Credential | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<CredentialsResponse>('/api/provider-credentials'));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const devEnabled = data?.devProviderEnabled ?? false;
  const devAllowed = (type: string) => type !== 'dev-offline' || devEnabled;

  function openCreate() {
    setFormError(null);
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(credential: Credential) {
    setFormError(null);
    setForm({
      id: credential.id,
      displayName: credential.displayName,
      providerType: credential.providerType,
      baseUrl: credential.baseUrl ?? '',
      model: credential.model,
      apiKey: '',
      isDefault: credential.isDefault,
    });
  }

  function applyPreset(presetId: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    if (!preset || !form) return;
    setForm({
      ...form,
      providerType: preset.type,
      baseUrl: preset.baseUrl,
      model: preset.suggestedModels[0] ?? '',
      displayName: form.displayName || preset.label,
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setFormError(null);
    if (!form.displayName.trim()) return setFormError('Give the configuration a name.');
    if (!form.model.trim()) return setFormError('Enter the model identifier.');
    if (form.providerType === 'openai-compatible' && !form.baseUrl.trim())
      return setFormError('An OpenAI-compatible provider needs a base URL.');
    if (!form.id && !form.apiKey.trim()) return setFormError('Enter your API key.');

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        displayName: form.displayName.trim(),
        providerType: form.providerType,
        model: form.model.trim(),
        isDefault: form.isDefault,
      };
      if (form.baseUrl.trim()) body.baseUrl = form.baseUrl.trim();
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();

      if (form.id) {
        await api.patch(`/api/provider-credentials/${form.id}`, body);
        toast.success('Provider updated.');
      } else {
        await api.post('/api/provider-credentials', body);
        toast.success('Provider added.');
      }
      setForm(null);
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection(credential: Credential) {
    setTestingId(credential.id);
    try {
      const { result } = await api.post<{ result: { ok: boolean; message: string } }>(
        `/api/provider-credentials/${credential.id}/test`,
      );
      if (result.ok) toast.success(`“${credential.displayName}” responded successfully.`);
      else toast.error(`“${credential.displayName}” failed: ${result.message}`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTestingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/provider-credentials/${deleteTarget.id}`);
      toast.success('Provider removed.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  async function chooseFallback(credential: Credential) {
    try {
      await setFallbackCredential(fallbackCredentialId === credential.id ? null : credential.id);
      toast.success(
        fallbackCredentialId === credential.id ? 'Fallback cleared.' : 'Fallback provider saved for this account.',
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div>
      <PageHeader
        title="AI providers"
        description="FormaAI never uses a shared platform key. Add your own provider credentials; they are encrypted at rest and visible only to you."
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            Add provider
          </button>
        }
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && !data && (
        <div className="card p-6">
          <Spinner label="Loading providers…" />
        </div>
      )}

      {data && data.credentials.length === 0 && (
        <EmptyState
          title="No AI provider configured"
          description="Add an API key for OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint such as OpenRouter, DeepSeek or a local Ollama server."
          action={
            <button type="button" className="btn-primary" onClick={openCreate}>
              Add your first provider
            </button>
          }
        />
      )}

      {data && data.credentials.length > 0 && (
        <ul className="space-y-3">
          {data.credentials.map((credential) => (
            <li key={credential.id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-ink-900">{credential.displayName}</h3>
                    {credential.isDefault && <Badge tone="blue">Default</Badge>}
                    {fallbackCredentialId === credential.id && <Badge tone="purple">Fallback</Badge>}
                    {credential.sessionOnly && <Badge tone="neutral">Session only</Badge>}
                    {credential.lastTestStatus === 'ok' && <Badge tone="green">Connection OK</Badge>}
                    {credential.lastTestStatus === 'failed' && <Badge tone="red">Connection failed</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-ink-600">
                    {TYPE_LABELS[credential.providerType] ?? credential.providerType} · {credential.model} · key ····{' '}
                    {credential.keyLast4}
                  </p>
                  {credential.baseUrl && (
                    <p className="mt-0.5 break-all text-xs text-ink-400">{credential.baseUrl}</p>
                  )}
                  {credential.lastTestMessage && (
                    <p className={`mt-1 text-xs ${credential.lastTestStatus === 'failed' ? 'text-red-600' : 'text-ink-500'}`}>
                      {credential.lastTestMessage}
                      {credential.lastTestedAt ? ` · ${formatRelative(credential.lastTestedAt)}` : ''}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void testConnection(credential)}
                    disabled={testingId === credential.id}
                  >
                    {testingId === credential.id ? 'Testing…' : 'Test'}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => openEdit(credential)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void chooseFallback(credential)}
                    aria-pressed={fallbackCredentialId === credential.id}
                  >
                    {fallbackCredentialId === credential.id ? 'Clear fallback' : 'Set as fallback'}
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => setDeleteTarget(credential)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 max-w-3xl text-xs text-ink-500">
        “Fallback” is an explicit choice: if your default provider fails during generation, FormaAI will only use the
        fallback you selected here. Credentials are never shared between accounts.
      </p>

      <Dialog
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit provider' : 'Add a provider'}
        description={
          form?.id
            ? 'Leave the API key blank to keep the current one.'
            : 'Choose a preset or enter a custom OpenAI-compatible endpoint.'
        }
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="provider-form" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save provider'}
            </button>
          </>
        }
      >
        {form && (
          <form id="provider-form" onSubmit={save} className="space-y-4" noValidate>
            {!form.id && (
              <div>
                <label className="label" htmlFor="preset">
                  Preset
                </label>
                <select
                  id="preset"
                  className="input"
                  defaultValue=""
                  onChange={(event) => applyPreset(event.target.value)}
                >
                  <option value="">Choose a preset (optional)…</option>
                  {PROVIDER_PRESETS.filter((preset) => devAllowed(preset.type)).map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="label" htmlFor="displayName">
                Name
              </label>
              <input
                id="displayName"
                className="input"
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                maxLength={80}
              />
            </div>
            <div>
              <label className="label" htmlFor="providerType">
                Provider type
              </label>
              <select
                id="providerType"
                className="input"
                value={form.providerType}
                onChange={(event) => setForm({ ...form, providerType: event.target.value })}
              >
                {Object.entries(TYPE_LABELS)
                  .filter(([type]) => devAllowed(type))
                  .map(([type, label]) => (
                    <option key={type} value={type}>
                      {label}
                    </option>
                  ))}
              </select>
            </div>
            {form.providerType !== 'dev-offline' && (
              <div>
                <label className="label" htmlFor="baseUrl">
                  Base URL{' '}
                  {form.providerType === 'openai-compatible' ? (
                    <span className="text-red-500">*</span>
                  ) : (
                    <span className="font-normal text-ink-400">(optional)</span>
                  )}
                </label>
                <input
                  id="baseUrl"
                  type="url"
                  className="input"
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </div>
            )}
            <div>
              <label className="label" htmlFor="model">
                Model
              </label>
              <input
                id="model"
                className="input"
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
                placeholder="gpt-4o-mini"
                maxLength={160}
              />
            </div>
            <div>
              <label className="label" htmlFor="apiKey">
                API key {form.id && <span className="font-normal text-ink-400">(leave blank to keep)</span>}
              </label>
              <input
                id="apiKey"
                type="password"
                autoComplete="off"
                className="input"
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                placeholder={form.id ? '••••••••' : 'sk-…'}
              />
              <p className="hint">Stored encrypted with AES-256-GCM. It is never shown again after saving.</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                checked={form.isDefault}
                onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
              />
              Make this the default provider
            </label>
            {formError && (
              <p className="field-error" role="alert">
                {formError}
              </p>
            )}
          </form>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete provider?"
        description={`This permanently removes “${deleteTarget?.displayName ?? ''}” and its stored key. Generated reports are not affected.`}
        busy={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
