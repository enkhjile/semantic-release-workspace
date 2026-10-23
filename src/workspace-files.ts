import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import SemanticReleaseError from '@semantic-release/error';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertInside(root: string, path: string): void {
  const child = relative(root, path);
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    throw new SemanticReleaseError(
      `Workspace path escapes the repository: ${path}`,
      'EWORKSPACEPATH',
    );
  }
}

export async function text(
  root: string,
  path: string,
): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SemanticReleaseError(
      `Cannot resolve workspace file: ${path}`,
      'EWORKSPACEMANIFEST',
    );
  }
  assertInside(root, canonical);
  try {
    return await readFile(canonical, 'utf8');
  } catch {
    throw new SemanticReleaseError(
      `Cannot read workspace file: ${path}`,
      'EWORKSPACEMANIFEST',
    );
  }
}

export async function canonicalDirectory(
  root: string,
  path: string,
): Promise<string> {
  assertInside(root, path);
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory())
      throw new Error('Not a directory');
  } catch {
    throw new SemanticReleaseError(
      `Invalid workspace directory: ${path}`,
      'EWORKSPACEMANIFEST',
    );
  }
  assertInside(root, canonical);
  for (let cursor = path; cursor !== root; cursor = dirname(cursor)) {
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new SemanticReleaseError(
        `Use a canonical workspace directory instead of a symlink: ${path}`,
        'EWORKSPACEPATH',
      );
    }
  }
  return canonical;
}
