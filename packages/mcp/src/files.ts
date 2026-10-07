import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { LocalError } from './errors.js';

/*
 * The filesystem boundary (ADR-0026). The MCP server runs on the user's
 * machine with their permissions, so an agent must not be able to read or
 * write arbitrary files through it. Every path is confined to
 * AUVRYN_MCP_FILE_ROOT:
 *
 * - relative paths resolve inside the root; absolute paths must already be in it;
 * - `..` escapes are refused after normalization;
 * - symlinks are resolved (realpath) and the real target must stay in the root;
 * - downloads never replace an existing file unless `overwrite` is set, and
 *   never write through a symlink.
 *
 * Without AUVRYN_MCP_FILE_ROOT there is no file access at all.
 */

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function requireRoot(fileRoot: string | undefined): string {
  if (fileRoot === undefined) {
    throw new LocalError(
      'FILE_ACCESS_DISABLED',
      'Local file access is disabled. A person must set AUVRYN_MCP_FILE_ROOT to a directory the server may use.',
    );
  }
  return fileRoot;
}

async function realRoot(fileRoot: string): Promise<string> {
  try {
    return await realpath(fileRoot);
  } catch {
    throw new LocalError(
      'FILE_ROOT_UNAVAILABLE',
      'AUVRYN_MCP_FILE_ROOT does not exist or cannot be read.',
    );
  }
}

const outside = () =>
  new LocalError(
    'PATH_OUTSIDE_FILE_ROOT',
    'The path is outside the allowed file root (AUVRYN_MCP_FILE_ROOT).',
  );

/** A regular file inside the root, for reading (model uploads). */
export async function resolveReadableFile(
  fileRoot: string | undefined,
  path: string,
): Promise<string> {
  const root = await realRoot(requireRoot(fileRoot));
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) {
    throw outside();
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new LocalError('FILE_NOT_FOUND', 'No file at that path inside the file root.');
  }
  // A symlink (or junction) pointing outside the root is an escape.
  if (!inside(root, real)) {
    throw outside();
  }
  if (!(await stat(real)).isFile()) {
    throw new LocalError('NOT_A_FILE', 'The path is not a regular file.');
  }
  return real;
}

/** A path inside the root to write a new file to (artifact downloads). */
export async function resolveWritableFile(
  fileRoot: string | undefined,
  path: string,
  overwrite: boolean,
): Promise<string> {
  const root = await realRoot(requireRoot(fileRoot));
  const candidate = resolve(root, path);
  if (!inside(root, candidate) || candidate === root) {
    throw outside();
  }
  let parent: string;
  try {
    parent = await realpath(dirname(candidate));
  } catch {
    throw new LocalError(
      'DIRECTORY_NOT_FOUND',
      'The destination directory does not exist inside the file root.',
    );
  }
  if (!inside(root, parent)) {
    throw outside();
  }
  const target = resolve(parent, candidate.slice(dirname(candidate).length + 1));
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new LocalError(
      'PATH_IS_SYMLINK',
      'The destination is a symbolic link; refusing to write through it.',
    );
  }
  if (existing && !existing.isFile()) {
    throw new LocalError('NOT_A_FILE', 'The destination exists and is not a regular file.');
  }
  if (existing && !overwrite) {
    throw new LocalError(
      'FILE_EXISTS',
      'The destination file already exists; pass overwrite: true to replace it.',
    );
  }
  return target;
}
