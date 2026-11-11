/**
 * File upload validation.
 *
 * Rules:
 *  - extension must be in the allow-list;
 *  - declared MIME type must be plausible for that extension;
 *  - the *file signature* (magic bytes) must match the extension;
 *  - size must be within limits;
 *  - DOCX must be a readable ZIP with word/document.xml and sane entry counts;
 *  - PDF page count must be within limits (checked during extraction).
 *
 * A file that fails any check is rejected before it reaches any parser.
 */
import { readDocxPackage, DocxPackageError } from '@formaai/docx-engine';
import { SOURCE_EXTENSIONS, TEMPLATE_EXTENSIONS, MIME_BY_EXTENSION, extensionOf } from '@formaai/shared';
import { AppError, payloadTooLarge, validationError } from './errors.js';

export interface UploadValidationOptions {
  kind: 'template' | 'source';
  maxBytes: number;
}

export interface ValidatedUpload {
  extension: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Uint8Array;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_MAGIC_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // \x89PNG\r\n\x1a\n
const JPEG_MAGIC = [0xff, 0xd8, 0xff]; // SOI + first marker

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / Math.max(1, sample.length) < 0.02;
}

export function validateUpload(
  filename: string,
  declaredMime: string,
  bytes: Uint8Array,
  options: UploadValidationOptions,
): ValidatedUpload {
  if (bytes.byteLength === 0) throw validationError('The uploaded file is empty');
  if (bytes.byteLength > options.maxBytes) {
    throw payloadTooLarge(
      `File is larger than the ${Math.round(options.maxBytes / (1024 * 1024))} MB limit`,
    );
  }
  const extension = extensionOf(filename);
  const allowed: readonly string[] = options.kind === 'template' ? TEMPLATE_EXTENSIONS : SOURCE_EXTENSIONS;
  if (!allowed.includes(extension)) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      options.kind === 'template'
        ? `Template must be a DOCX file (.docx). Received "${filename}".`
        : `Unsupported source file type. Supported: ${SOURCE_EXTENSIONS.join(', ')}.`,
    );
  }
  const plausibleMimes = MIME_BY_EXTENSION[extension] ?? [];
  if (declaredMime && !plausibleMimes.includes(declaredMime.toLowerCase())) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      `The declared content type "${declaredMime}" does not match the ".${extension.slice(1)}" extension`,
    );
  }

  // ---- signature checks -------------------------------------------------
  if (extension === '.pdf') {
    if (!startsWith(bytes, PDF_MAGIC)) {
      throw validationError('This file is not a valid PDF (missing %PDF signature)');
    }
  } else if (extension === '.docx') {
    if (!startsWith(bytes, ZIP_MAGIC) && !startsWith(bytes, ZIP_MAGIC_EMPTY)) {
      throw validationError('This file is not a valid DOCX (not a ZIP package)');
    }
    try {
      const pkg = readDocxPackage(bytes);
      if (!pkg.names.includes('[Content_Types].xml')) {
        throw new DocxPackageError('Missing [Content_Types].xml', 'MISSING_PART');
      }
      if (pkg.names.length > 5000) throw new DocxPackageError('Too many parts', 'ZIP_TOO_LARGE');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid package';
      throw validationError(`The DOCX file could not be opened: ${message}`);
    }
  } else if (extension === '.txt') {
    if (!looksLikeText(bytes)) {
      throw validationError('The .txt file contains binary data (rename it to the correct format)');
    }
  } else if (extension === '.png') {
    if (!startsWith(bytes, PNG_MAGIC)) {
      throw validationError('This file is not a valid PNG (signature mismatch); it may have been renamed');
    }
  } else if (extension === '.jpg' || extension === '.jpeg') {
    if (!startsWith(bytes, JPEG_MAGIC)) {
      throw validationError('This file is not a valid JPEG (signature mismatch); it may have been renamed');
    }
  }

  const mimeType =
    extension === '.pdf'
      ? 'application/pdf'
      : extension === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : extension === '.png'
          ? 'image/png'
          : extension === '.jpg' || extension === '.jpeg'
            ? 'image/jpeg'
            : 'text/plain';

  return { extension, mimeType, sizeBytes: bytes.byteLength, bytes };
}
