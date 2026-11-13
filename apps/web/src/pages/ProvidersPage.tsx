import { useCallback, useEffect, useState } from 'react';
import { PROVIDER_PRESETS } from '@formaai/shared';
import { api, errorMessage } from '../lib/api';
import type { Credential, CredentialsResponse } from '../lib/types';
import { PageHeader, EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { Badge } from '../components/StatusBadges';
import { Dialog, ConfirmDialog } from '../components/Dialog';
import { Select } from '../components/Select';
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
  /** Models returned by `GET {baseUrl}/models` for the credential being edited. */
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsMessage, setModelsMessage] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelFilter, setModelFilter] = useState('');

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
    setModels(null);
    setModelsMessage(null);
    setModelFilter('');
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(credential: Credential) {
    setFormError(null);
    setModels(null);
    setModelsMessage(null);
    setModelFilter('');
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

  /**
   * Asks the provider itself which models it serves.
   *
   * A hand-typed model ID is the most common cause of a failed generation (HTTP
   * 404 on every call), so wherever the provider supports `GET {baseUrl}/models`
   * the real catalogue is offered as a picker instead.
   */
  async function loadModels() {
    if (!form) return;
    setLoadingModels(true);
    setModelsMessage(null);
    try {
      if (form.id) {
        const result = await api.get<{ models: string[]; message: string; supported: boolean }>(
          `/api/provider-credentials/${form.id}/models`,
        );
        setModels(result.models);
        setModelsMessage(result.message);
        // If the currently configured model is missing from the catalogue, keep it
        // as a selectable option. Otherwise a `<select>` would silently snap to the
        // first entry and saving the form would switch the user's model.
        const current = form.model.trim();
        if (current && result.models.length > 0 && !result.models.includes(current)) {
          setModels([current, ...result.models]);
          setModelsMessage(
            `${result.message} Your current model “${current}” is not in that list — check it still exists.`,
          );
        }
      } else {
        // A brand-new credential has no stored key yet, so it cannot be queried.
        setModels([]);
        setModelsMessage(
          'Save this provider first, then reopen it to load the model list from the server.',
        );
      }
    } catch (err) {
      setModels([]);
      setModelsMessage(errorMessage(err));
    } finally {
      setLoadingModels(false);
    }
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
                <Select
                  id="preset"
                  aria-label="Preset"
                  value=""
                  placeholder="Choose a preset (optional)…"
                  onChange={(next) => applyPreset(next)}
                  options={PROVIDER_PRESETS.filter((preset) => devAllowed(preset.type)).map((preset) => ({
                    value: preset.id,
                    label: preset.label,
                    description: preset.baseUrl,
                  }))}
                />
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
              <Select
                id="providerType"
                aria-label="Provider type"
                value={form.providerType}
                onChange={(next) => setForm({ ...form, providerType: next })}
                options={Object.entries(TYPE_LABELS)
                  .filter(([type]) => devAllowed(type))
                  .map(([type, label]) => ({ value: type, label }))}
              />
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
              <div className="mb-1.5 flex items-end justify-between gap-2">
                <label className="label mb-0" htmlFor="model">
                  Model
                </label>
                {form.providerType !== 'dev-offline' && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm text-brand-700"
                    onClick={() => void loadModels()}
                    disabled={loadingModels}
                  >
                    {loadingModels ? 'Loading…' : models ? 'Reload models' : 'Load models from server'}
                  </button>
                )}
              </div>

              {models && models.length > 0 ? (
                <>
                  {models.length > 8 && (
                    <input
                      type="search"
                      className="input mb-2"
                      placeholder={`Filter ${models.length} models…`}
                      value={modelFilter}
                      onChange={(event) => setModelFilter(event.target.value)}
                      aria-label="Filter models"
                    />
                  )}
                  <Select
                    id="model"
                    aria-label="Model"
                    value={form.model}
                    onChange={(next) => setForm({ ...form, model: next })}
                    options={models
                      .filter((name) => name.toLowerCase().includes(modelFilter.trim().toLowerCase()))
                      .map((name) => ({ value: name, label: name }))}
                  />
                  <p className="hint">
                    {modelsMessage ?? `${models.length} models available.`} Selected:{' '}
                    <span className="font-medium text-ink-700">{form.model || 'none'}</span>
                  </p>
                </>
              ) : (
                <>
                  <input
                    id="model"
                    className="input"
                    value={form.model}
                    onChange={(event) => setForm({ ...form, model: event.target.value })}
                    placeholder="gpt-4o-mini"
                    maxLength={160}
                    list={form.id ? 'known-models' : undefined}
                  />
                  {models && models.length > 0 && (
                    <datalist id="known-models">
                      {models.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  )}
                  <p className={`hint ${modelsMessage ? 'text-ink-600' : ''}`}>
                    {modelsMessage ??
                      'Pick the exact model ID your provider serves. Use “Load models from server” to list them.'}
                  </p>
                </>
              )}
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
