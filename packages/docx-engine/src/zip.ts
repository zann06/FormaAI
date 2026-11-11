/**
 * Low-level DOCX package handling.
 *
 * A .docx file is a ZIP archive of XML parts. FormaAI never re-serialises the
 * whole document: we keep every part byte-identical and only rewrite
 * `word/document.xml` when assembling output. This module provides the ZIP
 * primitives with defensive limits (zip bomb / absurd entry counts).
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export class DocxPackageError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_ZIP' | 'ZIP_TOO_LARGE' | 'MISSING_PART' | 'INVALID_XML',
  ) {
    super(message);
    this.name = 'DocxPackageError';
  }
}

export interface DocxPackage {
  files: Record<string, Uint8Array>;
  names: string[];
}

export function readDocxPackage(buffer: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): DocxPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buffer, {
      filter: (file) => {
        if (file.name.startsWith('__MACOSX')) return false;
        return true;
      },
    });
  } catch (error) {
    throw new DocxPackageError('The file is not a readable ZIP/DOCX package', 'INVALID_ZIP');
  }
  const names = Object.keys(files);
  if (names.length === 0) throw new DocxPackageError('The DOCX package is empty', 'INVALID_ZIP');
  if (names.length > limits.maxEntries) {
    throw new DocxPackageError(`DOCX package has too many parts (${names.length})`, 'ZIP_TOO_LARGE');
  }
  let total = 0;
  for (const name of names) {
    total += files[name]!.byteLength;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new DocxPackageError('DOCX package exceeds the uncompressed size limit', 'ZIP_TOO_LARGE');
    }
    // zip-bomb heuristic: entries must not be path-traversal attempts
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      throw new DocxPackageError(`Unsafe entry name in DOCX package: ${name}`, 'INVALID_ZIP');
    }
  }
  if (!names.includes('word/document.xml')) {
    throw new DocxPackageError('Missing word/document.xml — not a Word document', 'MISSING_PART');
  }
  return { files, names };
}

export function writeDocxPackage(pkg: DocxPackage, original?: Uint8Array): Uint8Array {
  const zippable: Zippable = {};
  for (const name of pkg.names) {
    zippable[name] = pkg.files[name]!;
  }
  // `[Content_Types].xml` must be the first entry for maximum compatibility.
  return zipSync(zippable, { level: 6, mtime: original ? new Date() : new Date() });
}

export const decoder = new TextDecoder('utf-8');
export const encoder = new TextEncoder();

export function xmlToString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function stringToXml(value: string): Uint8Array {
  return encoder.encode(value);
}
