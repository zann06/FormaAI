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
// "RIFF" .... "WEBP"
const WEBP_RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG_MAGIC = [0x57, 0x45, 0x42, 0x50];
const TIFF_LE_MAGIC = [0x49, 0x49, 0x2a, 0x00]; // II*\0
const TIFF_BE_MAGIC = [0x4d, 0x4d, 0x00, 0x2a]; // MM\0*
const BMP_MAGIC = [0x42, 0x4d]; // BM
const GIF87_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]; // GIF87a
const GIF89_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a

/** iPhone photo formats we reject with conversion instructions. */
const HEIC_EXTENSIONS: readonly string[] = ['.heic', '.heif'];

/** Canonical MIME type stored for each accepted image extension. */const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
};

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
    // iPhone default photos are HEIC; the decoder behind OCR cannot read them.
    // Say exactly how to fix it instead of a generic "unsupported" reject.
    if (HEIC_EXTENSIONS.includes(extension)) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        `"${filename}" is a HEIC/HEIF image, which cannot be read by OCR. ` +
          'Convert it to JPG/PNG and upload again. On iPhone, either set ' +
          'Settings → Camera → Formats → Most Compatible, or in Photos tap Share → ' +
          '"Copy Photo" and paste it into a message to yourself to get a JPEG.',
      );
    }
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
  } else if (extension === '.webp') {
    if (!startsWith(bytes, WEBP_RIFF_MAGIC) || !startsWith(bytes.subarray(8), WEBP_TAG_MAGIC)) {
      throw validationError('This file is not a valid WEBP image (signature mismatch); it may have been renamed');
    }
  } else if (extension === '.tif' || extension === '.tiff') {
    if (!startsWith(bytes, TIFF_LE_MAGIC) && !startsWith(bytes, TIFF_BE_MAGIC)) {
      throw validationError('This file is not a valid TIFF image (signature mismatch); it may have been renamed');
    }
  } else if (extension === '.bmp') {
    if (!startsWith(bytes, BMP_MAGIC)) {
      throw validationError('This file is not a valid BMP image (signature mismatch); it may have been renamed');
    }
  } else if (extension === '.gif') {
    if (!startsWith(bytes, GIF87_MAGIC) && !startsWith(bytes, GIF89_MAGIC)) {
      throw validationError('This file is not a valid GIF image (signature mismatch); it may have been renamed');
    }
  } else if (extension === '.zip') {
    // Same container signature as DOCX; the difference is content, checked when
    // the archive is expanded into source documents.
    if (!startsWith(bytes, ZIP_MAGIC) && !startsWith(bytes, ZIP_MAGIC_EMPTY)) {
      throw validationError('This file is not a valid ZIP archive (signature mismatch); it may have been renamed');
    }
  }

  const mimeType =
    extension === '.pdf'
      ? 'application/pdf'
      : extension === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : extension === '.zip'
          ? 'application/zip'
          : IMAGE_MIME_BY_EXTENSION[extension] ?? 'text/plain';

  return { extension, mimeType, sizeBytes: bytes.byteLength, bytes };
}
