import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider } from '../lib/session';
import { ToastProvider } from '../lib/toast';
import { ProjectWorkspacePage } from '../pages/ProjectWorkspacePage';
import { installFetchMock } from '../test/fetchMock';

/**
 * Zero-delay typing.
 *
 * The default `userEvent.type` waits between keystrokes. This file types several
 * long sentences per test, and on a loaded CI runner those waits pushed a single
 * test past its 30 s budget. A test aborted mid-`type` never runs its teardown, so
 * its committed tree stayed mounted and the *next* test found two chat transcripts
 * (`Found multiple elements by: [data-testid="chat-steps"]`) â€” eleven cascading
 * failures that never reproduced locally.
 *
 * Removing the artificial delay keeps the same behavioural coverage without the
 * wall-clock cost. `delay: null` is user-event's documented way to do this.
 */
const user = userEvent.setup({ delay: null });

const projectId = '11111111-1111-4111-8111-111111111111';
const sectionId = '22222222-2222-4222-8222-222222222222';

const project = {
  id: projectId,
  title: 'Q3 Report',
  reportType: null,
  language: 'en',
  tone: 'formal',
  audience: null,
  instructions: null,
  targetLength: 'medium',
  status: 'draft',
  templateReady: true,
  mappingReady: true,
  archivedAt: null,
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  documentCount: 1,
  sourceCount: 1,
};

const outline = [
  {
    id: sectionId,
    heading: 'Introduction',
    level: 1,
    sortOrder: 0,
    required: true,
    excluded: false,
    insertionStrategy: 'after_heading' as const,
    placeholder: null,
    instructions: null,
    tableCount: 0,
    bodyPreview: null,
  },
];

function baseRoutes(overrides: Record<string, () => { status?: number; json?: unknown }> = {}) {
  return {
    'GET /api/auth/session': () => ({
      json: { user: { id: 'u1', email: 'a@b.test', role: 'user', displayName: 'A' }, fallbackCredentialId: null, registrationEnabled: true },
    }),
    [`GET /api/projects/${projectId}`]: () => ({ json: { project } }),
    [`GET /api/projects/${projectId}/documents`]: () => ({
      json: {
        documents: [
          {
            id: 'doc-t',
            kind: 'template',
            originalName: 'template.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 1024,
            status: 'extracted',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'doc-s',
            kind: 'source',
            originalName: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 512,
            status: 'extracted',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
    [`GET /api/projects/${projectId}/sections`]: () => ({ json: { sections: outline } }),
    // Most scenarios assume a configured provider; tests about a missing one
    // override this with an empty list.
    'GET /api/provider-credentials': () => ({
      json: {
        credentials: [
          {
            id: 'cred-1',
            displayName: 'My OpenAI key',
            providerType: 'openai-compatible',
            model: 'gpt-4o-mini',
            isDefault: true,
          },
        ],
        supportedTypes: [],
        devProviderEnabled: true,
      },
    }),
    // The chat composer saves the instruction on the project.
    [`PATCH /api/projects/${projectId}`]: () => ({ json: { project } }),
    [`GET /api/projects/${projectId}/report`]: () => ({
      json: {
        sections: [
          {
            id: 'rep-1',
            sectionId,
            content: 'The quarter was productive.',
            status: 'draft',
            revision: 1,
            warnings: [],
            citedChunkIds: [],
            placeholders: [],
            wordCount: 4,
            modelUsed: 'gpt-4o-mini',
            generatedAt: null,
            editedAt: null,
          },
        ],
        outline,
      },
    }),
    [`GET /api/projects/${projectId}/mapping`]: () => ({
      json: {
        mappings: [
          {
            sectionId,
            heading: 'Introduction',
            level: 1,
            excluded: false,
            coverage: 'strong',
            purpose: 'Set context.',
            requirements: ['Explain the quarter.'],
            gaps: [],
            evidence: [{ id: 'chunk-1', documentName: 'notes.txt', page: 1, paragraphIndex: null, text: 'Quarter notes.' }],
            producedBy: 'heuristic',
          },
        ],
      },
    }),
    [`GET /api/projects/${projectId}/exports`]: () => ({
      json: { exports: [], pdfAvailable: false },
    }),
    [`GET /api/projects/${projectId}/jobs`]: () => ({ json: { jobs: [] } }),
    [`GET /api/projects/${projectId}/sections/${sectionId}/detail`]: () => ({
      json: {
        section: outline[0],
        content: 'The quarter was productive.',
        status: 'draft',
        revision: 1,
        warnings: [],
        placeholders: [],
        citedChunkIds: [],
        modelUsed: 'gpt-4o-mini',
        mapping: {
          purpose: 'Set context.',
          requirements: ['Explain the quarter.'],
          gaps: [],
          conflicts: [],
          contentPlan: [],
          coverage: 'strong',
          producedBy: 'heuristic',
        },
        evidence: [{ id: 'chunk-1', documentName: 'notes.txt', page: 1, paragraphIndex: null, text: 'Quarter notes.' }],
      },
    }),
    ...overrides,
  };
}

function renderWorkspace() {
  return render(
    <SessionProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectWorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </SessionProvider>,
  );
}

describe('ProjectWorkspacePage', () => {
  it('opens with chat and the document preview, and keeps sources and the outline in drawers', async () => {
    installFetchMock(baseRoutes());
    renderWorkspace();

    expect(await screen.findByRole('heading', { name: 'Q3 Report' })).toBeInTheDocument();
    // The two panes the user asked for: chat beside the document preview.
    expect(screen.getByLabelText('Chat')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument();

    // Sources and outline are not in the grid any more â€” they are opened on demand.
    expect(screen.queryByText('template.docx')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open section Introduction' })).not.toBeInTheDocument();

    await user.click(screen.getByTestId('chat-open-sources'));
    expect(await screen.findByText('template.docx')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    await user.click(screen.getByTestId('drawer-close'));

    await user.click(screen.getByTestId('chat-open-outline'));
    // Outline entry exists (the row button, not its remove control).
    expect(await screen.findByRole('button', { name: 'Open section Introduction' })).toBeInTheDocument();
    // Selecting a section opens its editor inside the same drawer.
    await user.click(screen.getByRole('button', { name: 'Open section Introduction' }));
    const editor = (await screen.findByLabelText('Section content')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('The quarter was productive.'));
    // Mapping coverage is surfaced.
    expect(screen.getAllByText('Strong coverage').length).toBeGreaterThan(0);
  });

  it('saves edited content through the real PATCH endpoint', async () => {
    const { calls } = installFetchMock(
      baseRoutes({
        [`PATCH /api/projects/${projectId}/sections/${sectionId}/content`]: () => ({
          json: { section: { id: sectionId, content: 'Edited body.', status: 'draft', revision: 2, wordCount: 2, updatedAt: null } },
        }),
      }),
    );
    renderWorkspace();

    await screen.findByRole('heading', { name: 'Q3 Report' });
    await user.click(screen.getByTestId('chat-open-outline'));
    await user.click(await screen.findByRole('button', { name: 'Open section Introduction' }));

    const editor = (await screen.findByLabelText('Section content')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('The quarter was productive.'));

    await user.clear(editor);
    await user.type(editor, 'Edited body.');
    // The explicit Save button triggers the request immediately.
    const editorPane = screen.getByLabelText('Section editor');
    await user.click(within(editorPane).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find(
        (call) => call.method === 'PATCH' && call.path === `/api/projects/${projectId}/sections/${sectionId}/content`,
      );
      expect(patch?.body).toEqual({ content: 'Edited body.' });
    });
  });

  it('disables PDF export when the server reports no converter', async () => {
    installFetchMock(baseRoutes());
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    await user.click(screen.getByRole('tab', { name: 'Export' }));
    const pdfButton = await screen.findByRole('button', { name: 'Export PDF' });
    await waitFor(() => expect(pdfButton).toBeDisabled());
    // DOCX export remains available because content exists.
    expect(screen.getByRole('button', { name: 'Export editable DOCX' })).toBeEnabled();
  });

  /**
   * Regression for the "template + sources ready, 0/0 drafted, mapping failed"
   * workspace: the outline was empty and nothing explained why, and a failed
   * map_evidence job showed only the word "failed".
   */
  it('explains a template that produced no headings instead of offering mapping', async () => {
    installFetchMock(
      baseRoutes({
        [`GET /api/projects/${projectId}/sections`]: () => ({ json: { sections: [] } }),
        [`GET /api/projects/${projectId}/report`]: () => ({ json: { sections: [], outline: [] } }),
        [`GET /api/projects/${projectId}/mapping`]: () => ({ json: { mappings: [] } }),
        [`GET /api/projects/${projectId}/template`]: () => ({
          json: {
            template: null,
            structure: null,
            sections: [],
            latestJob: { id: 'job-t', status: 'succeeded', stage: 'done', errorMessage: null },
          },
        }),
      }),
    );
    renderWorkspace();

    expect(await screen.findByText(/No sections were found in your template/i)).toBeInTheDocument();
    // Mapping must not be offered when there is nothing to map onto.
    expect(screen.queryByRole('button', { name: 'Map evidence' })).not.toBeInTheDocument();
    // The chat header reports the same count, so "0 of 0 sections written" is
    // still visible without opening a pane.
    expect(screen.getByText('0 of 0 sections written')).toBeInTheDocument();
  });

  it('surfaces the reason a failed evidence mapping failed', async () => {
    installFetchMock(
      baseRoutes({
        [`GET /api/projects/${projectId}/mapping`]: () => ({ json: { mappings: [] } }),
        [`GET /api/projects/${projectId}/jobs`]: () => ({
          json: {
            jobs: [
              {
                id: 'job-m',
                kind: 'map_evidence',
                status: 'failed',
                stage: 'done',
                progress: 100,
                errorCode: 'JOB_FAILED',
                errorMessage: 'No AI provider is configured for this account.',
                createdAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
              },
            ],
          },
        }),
      }),
    );
    renderWorkspace();

    expect(await screen.findByText(/Mapping evidence failed/i)).toBeInTheDocument();
    // The server's message is shown, never swallowed, and the user can retry.
    expect(screen.getAllByText(/No AI provider is configured for this account\./).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  /**
   * The expected flow is one click. These tests pin the scan panel's contract:
   * it posts to the pipeline endpoint, shows each step, and never pretends work
   * happened when the server reports a failure.
   */
  it('starts a one-click scan that posts to the pipeline endpoint', async () => {
    const { calls } = installFetchMock(
      baseRoutes({
        [`POST /api/projects/${projectId}/pipeline`]: () => ({ status: 202, json: { jobId: 'job-scan' } }),
      }),
    );
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    const start = await screen.findByTestId('scan-start');
    await user.click(start);

    await waitFor(() => {
      const post = calls.find(
        (call) => call.method === 'POST' && call.path === `/api/projects/${projectId}/pipeline`,
      );
      expect(post).toBeTruthy();
      // Exports are requested by default so the user ends up with a file.
      expect(post?.body).toMatchObject({ useAi: true, exportFormats: ['docx', 'pdf'] });
    });
  });

  it('shows live step progress while the scan runs', async () => {
    installFetchMock(
      baseRoutes({
        [`GET /api/projects/${projectId}/jobs`]: () => ({
          json: {
            jobs: [
              {
                id: 'job-scan',
                kind: 'run_pipeline',
                status: 'running',
                stage: 'drafting 2/5',
                progress: 60,
                createdAt: new Date().toISOString(),
                finishedAt: null,
              },
            ],
          },
        }),
      }),
    );
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    const panel = await screen.findByTestId('scan-panel');
    await waitFor(() => expect(panel.getAttribute('data-status')).toBe('running'));
    // The running stage is shown verbatim so the user sees the actual work.
    expect(await screen.findByTestId('scan-stage')).toHaveTextContent(/drafting 2\/5/i);
    // And the button is locked while it runs.
    expect(screen.getByTestId('scan-start')).toBeDisabled();
  });

  it('reports each finished step and the outcome when a scan succeeds', async () => {
    installFetchMock(
      baseRoutes({
        [`GET /api/projects/${projectId}/jobs`]: () => ({
          json: {
            jobs: [
              {
                id: 'job-scan',
                kind: 'run_pipeline',
                status: 'succeeded',
                stage: 'done',
                progress: 100,
                createdAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                result: {
                  summary: 'Drafted 3 sections from 2 sources.',
                  steps: [
                    { name: 'analyze', status: 'done', message: 'Outline ready with 3 sections.' },
                    { name: 'map', status: 'done', message: '3 of 3 sections have supporting evidence.' },
                    { name: 'draft', status: 'done', message: 'Drafted 3 sections.' },
                    { name: 'export', status: 'done', message: 'Exported DOCX and PDF.' },
                  ],
                  exports: [{ format: 'docx', exportId: 'e1', status: 'ready' }],
                },
              },
            ],
          },
        }),
      }),
    );
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    const result = await screen.findByTestId('scan-result');
    expect(result).toHaveTextContent(/Drafted 3 sections from 2 sources/);
    // Steps carry their own explanation, not just a tick.
    expect(screen.getByText('3 of 3 sections have supporting evidence.')).toBeInTheDocument();
    expect(screen.getByText('Exported DOCX and PDF.')).toBeInTheDocument();
  });

  it('shows which step failed and why, instead of a generic error', async () => {
    installFetchMock(
      baseRoutes({
        [`GET /api/projects/${projectId}/jobs`]: () => ({
          json: {
            jobs: [
              {
                id: 'job-scan',
                kind: 'run_pipeline',
                status: 'failed',
                stage: 'drafting 1/4',
                errorCode: 'PIPELINE_FAILED',
                errorMessage: 'Drafting failed: No AI provider is configured for this account.',
                createdAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                result: {
                  summary: 'Drafting failed.',
                  steps: [
                    { name: 'analyze', status: 'done', message: 'Outline ready with 4 sections.' },
                    { name: 'map', status: 'done', message: '4 of 4 sections have evidence.' },
                    { name: 'draft', status: 'failed', message: 'No AI provider is configured.' },
                  ],
                },
              },
            ],
          },
        }),
      }),
    );
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    const error = await screen.findByTestId('scan-error');
    expect(error).toHaveTextContent(/No AI provider is configured for this account/);
    // The step that failed is marked separately from the ones that succeeded.
    expect(screen.getByText('No AI provider is configured.')).toBeInTheDocument();
    expect(document.querySelector('[data-step-state="analyze:done"]')).toBeTruthy();
    expect(document.querySelector('[data-step-state="draft:failed"]')).toBeTruthy();
  });

  it('blocks scanning with a reason when no template or source exists', async () => {
    installFetchMock(
      baseRoutes({
        [`GET /api/projects/${projectId}/documents`]: () => ({ json: { documents: [] } }),
      }),
    );
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    const blocked = await screen.findByTestId('scan-blocked');
    expect(blocked).toHaveTextContent(/Upload a \.docx template first/i);
    expect(screen.getByTestId('scan-start')).toBeDisabled();
  });

  /**
   * The Preview tab shows the real exported pages. It must render the page images,
   * explain truncation, and â€” when the server has no renderer â€” say so without
   * implying the report itself is broken.
   */
  describe('preview tab', () => {
    // 1x1 transparent PNG; the component only displays whatever the API returns.
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    it('shows rendered pages of the exported document', async () => {
      installFetchMock(
        baseRoutes({
          [`GET /api/projects/${projectId}/preview`]: () => ({
            json: {
              pages: [
                { page: 1, width: 1240, height: 1754, image: png },
                { page: 2, width: 1240, height: 1754, image: png },
              ],
              pageCount: 2,
              totalPages: 2,
              truncated: false,
              renderedAt: new Date().toISOString(),
            },
          }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      await user.click(screen.getByRole('tab', { name: 'Preview' }));

      const pane = await screen.findByTestId('preview-pane');
      expect(within(pane).getByText(/Showing 2 of 2 pages/i)).toBeInTheDocument();
      // Both pages are drawn, with alt text so the layout is meaningful.
      expect(await screen.findByAltText(/Page 1 of the exported report/i)).toBeInTheDocument();
      expect(await screen.findByAltText(/Page 2 of the exported report/i)).toBeInTheDocument();
    });

    /**
     * The preview used to update only on Refresh, so it was routine to fix a
     * section and still be shown the old page. It now re-renders by itself after a
     * short debounce â€” this pins that, including the part that matters most: an
     * edit that keeps the same character count must still refresh.
     */
    it('re-renders automatically after an edit, even one that keeps the same length', async () => {
      let previewCalls = 0;
      const { calls } = installFetchMock(
        baseRoutes({
          // The save has to succeed for the refresh to be triggered at all; without
          // this route the PATCH 404s and the test would be asserting on a path the
          // user never reaches.
          [`PATCH /api/projects/${projectId}/sections/${sectionId}/content`]: () => ({
            json: {
              section: {
                id: sectionId,
                content: 'The quarter was productivf.',
                status: 'draft',
                revision: 2,
                wordCount: 4,
                updatedAt: null,
              },
            },
          }),
          [`GET /api/projects/${projectId}/preview`]: () => {
            previewCalls += 1;
            return {
              json: {
                pages: [{ page: 1, width: 1240, height: 1754, image: png }],
                pageCount: 1,
                totalPages: 1,
                truncated: false,
                renderedAt: new Date().toISOString(),
              },
            };
          },
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });
      await user.click(screen.getByRole('tab', { name: 'Preview' }));
      await screen.findByAltText(/Page 1 of the exported report/i);

      const initial = previewCalls;
      expect(initial).toBeGreaterThan(0);

      // Edit the section body with a same-length change ("productive." -> "productivf.").
      // The section editor lives in the Outline drawer, so open it first; a test
      // that silently returns when the editor is missing proves nothing, so every
      // step here is asserted.
      await user.click(screen.getByTestId('chat-open-outline'));
      await user.click(await screen.findByRole('button', { name: 'Open section Introduction' }));
      const editor = (await screen.findByLabelText('Section content')) as HTMLTextAreaElement;
      await waitFor(() => expect(editor.value).toBe('The quarter was productive.'));

      await user.clear(editor);
      await user.type(editor, 'The quarter was productivf.');
      const editorPane = screen.getByLabelText('Section editor');
      await user.click(within(editorPane).getByRole('button', { name: 'Save' }));

      // The debounce is 1200 ms; allow for the save round trip on top.
      await waitFor(() => expect(previewCalls).toBeGreaterThan(initial), { timeout: 8000 });
      expect(calls.some((call) => call.path.includes('/preview'))).toBe(true);
    });

    it('tells the user when only the first pages are shown', async () => {      installFetchMock(
        baseRoutes({
          [`GET /api/projects/${projectId}/preview`]: () => ({
            json: {
              pages: [{ page: 1, width: 1240, height: 1754, image: png }],
              pageCount: 1,
              totalPages: 9,
              truncated: true,
              renderedAt: new Date().toISOString(),
            },
          }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });
      await user.click(screen.getByRole('tab', { name: 'Preview' }));

      const note = await screen.findByTestId('preview-truncated');
      expect(note).toHaveTextContent(/Only the first 1 pages/i);
      expect(note).toHaveTextContent(/all 9 pages/i);
    });

    it('explains a missing renderer without blaming the report', async () => {
      installFetchMock(
        baseRoutes({
          [`GET /api/projects/${projectId}/preview`]: () => ({
            status: 501,
            json: {
              error: {
                code: 'PREVIEW_UNAVAILABLE',
                message: 'Page preview needs LibreOffice on the server.',
              },
            },
          }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });
      await user.click(screen.getByRole('tab', { name: 'Preview' }));

      const error = await screen.findByTestId('preview-error');
      expect(error).toHaveTextContent(/not available on this server/i);
      expect(error).toHaveTextContent(/report text in the/i);
    });
  });

  /**
   * A project whose template already contains text looks finished in the Preview
   * tab even when nothing was drafted, which is how "my sources were ignored" was
   * reported when the real cause was "the scan never ran".
   */
  it('says the report has not been written yet instead of showing template text as if it were the report', async () => {
    installFetchMock(
      baseRoutes({
        [`GET /api/projects/${projectId}/report`]: () => ({
          json: {
            // Sections exist, but none has content.
            sections: [
              {
                id: 'rep-1',
                sectionId,
                content: '',
                status: 'empty',
                revision: 1,
                warnings: [],
                citedChunkIds: [],
                placeholders: [],
                wordCount: 0,
                modelUsed: null,
                generatedAt: null,
                editedAt: null,
              },
            ],
            outline,
          },
        }),
        [`GET /api/projects/${projectId}/preview`]: () => ({
          json: {
            pages: [
              {
                page: 1,
                width: 1240,
                height: 1754,
                image:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              },
            ],
            pageCount: 1,
            totalPages: 1,
            truncated: false,
            renderedAt: new Date().toISOString(),
          },
        }),
      }),
    );
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    await user.click(screen.getByRole('tab', { name: 'Preview' }));

    const banner = await screen.findByTestId('preview-not-generated');
    expect(banner).toHaveTextContent(/has not been written yet/i);
    expect(banner).toHaveTextContent(/Scan & generate/i);
  });

  /**
   * Without a provider the scan can only fail at the draft step. Saying so before
   * the click turns an unexplained empty report into one clear instruction.
   */
  it('blocks scanning with an actionable reason when no AI provider exists', async () => {
    installFetchMock(
      baseRoutes({
        'GET /api/provider-credentials': () => ({ json: { credentials: [], supportedTypes: [], devProviderEnabled: true } }),
      }),
    );
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    const blocked = await screen.findByTestId('scan-blocked');
    // Names the cause and where to fix it.
    expect(blocked).toHaveTextContent(/Add an AI provider/i);
    expect(blocked).toHaveTextContent(/Settings/i);
    expect(screen.getByTestId('scan-start')).toBeDisabled();

    // The banner points at the same cause rather than telling the user to press
    // a button that cannot work.
    const banner = await screen.findByTestId('banner-no-provider');
    expect(banner).toHaveTextContent(/No AI provider is configured/i);
  });

  it('allows scanning again once a provider is configured', async () => {
    installFetchMock(baseRoutes());
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Q3 Report' });

    await waitFor(() => expect(screen.getByTestId('scan-start')).toBeEnabled());
    expect(screen.queryByTestId('scan-blocked')).not.toBeInTheDocument();
  });

  describe('chat panel', () => {
    it('renders a composer and the configured model', async () => {
      installFetchMock(baseRoutes());
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      expect(within(chat).getByTestId('chat-input')).toBeInTheDocument();

      // The picker shows the model name so the choice is visible, like Claude.
      const model = await within(chat).findByTestId('chat-model');
      expect(model).toHaveTextContent(/gpt-4o-mini/i);
    });

    it('records a sent message and answers with the next real action', async () => {
      installFetchMock(baseRoutes());
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      const input = within(chat).getByTestId('chat-input');
      await user.type(input, 'Tolong perkuat bagian analisis routing');
      await user.click(within(chat).getByTestId('chat-send'));

      // The user's message is kept in the transcript.
      const userMessage = await within(chat).findByTestId('chat-message-user');
      expect(userMessage).toHaveTextContent(/perkuat bagian analisis routing/i);

      // The reply reports state, not invented prose.
      const reply = await within(chat).findByTestId('chat-message-assistant');
      expect(reply).toHaveTextContent(/instruction/i);
    });

    it('explains that a model is needed when none is configured', async () => {
      installFetchMock(
        baseRoutes({
          'GET /api/provider-credentials': () => ({ json: { credentials: [], supportedTypes: [], devProviderEnabled: true } }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      // No select: instead a direct link to fix it.
      expect(await within(chat).findByTestId('chat-no-model')).toHaveTextContent(/add a provider/i);
    });

    /**
     * The user asked for this explicitly: "saya mau seperti chatbot aja biar ada
     * feedback dan langsung reason disana". So a reply must show its reasoning in
     * the transcript, not just a final sentence.
     */
    it('shows the reasoning trail inline, not only the final answer', async () => {
      installFetchMock(baseRoutes());
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'what is the status?');
      await user.click(within(chat).getByTestId('chat-send'));

      const steps = await within(chat).findByTestId('chat-steps');
      // A question is ANSWERED from the project's real state, so the trail carries the
      // facts behind the answer rather than "understood as â€¦" for a command.
      // It reports the real state of this project: 1 section, 1 written.
      expect(steps).toHaveTextContent(/Template read: 1 section/i);
      expect(steps).toHaveTextContent(/1 of 1 sections have content/i);
      // And it names the configured model it will use.
      expect(steps).toHaveTextContent(/gpt-4o-mini/i);
      // The answer itself is not empty and refers to the report's state.
      expect(within(chat).getByTestId('chat-answer')).toHaveTextContent(
        /sections (have|has) content|Nothing is empty/i,
      );
    });

    it('reports empty sections by heading when the report is not finished', async () => {
      installFetchMock(
        baseRoutes({
          [`GET /api/projects/${projectId}/report`]: () => ({ json: { sections: [], outline } }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'which part is still empty?');
      await user.click(within(chat).getByTestId('chat-send'));

      const steps = await within(chat).findByTestId('chat-steps');
      expect(steps).toHaveTextContent(/Still empty: Introduction/i);
    });

    it('asks for a template instead of pretending to draft without one', async () => {
      installFetchMock(
        baseRoutes({
          [`GET /api/projects/${projectId}/documents`]: () => ({ json: { documents: [] } }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'generate the report');
      await user.click(within(chat).getByTestId('chat-send'));

      const steps = await within(chat).findByTestId('chat-steps');
      expect(steps).toHaveTextContent(/Blocked: no template/i);
      const reply = await within(chat).findByTestId('chat-message-assistant');
      expect(reply).toHaveTextContent(/template first/i);
    });

    it('runs the real pipeline when asked to generate, and reports each step', async () => {
      const { calls } = installFetchMock(
        baseRoutes({
          [`POST /api/projects/${projectId}/pipeline`]: () => ({ status: 202, json: { jobId: 'job-1' } }),
          [`GET /api/projects/${projectId}/jobs/job-1`]: () => ({
            json: {
              job: {
                id: 'job-1',
                status: 'succeeded',
                stage: 'done',
                progress: 100,
                errorMessage: null,
                result: {
                  summary: 'Report drafted and exported.',
                  steps: [
                    { name: 'analyze', status: 'done', message: 'Template read: 1 section.' },
                    { name: 'draft', status: 'done', message: 'Drafted 1 section.' },
                  ],
                },
              },
            },
          }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'generate the report');
      await user.click(within(chat).getByTestId('chat-send'));

      // The action really reached the API, with the selected provider attached.
      await waitFor(() => {
        const post = calls.find((call) => call.method === 'POST' && call.path === `/api/projects/${projectId}/pipeline`);
        expect(post?.body).toMatchObject({ useAi: true, providerCredentialId: 'cred-1' });
      });

      // The reply contains the pipeline's own step report.
      const steps = await within(chat).findByTestId('chat-steps');
      await waitFor(() => expect(steps).toHaveTextContent(/Drafted 1 section/i), { timeout: 6000 });
      expect(steps).toHaveTextContent(/Template read: 1 section/i);
      expect(steps).toHaveTextContent(/Report drafted and exported/i);
    });

    it('shows the failing step and its reason instead of a generic error', async () => {
      installFetchMock(
        baseRoutes({
          [`POST /api/projects/${projectId}/pipeline`]: () => ({ status: 202, json: { jobId: 'job-2' } }),
          [`GET /api/projects/${projectId}/jobs/job-2`]: () => ({
            json: {
              job: { id: 'job-2', status: 'failed', stage: 'drafting', progress: 40, errorMessage: 'Provider rejected the key.', result: null },
            },
          }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'generate the report');
      await user.click(within(chat).getByTestId('chat-send'));

      const steps = await within(chat).findByTestId('chat-steps');
      await waitFor(() => expect(steps).toHaveTextContent(/Provider rejected the key/i), { timeout: 6000 });
      const reply = await within(chat).findByTestId('chat-message-assistant');
      expect(reply).toHaveTextContent(/stopped early|not processed|Nothing was lost/i);
    });

    it('exports from the chat and reports the file is ready', async () => {
      const { calls } = installFetchMock(
        baseRoutes({
          [`POST /api/projects/${projectId}/exports`]: () => ({ status: 202, json: { jobId: 'job-3', exportId: 'exp-1' } }),
          [`GET /api/projects/${projectId}/jobs/job-3`]: () => ({
            json: { job: { id: 'job-3', status: 'succeeded', stage: 'done', progress: 100, errorMessage: null, result: null } },
          }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'export the docx');
      await user.click(within(chat).getByTestId('chat-send'));

      await waitFor(() => {
        const post = calls.find((call) => call.method === 'POST' && call.path === `/api/projects/${projectId}/exports`);
        expect(post?.body).toEqual({ format: 'docx' });
      });
      const steps = await within(chat).findByTestId('chat-steps');
      await waitFor(() => expect(steps).toHaveTextContent(/DOCX file was built and saved/i), { timeout: 6000 });
    });

    /**
     * Test 6: the file was produced but the cover still said
     * "[ Tuliskan Nama Lengkap Anda ]". The assistant must ask for the missing
     * details itself instead of silently handing over a blank cover.
     */
    it('asks for the cover details when the exported file still has them blank', async () => {
      installFetchMock(
        baseRoutes({
          [`POST /api/projects/${projectId}/exports`]: () => ({ status: 202, json: { jobId: 'job-cover', exportId: 'exp-cover' } }),
          [`GET /api/projects/${projectId}/jobs/job-cover`]: () => ({
            json: {
              job: {
                id: 'job-cover',
                status: 'succeeded',
                stage: 'done',
                progress: 100,
                errorMessage: null,
                result: { missingCoverFields: ['Nama', 'NIM', 'Kelas', 'Tanggal'] },
              },
            },
          }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'export the docx');
      await user.click(within(chat).getByTestId('chat-send'));

      const answer = await within(chat).findByTestId('chat-answer', {}, { timeout: 8000 });
      await waitFor(() => expect(answer).toHaveTextContent(/still blank on the cover/i), { timeout: 8000 });
      expect(answer).toHaveTextContent(/Nama/);
      expect(answer).toHaveTextContent(/NIM/);
      const steps = await within(chat).findByTestId('chat-steps');
      expect(steps).toHaveTextContent(/Cover still blank/i);
    });

    /**
     * A message that supplies identity used to be stored verbatim, so the export
     * parser read "Farid, NIM: 124140210" as the name and never saw the other
     * fields. Canonical lines are what `identityReplacements()` understands.
     */
    it('stores cover details as canonical lines the export can read', async () => {
      const { calls } = installFetchMock(baseRoutes());
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(
        within(chat).getByTestId('chat-input'),
        'Nama: Farid Rizky Fauzan, NIM: 124140210, Kelas: RA',
      );
      await user.click(within(chat).getByTestId('chat-send'));

      await waitFor(() => {
        const patch = calls.find((call) => call.method === 'PATCH' && call.path === `/api/projects/${projectId}`);
        expect(patch?.body).toEqual({
          instructions: 'Nama: Farid Rizky Fauzan\nNIM: 124140210\nKelas: RA',
        });
      });
      const steps = await within(chat).findByTestId('chat-steps');
      expect(steps).toHaveTextContent(/Saved for the cover/i);
    });

    it('surfaces the server reason when the export is blocked', async () => {
      installFetchMock(
        baseRoutes({
          [`POST /api/projects/${projectId}/exports`]: () => ({
            status: 409,
            json: { error: { code: 'CONFLICT', message: 'These required sections are still empty: Introduction.' } },
          }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'export as pdf');
      await user.click(within(chat).getByTestId('chat-send'));

      const steps = await within(chat).findByTestId('chat-steps');
      // The reason names the section, which is what the user needs to act on.
      await waitFor(() => expect(steps).toHaveTextContent(/still empty: Introduction/i), { timeout: 6000 });
    });

    it('saves an unmatched instruction on the project rather than chatting vaguely', async () => {
      const { calls } = installFetchMock(baseRoutes());
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(within(chat).getByTestId('chat-input'), 'use a more formal academic tone');
      await user.click(within(chat).getByTestId('chat-send'));

      await waitFor(() => {
        const patch = calls.find((call) => call.method === 'PATCH' && call.path === `/api/projects/${projectId}`);
        expect(patch?.body).toEqual({ instructions: 'use a more formal academic tone' });
      });
      const steps = await within(chat).findByTestId('chat-steps');
      expect(steps).toHaveTextContent(/Instruction saved/i);
    });

    it('opens the sources drawer from the chat header', async () => {
      installFetchMock(baseRoutes());
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      await user.click(screen.getByTestId('chat-open-sources'));
      expect(await screen.findByText('notes.txt')).toBeInTheDocument();
      // Escape closes it, like any dialog.
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByText('notes.txt')).not.toBeInTheDocument());
    });

    /**
     * The reported bug, end to end: the user sent
     *   "buatkan laporan dari template ... dan dokumentasi/source bisa dari sumber zip ..."
     * and nothing at all came back. The reply bubble must always resolve â€” a silent
     * chat is indistinguishable from a crash.
     */
    it('answers a report request that cannot run instead of staying silent', async () => {
      installFetchMock(
        baseRoutes({
          // No template document, so there is no outline to draft into.
          [`GET /api/projects/${projectId}/documents`]: () => ({ json: { documents: [] } }),
          [`GET /api/projects/${projectId}/sections`]: () => ({ json: { sections: [] } }),
        }),
      );
      renderWorkspace();
      await screen.findByRole('heading', { name: 'Q3 Report' });

      const chat = await screen.findByTestId('chat-panel');
      await user.type(
        within(chat).getByTestId('chat-input'),
        'buatkan laporan dari template yang di berikan dan dokumentasi/source bisa dari sumber zip yang saya berikan',
      );
      await user.click(within(chat).getByTestId('chat-send'));

      // It understood the request as drafting, not as an instruction to save.
      const steps = await within(chat).findByTestId('chat-steps');
      expect(steps).toHaveTextContent(/understood as: drafting every section/i);
      // And it says why it stopped, naming the missing template.
      expect(steps).toHaveTextContent(/blocked: no template/i);
      const reply = await within(chat).findByTestId('chat-message-assistant');
      expect(reply).toHaveTextContent(/template first/i);
    });
  });
});
