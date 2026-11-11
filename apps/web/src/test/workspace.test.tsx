import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider } from '../lib/session';
import { ToastProvider } from '../lib/toast';
import { ProjectWorkspacePage } from '../pages/ProjectWorkspacePage';
import { installFetchMock } from '../test/fetchMock';

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
  it('renders the template outline, sources and the selected section content', async () => {
    installFetchMock(baseRoutes());
    renderWorkspace();

    expect(await screen.findByRole('heading', { name: 'Q3 Report' })).toBeInTheDocument();
    // Sources pane lists both documents.
    expect(await screen.findByText('template.docx')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    // Outline entry exists.
    expect(screen.getByRole('button', { name: /Introduction/ })).toBeInTheDocument();
    // Editor shows the draft content in a textarea.
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

    const editor = (await screen.findByLabelText('Section content')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('The quarter was productive.'));

    await userEvent.clear(editor);
    await userEvent.type(editor, 'Edited body.');
    // The explicit Save button triggers the request immediately.
    const editorPane = screen.getByLabelText('Section editor');
    await userEvent.click(within(editorPane).getByRole('button', { name: 'Save' }));

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

    await userEvent.click(screen.getByRole('tab', { name: 'Export' }));
    const pdfButton = await screen.findByRole('button', { name: 'Export PDF' });
    await waitFor(() => expect(pdfButton).toBeDisabled());
    // DOCX export remains available because content exists.
    expect(screen.getByRole('button', { name: 'Export editable DOCX' })).toBeEnabled();
  });
});
