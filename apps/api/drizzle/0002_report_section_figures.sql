-- Source figures attached to a report section.
--
-- A diagram or a CLI screenshot is evidence prose cannot reproduce, and OCR reads
-- its labels imperfectly, so the image itself is carried into the exported DOCX.
-- Each entry is { documentId, caption? } and is resolved to stored bytes at export.
ALTER TABLE "report_sections" ADD COLUMN IF NOT EXISTS "figures" jsonb DEFAULT '[]'::jsonb NOT NULL;
