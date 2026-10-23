import { matchesGlob, posix } from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import { type GitContext, gitOutput } from './journal.js';
import type { Commit } from './plan-types.js';
import type { WorkspacePackage } from './workspace-types.js';

export function packageId(pkg: WorkspacePackage): string {
  return `${pkg.ecosystem}:${pkg.name}`;
}
export function sharedPatterns(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        !/^(?:!|\/|[a-z]:)/i.test(item) &&
        !item.includes('\\') &&
        !item.split('/').includes('..'),
    )
  ) {
    throw new SemanticReleaseError(
      'sharedFiles must contain repository-relative glob patterns.',
      'EWORKSPACECONFIG',
    );
  }
  return value.map((pattern) => posix.normalize(pattern));
}
export async function attributeCommits(
  context: GitContext,
  packages: WorkspacePackage[],
  commits: Commit[],
  sharedFiles: string[],
) {
  const attributed = new Map(
    packages.map((pkg) => [packageId(pkg), [] as Commit[]]),
  );
  for (const commit of commits) {
    // No rename detection yields both source deletions and destination additions.
    // Select merge diff behavior explicitly; -m also compares other parents.
    const output = await gitOutput(
      context,
      'diff-tree',
      '--root',
      '--diff-merges=first-parent',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      commit.hash,
      '--',
    );
    const owners = new Set<string>();
    for (const path of output.split('\0').filter(Boolean)) {
      if (sharedFiles.some((pattern) => matchesGlob(path, pattern))) {
        for (const pkg of packages) owners.add(packageId(pkg));
        continue;
      }
      const candidates = packages.filter(
        (pkg) => pkg.path === '.' || path.startsWith(`${pkg.path}/`),
      );
      const depth = Math.max(
        -1,
        ...candidates.map((pkg) =>
          pkg.path === '.' ? 0 : pkg.path.split('/').length,
        ),
      );
      for (const pkg of candidates) {
        if ((pkg.path === '.' ? 0 : pkg.path.split('/').length) === depth)
          owners.add(packageId(pkg));
      }
    }
    for (const id of owners) attributed.get(id)?.push(commit);
  }
  return attributed;
}
