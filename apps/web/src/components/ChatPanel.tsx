import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../lib/toast';
import { planChatAction, summariseSteps, type ChatAction } from '../lib/chat-actions';

/**
 * The conversation panel — the primary surface of the workspace.
 *
 * This is the shape the user asked for: "saya mau seperti chatbot aja biar ada
 * feedback dan langsung reason disana". So a reply is not a single paragraph of
 * prose. It shows, in order, what the assistant understood, what it checked, what
 * it ran, and what came back — the reasoning trail stays visible instead of being
 * collapsed into a confident-sounding summary.
 *
 * It also *acts*: "generate the report" starts a real pipeline, "export as pdf"
 * produces a file. Answers and actions come from the same message, which is what
 * makes it a chat rather than a command form.
 */

export type ChatTone = 'thinking' | 'checking' | 'action' | 'result' | 'warn' | 'error';

export interface ChatStep {
  tone: ChatTone;
  text: string;
}

export interface ChatAttachment {
  name: string;
  /** Upload state, so a 40 MB zip shows progress instead of a frozen composer. */
  status: 'uploading' | 'done' | 'failed';
  message?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** The reply text. Empty for a user message that only carried attachments. */
  text: string;
  createdAt: string;
  attachments?: ChatAttachment[];
  /** The reasoning/action trail, rendered above the text. */
  steps?: ChatStep[];
  /** True while the assistant reply is still being produced. */
  pending?: boolean;
}

export interface ProviderOption {
  id: string;
  displayName: string;
  providerType: string;
  model: string;
  isDefault: boolean;
}

export interface ChatContext {
  hasTemplate: boolean;
  hasSources: boolean;
  hasProvider: boolean;
  drafted: number;
  total: number;
  /** Sections with no stored content and no template text of their own. */
  emptyHeadings: string[];
  /** Headings in template order, for resolving "regenerate 2.3". */
  headings: string[];
  busy: boolean;
  pdfAvailable: boolean;
  exportReady: boolean;
}

const MESSAGES_KEY = (projectId: string) => `formaai:chat:${projectId}`;

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore: persistence is a convenience, not a requirement.
  }
}

/** Renders **bold**, `code` and line breaks — enough for report instructions. */
function renderInline(text: string) {
  return text.split('\n').map((line, lineIndex) => (
    <span key={lineIndex}>
      {lineIndex > 0 && <br />}
      {line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, partIndex) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={partIndex} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={partIndex} className="rounded bg-ink-100 px-1 py-0.5 font-mono text-[11px]">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={partIndex}>{part}</span>;
      })}
    </span>
  ));
}

/** The icon and colour for each kind of trail entry. */
const TONE_STYLE: Record<ChatTone, { icon: string; className: string }> = {
  thinking: { icon: '✻', className: 'text-ink-500' },
  checking: { icon: '◇', className: 'text-ink-600' },
  action: { icon: '▶', className: 'text-brand-700' },
  result: { icon: '✓', className: 'text-emerald-700' },
  warn: { icon: '!', className: 'text-amber-700' },
  error: { icon: '✗', className: 'text-red-700' },
};

export function ChatPanel({
  projectId,
  providers,
  context,
  selectedProviderId,
  onSelectProvider,
  onOpenSettings,
  onOpenSources,
  onOpenOutline,
  onRunPipeline,
  onExport,
  onChanged,
}: {
  projectId: string;
  providers: ProviderOption[];
  context: ChatContext;
  selectedProviderId: string | null;
  onSelectProvider: (credentialId: string) => void;
  onOpenSettings: () => void;
  onOpenSources: () => void;
  onOpenOutline: () => void;
  /** Runs the full pipeline; resolves with the job's steps for the trail. */
  onRunPipeline: () => Promise<{ summary: string; steps: Array<{ name: string; status: string; message?: string }> } | null>;
  onExport: (format: 'docx' | 'pdf') => Promise<{ ok: boolean; message: string }>;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setMessages(readStored<ChatMessage[]>(MESSAGES_KEY(projectId), []));
  }, [projectId]);

  useEffect(() => {
    if (messages.length === 0) return;
    writeStored(
      MESSAGES_KEY(projectId),
      messages.filter((message) => !message.pending),
    );
  }, [messages, projectId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? providers[0] ?? null,
    [providers, selectedProviderId],
  );

  const push = useCallback((message: Omit<ChatMessage, 'id' | 'createdAt'>) => {
    const full: ChatMessage = {
      ...message,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, full]);
    return full;
  }, []);

  /** Replaces a message in place, so a pending reply can grow its trail. */
  const patch = useCallback((id: string, update: Partial<ChatMessage>) => {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, ...update } : message)));
  }, []);

  /**
   * Appends to a reply's trail instead of replacing it.
   *
   * The reasoning is the point of the trail: replacing it meant the user only ever
   * saw the last line ("Required sections checked.") and lost the "Understood as…"
   * line that explained why anything ran at all.
   */
  const appendSteps = useCallback((id: string, steps: ChatStep[]) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, steps: [...(message.steps ?? []), ...steps] } : message)),
    );
  }, []);

  /**
   * Reports the real state of the report, naming the sections that are actually
   * empty. A vague "you have some gaps" was useless: the user needs the heading.
   */
  const statusLines = useCallback((): ChatStep[] => {
    const steps: ChatStep[] = [];
    steps.push({
      tone: 'checking',
      text: context.hasTemplate
        ? `Template read: ${context.total} section${context.total === 1 ? '' : 's'} in the outline.`
        : 'No template yet, so there is no outline.',
    });
    steps.push({
      tone: 'checking',
      text: context.hasSources ? 'Source documents are attached and readable.' : 'No source documents attached yet.',
    });
    steps.push({
      tone: 'checking',
      text: context.hasProvider
        ? `Model ready: ${selectedProvider?.model ?? 'selected provider'}.`
        : 'No AI provider configured, so no section can be drafted.',
    });
    if (context.total > 0) {
      steps.push({
        tone: context.drafted === context.total ? 'result' : 'warn',
        text: `${context.drafted} of ${context.total} sections have content.`,
      });
    }
    if (context.emptyHeadings.length > 0) {
      steps.push({
        tone: 'warn',
        text: `Still empty: ${context.emptyHeadings.slice(0, 8).join(', ')}${
          context.emptyHeadings.length > 8 ? `, and ${context.emptyHeadings.length - 8} more` : ''
        }.`,
      });
    }
    if (context.exportReady) steps.push({ tone: 'result', text: 'A DOCX export is ready to download.' });
    return steps;
  }, [context, selectedProvider]);

  /** Runs the pipeline and turns its step report into the visible trail. */
  const runGenerate = useCallback(
    async (replyId: string, target?: string) => {
      if (!context.hasTemplate) {
        appendSteps(replyId, [{ tone: 'error', text: 'Blocked: no template.' }]);
        patch(replyId, {
          text: 'I need a template first. Add your `.docx` and its headings become the report structure.',
          pending: false,
        });
        return;
      }
      if (!context.hasSources) {
        appendSteps(replyId, [{ tone: 'error', text: 'Blocked: no sources.' }]);
        patch(replyId, {
          text: 'The template is read, but there is nothing to write from. Add a source (PDF, DOCX, TXT, image or `.zip`).',
          pending: false,
        });
        return;
      }
      if (!context.hasProvider) {
        appendSteps(replyId, [{ tone: 'error', text: 'Blocked: no AI provider.' }]);
        patch(replyId, {
          text: 'Everything is ready except a model. Add your provider key in **Settings → AI providers**.',
          pending: false,
        });
        return;
      }

      appendSteps(replyId, [
        { tone: 'thinking', text: 'Reading the template structure and matching your sources to each heading…' },
        { tone: 'action', text: target ? `Drafting “${target}”` : 'Drafting every section' },
      ]);
      const result = await onRunPipeline();
      if (!result) {
        appendSteps(replyId, [{ tone: 'error', text: 'The pipeline request failed.' }]);
        patch(replyId, {
          text: 'The run could not be started. Open the job list for the exact error.',
          pending: false,
        });
        return;
      }
      const lines = summariseSteps(result.summary, result.steps);
      const failed = result.steps.some((step) => step.status === 'failed');
      appendSteps(
        replyId,
        lines.map((line) => {
          // Step lines are prefixed by the marker ("✓ "); the closing summary line
          // is not, so only strip a marker that is actually there.
          const marked = /^[✓·✗]\s/.test(line);
          const text = marked ? line.slice(2) : line;
          const tone: ChatTone = line.startsWith('✗') ? 'error' : line.startsWith('·') ? 'warn' : 'result';
          return { tone, text };
        }),
      );
      patch(replyId, {
        text: failed
          ? 'The run stopped early. The failing step is listed above, and nothing already written was lost.'
          : 'Done. The preview on the right shows the assembled document.',
        pending: false,
      });
      onChanged();
    },
    [context, onRunPipeline, onChanged, patch, appendSteps],
  );

  const handleAction = useCallback(
    async (action: ChatAction, replyId: string) => {
      switch (action.kind) {
        case 'generate-all':
        case 'generate-section':
          await runGenerate(replyId, action.target);
          return;
        case 'export-docx':
        case 'export-pdf': {
          const format = action.kind === 'export-pdf' ? 'pdf' : 'docx';
          appendSteps(replyId, [
            { tone: 'thinking', text: `Checking that every required section has content…` },
            { tone: 'action', text: `Building the ${format.toUpperCase()} file` },
          ]);
          const outcome = await onExport(format);
          appendSteps(replyId, [
            { tone: 'checking', text: 'Required sections checked.' },
            { tone: outcome.ok ? 'result' : 'error', text: outcome.message },
          ]);
          patch(replyId, {
            text: outcome.ok
              ? `Your ${format.toUpperCase()} is ready — open **Downloads** to get it.`
              : 'The file was not produced. The reason is above; fix it and ask me again.',
            pending: false,
          });
          onChanged();
          return;
        }
        case 'open-sources':
          appendSteps(replyId, [{ tone: 'action', text: 'Opening the Sources panel.' }]);
          patch(replyId, {
            text: 'Sources is open in the drawer. Drop files or a `.zip` there — archives are expanded automatically.',
            pending: false,
          });
          onOpenSources();
          return;
        case 'open-outline':
          appendSteps(replyId, [
            { tone: 'checking', text: `The outline has ${context.total} sections; ${context.drafted} have content.` },
            { tone: 'action', text: 'Opening the outline.' },
          ]);
          patch(replyId, {
            text: 'The outline is open. Click any section to read or edit what was written for it.',
            pending: false,
          });
          onOpenOutline();
          return;
        case 'status':
          appendSteps(replyId, statusLines());
          patch(replyId, {
            text:
              context.emptyHeadings.length > 0
                ? 'Those sections need either a source or a line of your own. Ask me to **generate** and I will draft everything that has evidence.'
                : 'Everything that has a source is written. Ask me to **export** when you are happy with the preview.',
            pending: false,
          });
          return;
        default: {
          // A free-form instruction: store it on the project so the next draft
          // follows it, and say so plainly instead of pretending to chat.
          appendSteps(replyId, [{ tone: 'action', text: 'Saving this as a standing instruction for the report.' }]);
          try {
            await api.patch(`/api/projects/${projectId}`, { instructions: action.text });
            appendSteps(replyId, [
              { tone: 'result', text: 'Instruction saved on the project.' },
              { tone: 'thinking', text: 'It will be applied the next time I draft a section.' },
            ]);
            patch(replyId, {
              text: 'Noted. Say **generate** when you want me to apply it.',
              pending: false,
            });
          } catch (error) {
            appendSteps(replyId, [{ tone: 'error', text: `Could not save: ${errorMessage(error)}` }]);
            patch(replyId, {
              text: 'That instruction was not saved, so I will not rely on it.',
              pending: false,
            });
          }
        }
      }
    },
    [runGenerate, onExport, onOpenSources, onOpenOutline, statusLines, context, projectId, patch, appendSteps, onChanged],
  );

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    push({ role: 'user', text });
    setDraft('');
    const reply = push({ role: 'assistant', text: '', pending: true, steps: [{ tone: 'thinking', text: 'Reading your message…' }] });

    try {
      // Planning is inside the try: if it throws, the reply must still be answered.
      // Leaving it outside meant a message could sit as "pending" forever with no
      // reply at all — which reads as the assistant silently ignoring the user.
      const action = planChatAction(text, { headings: context.headings });
      // Appended, not replaced: the trail should read as a sequence of what the
      // assistant did, starting with how it understood the request.
      appendSteps(reply.id, [{ tone: 'checking', text: `Understood as: ${action.label.toLowerCase()}.` }]);
      await handleAction(action, reply.id);
    } catch (error) {
      appendSteps(reply.id, [{ tone: 'error', text: errorMessage(error) }]);
      patch(reply.id, {
        text: 'Something failed while running that. The error is above.',
        pending: false,
      });
      toast.error(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  /** Uploads through the same endpoint the Sources panel uses. */
  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const chosen = Array.from(files);
    const reply = push({
      role: 'assistant',
      text: '',
      pending: true,
      steps: [{ tone: 'action', text: `Uploading ${chosen.length} file${chosen.length === 1 ? '' : 's'}…` }],
    });

    const results: ChatAttachment[] = [];
    for (const file of chosen) {
      try {
        const form = new FormData();
        // "kind" must be appended BEFORE the file: @fastify/multipart only exposes
        // fields parsed ahead of the file part, so sending it afterwards silently
        // fell back to "source". That is how a template uploaded from the chat was
        // stored as a plain source, leaving the project with 0 sections and a dead
        // "Scan & generate" button.
        // A `.docx` is the template when there is none yet, otherwise evidence.
        form.append('kind', !context.hasTemplate && /\.docx$/i.test(file.name) ? 'template' : 'source');
        form.append('file', file);
        const response = await fetch(`/api/projects/${projectId}/documents`, {
          method: 'POST',
          credentials: 'same-origin',
          body: form,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `Upload failed (${response.status}).`);
        }
        results.push({ name: file.name, status: 'done' });
      } catch (error) {
        results.push({ name: file.name, status: 'failed', message: errorMessage(error) });
      }
    }

    const failed = results.filter((item) => item.status === 'failed');
    const zipped = chosen.some((file) => /\.zip$/i.test(file.name));
    patch(reply.id, {
      attachments: results,
      steps: [
        { tone: 'action', text: `Uploaded ${results.length - failed.length} of ${results.length} file(s).` },
        ...(zipped ? [{ tone: 'checking' as const, text: 'Archive detected: every file inside is extracted and read.' }] : []),
        ...(failed.length > 0
          ? failed.map((item) => ({ tone: 'error' as const, text: `${item.name}: ${item.message ?? 'rejected'}` }))
          : [{ tone: 'result' as const, text: 'Text extracted. Ask me to **generate** when ready.' }]),
      ],
      text:
        failed.length > 0
          ? 'Some files were not accepted — the reasons are above.'
          : 'Added. I can read PDF, Word, text, spreadsheets, images (OCR) and `.zip` archives.',
      pending: false,
    });
    onChanged();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  const busy = context.busy;

  return (
    <section className="card flex min-h-0 flex-col overflow-hidden" aria-label="Chat" data-testid="chat-panel">
      <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-900">Report assistant</h2>
          <p className="truncate text-xs text-ink-500">
            {`${context.drafted} of ${context.total} sections written`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="btn-secondary text-xs" onClick={onOpenSources} data-testid="chat-open-sources">
            Sources
          </button>
          <button type="button" className="btn-secondary text-xs" onClick={onOpenOutline} data-testid="chat-open-outline">
            Outline
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              className="text-xs text-ink-500 hover:text-ink-800"
              onClick={() => {
                setMessages([]);
                writeStored(MESSAGES_KEY(projectId), []);
              }}
              data-testid="chat-clear"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4" ref={scrollRef} data-testid="chat-messages">
        {messages.length === 0 && (
          <div className="mx-auto mt-6 max-w-md space-y-3 text-sm text-ink-600">
            <p className="font-medium text-ink-900">What are we writing today?</p>
            <p className="text-xs">
              {!context.hasTemplate
                ? 'Start by attaching your .docx template below — I will read its headings.'
                : !context.hasSources
                  ? 'Now attach the sources this report should be written from.'
                  : !context.hasProvider
                    ? 'One step left: add an AI provider so drafting can run.'
                    : 'Ask me to generate the report, check what is missing, or export it.'}
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => fileInputRef.current?.click()}
                data-testid="chat-empty-upload"
              >
                + Attach files
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => void send()}
                disabled={busy}
                data-testid="chat-empty-generate"
              >
                Generate the report
              </button>
            </div>
          </div>
        )}

        <ol className="space-y-5">
          {messages.map((message) => (
            <li
              key={message.id}
              className={message.role === 'user' ? 'flex justify-end' : 'block'}
              data-testid={`chat-message-${message.role}`}
            >
              {message.role === 'user' ? (
                <div className="max-w-[85%] rounded-lg rounded-br-sm bg-brand-600 px-3 py-2 text-sm text-white">
                  <p className="whitespace-pre-wrap break-words">{renderInline(message.text)}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* The reasoning trail: what was understood, checked and run. */}
                  {message.steps && message.steps.length > 0 && (
                    <ol className="space-y-1 border-l-2 border-ink-200 pl-3" data-testid="chat-steps">
                      {message.steps.map((step, index) => (
                        <li key={index} className={`flex gap-2 text-xs ${TONE_STYLE[step.tone].className}`}>
                          <span aria-hidden className="w-3 shrink-0 text-center font-semibold">
                            {TONE_STYLE[step.tone].icon}
                          </span>
                          <span className="min-w-0 break-words">{step.text}</span>
                        </li>
                      ))}
                      {message.pending && (
                        <li className="flex gap-2 text-xs text-ink-400">
                          <span aria-hidden className="w-3 shrink-0 text-center">
                            ⋯
                          </span>
                          <span>Working…</span>
                        </li>
                      )}
                    </ol>
                  )}
                  {message.text && (
                    <div className="text-sm leading-relaxed text-ink-800">
                      <p className="whitespace-pre-wrap break-words">{renderInline(message.text)}</p>
                    </div>
                  )}
                  {message.attachments && message.attachments.length > 0 && (
                    <ul className="space-y-1" data-testid="chat-attachments">
                      {message.attachments.map((file) => (
                        <li
                          key={file.name}
                          className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${
                            file.status === 'failed'
                              ? 'border-red-200 bg-red-50 text-red-800'
                              : 'border-ink-200 bg-white text-ink-700'
                          }`}
                        >
                          <span aria-hidden>{file.status === 'failed' ? '✗' : '📄'}</span>
                          <span className="truncate">{file.name}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="border-t border-ink-200 p-3">
        <div className="rounded-xl border border-ink-300 bg-white focus-within:border-brand-400">
          <div className="flex items-end gap-1 px-2 pt-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void uploadFiles(event.target.files);
                event.target.value = '';
              }}
              data-testid="chat-file-input"
            />
            <button
              type="button"
              className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink-300 text-ink-600 hover:bg-ink-50"
              onClick={() => fileInputRef.current?.click()}
              title="Attach files (including .zip)"
              aria-label="Attach files"
              data-testid="chat-attach"
            >
              +
            </button>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask for changes, or say “generate the report”…"
              className="max-h-32 min-h-[32px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-sm text-ink-900 outline-none placeholder:text-ink-400"
              data-testid="chat-input"
            />
            <button
              type="button"
              className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm text-white disabled:opacity-40"
              onClick={() => void send()}
              disabled={!draft.trim() || sending || busy}
              aria-label="Send message"
              data-testid="chat-send"
            >
              ↑
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-1">
            <label className="flex min-w-0 items-center gap-1 text-[11px] text-ink-500">
              <span className="sr-only">Model</span>
              {providers.length > 0 ? (
                <select
                  value={selectedProvider?.id ?? ''}
                  onChange={(event) => onSelectProvider(event.target.value)}
                  className="max-w-[210px] truncate rounded border-0 bg-transparent py-0.5 text-[11px] text-ink-700 outline-none"
                  data-testid="chat-model"
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.model} · {provider.providerType}
                    </option>
                  ))}
                </select>
              ) : (
                <button type="button" className="underline hover:text-ink-800" onClick={onOpenSettings} data-testid="chat-no-model">
                  No model — add a provider
                </button>
              )}
            </label>
            <span className="shrink-0 truncate text-[10px] text-ink-400" data-testid="chat-hint">
              {busy ? 'Working…' : 'Enter to send · Shift+Enter for a new line'}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
