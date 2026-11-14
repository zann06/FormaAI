import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AboutPage } from '../pages/AboutPage';
import { installFetchMock } from '../test/fetchMock';

/**
 * The About page exists to tell an operator what *this* instance can do, so the
 * tests focus on the one thing that could quietly become a lie: the capabilities
 * must come from `/api/health` and must render as unavailable when the API says
 * the feature is off. A hard-coded "PDF export ✓" would be worse than no page.
 */
function renderAbout() {
  return render(
    <MemoryRouter>
      <AboutPage />
    </MemoryRouter>,
  );
}

const health = (overrides: Partial<Record<'pdfConversion' | 'ocr' | 'devProvider' | 'registration', boolean>> = {}) => ({
  status: 'ok',
  time: new Date().toISOString(),
  features: {
    pdfConversion: true,
    ocr: true,
    devProvider: false,
    registration: true,
    ...overrides,
  },
});

describe('AboutPage', () => {
  // Each case renders a different capability set into the same document, so the
  // DOM from one test would otherwise answer another test's queries.
  afterEach(() => cleanup());

  it('shows the version, licence and the capabilities reported by the API', async () => {
    installFetchMock({
      'GET /api/health': () => ({ json: health() }),
    });

    renderAbout();

    expect(screen.getByRole('heading', { name: 'About FormaAI' })).toBeTruthy();
    expect(await screen.findByText('Version 0.1.0 · licensed AGPL-3.0-or-later')).toBeTruthy();
    expect(await screen.findByText('Documents are converted to PDF with LibreOffice.')).toBeTruthy();
    expect(await screen.findByText('Scanned PDFs and images are read with Tesseract.')).toBeTruthy();
  });

  it('reports a capability as unavailable when the instance has it switched off', async () => {
    installFetchMock({
      'GET /api/health': () => ({ json: health({ pdfConversion: false, ocr: false }) }),
    });

    renderAbout();

    // The two switched-off capabilities say "Off"; the two enabled ones do not.
    expect(await screen.findByText('No converter is configured, so exports are DOCX only.')).toBeTruthy();
    expect(
      await screen.findByText('Only text-bearing documents can be read; scanned pages are skipped.'),
    ).toBeTruthy();
    expect(screen.queryByText('Documents are converted to PDF with LibreOffice.')).toBeNull();
    expect(screen.queryByText('Scanned PDFs and images are read with Tesseract.')).toBeNull();
    expect(screen.getByText('New accounts can register from the sign-in page.')).toBeTruthy();
  });

  it('surfaces a health-check failure instead of silently showing stale capabilities', async () => {
    installFetchMock({
      'GET /api/health': () => ({ status: 500, json: { error: { code: 'BOOM', message: 'boom' } } }),
    });

    renderAbout();

    // The page must not claim any capability when it could not read them, and it
    // must offer a retry rather than an empty section that looks merely "off".
    await waitFor(() => expect(screen.queryByText('Documents are converted to PDF with LibreOffice.')).toBeNull());
    expect(screen.queryAllByText('Available')).toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
