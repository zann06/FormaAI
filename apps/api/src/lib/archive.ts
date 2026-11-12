/**
 * Server-side expansion of uploaded ZIP archives.
 *
 * A student often receives a whole case packet as one `.zip`. Rather than
 * rejecting it, we unpack it and turn every supported file inside into its own
 * source document. Everything else is reported back so the user knows what was
 * skipped and why — silence would look like the archive was empty.
 *
 * Safety: entries are read with streaming inflation and are aborted once the
 * configured limits are crossed, so a small archive cannot expand into
 * gigabytes (zip bomb) or bury the queue in thousands of jobs.
 */
import { Unzip, UnzipInflate } from 'fflate';
import {
  ARCHIVE_LIMITS,
  SOURCE_EXTENSIONS,
  TEMPLATE_EXTENSIONS,
  extensionOf,
  isArchiveSourceExtension,
} from '@formaai/shared';
import { badRequest } from './errors.js';

export interface ArchiveEntry {
  /** File name inside the archive, without the directory part. */
  name: string;
  /** Full path inside the archive (reported back to the user). */
  path: string;
  bytes: Uint8Array;
}

export interface ArchiveExpansion {
  entries: ArchiveEntry[];
  /** Files we recognised but deliberately skipped, with a reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Directories, macOS resource forks and hidden metadata we never want. */
function shouldIgnore(path: string): boolean {
  if (path.endsWith('/')) return true;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '__MACOSX')) return true;
  const base = segments[segments.length - 1] ?? '';
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true;
  if (base.startsWith('._')) return true;
  return false;
}

/**
 * Reads every regular file in the archive, enforcing the size limits.
 * Entries that are not supported sources are collected in `skipped`.
 */
export async function expandArchive(
  bytes: Uint8Array,
  options: { maxEntries?: number; maxExpansionRatio?: number; maxEntryBytes?: number } = {},
): Promise<ArchiveExpansion> {
  const maxEntries = options.maxEntries ?? ARCHIVE_LIMITS.maxEntries;
  const maxEntryBytes = options.maxEntryBytes ?? ARCHIVE_LIMITS.maxEntryBytes;
  // Ratio guard against zip bombs, with a floor so that legitimately small
  // archives (a few text files in a 2 KB zip) are not rejected for ratio alone.
  const ratio = options.maxExpansionRatio ?? ARCHIVE_LIMITS.maxExpansionRatio;
  const maxTotalBytes = Math.max(bytes.byteLength * ratio, 1024 * 1024);

  const accepted: ArchiveEntry[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;
  let seenFiles = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const unzipper = new Unzip((file) => {
      if (settled) return;
      const entryPath = file.name;
      if (shouldIgnore(entryPath)) return;

      seenFiles += 1;
      if (accepted.length >= maxEntries) {
        skipped.push({ path: entryPath, reason: `archive contains more than ${maxEntries} files` });
        return;
      }

      const extension = extensionOf(entryPath);
      const supported =
        (SOURCE_EXTENSIONS as readonly string[]).includes(extension) &&
        !isArchiveSourceExtension(extension);
      if (!supported) {
        skipped.push({
          path: entryPath,
          reason: `${extension || 'unknown'} files cannot be used as evidence`,
        });
        return;
      }

      const chunks: Uint8Array[] = [];
      let entryBytes = 0;

      file.ondata = (error, chunk, final) => {
        if (error) {
          fail(new Error(`Could not read "${entryPath}" from the archive: ${error.message}`));
          return;
        }
        entryBytes += chunk.byteLength;
        totalBytes += chunk.byteLength;
        if (entryBytes > maxEntryBytes) {
          fail(
            new Error(
              `"${entryPath}" is larger than the ${Math.round(maxEntryBytes / (1024 * 1024))} MB per-file limit.`,
            ),
          );
          return;
        }
        if (totalBytes > maxTotalBytes) {
          fail(
            new Error(
              'This archive expands to far more data than it should (possible zip bomb), so it was rejected.',
            ),
          );
          return;
        }
        chunks.push(chunk);
        if (final) {
          const merged = new Uint8Array(entryBytes);
          let offset = 0;
          for (const part of chunks) {
            merged.set(part, offset);
            offset += part.byteLength;
          }
          const segments = entryPath.split('/');
          accepted.push({
            name: segments[segments.length - 1] ?? entryPath,
            path: entryPath,
            bytes: merged,
          });
        }
      };
      file.start();
    });

    unzipper.register(UnzipInflate);
    try {
      // Push the whole archive; entries are delivered through the callback.
      unzipper.push(bytes, true);
    } catch (error) {
      fail(
        badRequest(
          `The ZIP archive could not be read: ${(error as Error).message}. ` +
            'Try re-creating the archive or upload the files individually.',
        ),
      );
      return;
    }
    // fflate delivers synchronously for in-memory input, but give pending
    // entry handlers a tick to finish before resolving.
    setTimeout(finish, 0);
  });

  if (seenFiles === 0) {
    throw badRequest('The ZIP archive is empty or contains no files.');
  }
  if (accepted.length === 0) {
    const reasons = skipped
      .slice(0, 5)
      .map((entry) => `${entry.path} (${entry.reason})`)
      .join(', ');
    throw badRequest(
      `No usable files were found in the ZIP archive. Supported: ${SOURCE_EXTENSIONS.filter(
        (extension) => !isArchiveSourceExtension(extension),
      ).join(', ')}.` + (reasons ? ` Found: ${reasons}.` : ''),
    );
  }

  return { entries: accepted, skipped };
}

/** True when the archive contains exactly one .docx — a likely template bundle. */
export function looksLikeTemplateArchive(expansion: ArchiveExpansion): boolean {
  if (expansion.entries.length !== 1) return false;
  const [entry] = expansion.entries;
  return Boolean(entry && (TEMPLATE_EXTENSIONS as readonly string[]).includes(extensionOf(entry.path)));
}
