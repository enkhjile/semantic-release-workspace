import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import { releaseRoute } from './branches.js';
import { type GitContext, git } from './journal.js';
import type { ManifestChange } from './manifests.js';

const execute = promisify(execFile);
export const digest = (bytes: Buffer | string, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
export function releaseError(
  message: string,
  code = 'EWORKSPACEPUBLISH',
): never {
  throw new SemanticReleaseError(message, code);
}
export async function command(
  context: GitContext,
  name: string,
  args: string[],
  input?: Buffer | string,
): Promise<Buffer> {
  try {
    const pending = execute(name, args, {
      cwd: context.cwd,
      env: context.env,
      encoding: 'buffer',
      maxBuffer: 110 * 1024 * 1024,
      timeout: 180_000,
    });
    if (input !== undefined) pending.child.stdin?.end(input);
    return (await pending).stdout;
  } catch {
    return releaseError(
      `Workspace command failed: ${name} ${args[0] ?? ''}. Check tool availability, package validity and registry access. Subprocess output is withheld because it may contain credentials.`,
    );
  }
}
export const refFor = (head: string, id?: string, scope?: string) =>
  `refs/semantic-release-workspace/${id ? `artifacts/${scope ? `${scope}/` : ''}${head}/${digest(id)}` : `prepared/${scope ? `${scope}/` : ''}${head}`}`;
export const releaseScope = (context: VerifyConditionsContext) => {
  const route = releaseRoute(context);
  return route ? digest(JSON.stringify(route)) : undefined;
};
export async function fetchRef(
  context: VerifyConditionsContext,
  ref: string,
): Promise<string | undefined> {
  if (
    !(await git(
      context,
      'ls-remote',
      '--refs',
      '--',
      context.options.repositoryUrl ?? '',
      ref,
    ))
  )
    return undefined;
  await git(
    context,
    'fetch',
    '--no-tags',
    '--',
    context.options.repositoryUrl ?? '',
    `${ref}:${ref}`,
  );
  return git(context, 'rev-parse', ref);
}
export async function pushRef(
  context: VerifyConditionsContext,
  ref: string,
  commit: string,
): Promise<void> {
  const previous = await fetchRef(context, ref);
  if (previous && previous !== commit)
    releaseError(
      'Immutable workspace release ref conflicts with the planned content.',
      'EWORKSPACEARTIFACT',
    );
  if (previous) return;
  await git(context, 'update-ref', ref, commit);
  await git(
    context,
    'push',
    '--',
    context.options.repositoryUrl ?? '',
    `${ref}:${ref}`,
  );
}
async function commitTree(
  context: GitContext,
  tree: string,
  parent: string,
): Promise<string> {
  return (
    await command(
      {
        ...context,
        env: {
          ...context.env,
          GIT_AUTHOR_NAME: 'semantic-release-workspace',
          GIT_AUTHOR_EMAIL: 'release@example.invalid',
          GIT_COMMITTER_NAME: 'semantic-release-workspace',
          GIT_COMMITTER_EMAIL: 'release@example.invalid',
          GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
        },
      },
      'git',
      ['commit-tree', tree, '-p', parent],
      'Workspace release artifacts\n',
    )
  )
    .toString()
    .trim();
}
export async function preparedCommit(
  context: VerifyConditionsContext,
  head: string,
  changes: ManifestChange[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-index-'));
  const staged = {
    ...context,
    env: { ...context.env, GIT_INDEX_FILE: join(directory, 'index') },
  };
  try {
    await git(staged, 'read-tree', head);
    for (const change of changes) {
      const blob = (
        await command(
          context,
          'git',
          ['hash-object', '-w', '--stdin'],
          change.after,
        )
      )
        .toString()
        .trim();
      const row = await git(
        context,
        '--literal-pathspecs',
        'ls-tree',
        head,
        '--',
        change.path,
      );
      const mode = row
        ? row.split(' ')[0]
        : change.before === null
          ? '100644'
          : undefined;
      if (!mode || (mode !== '100644' && mode !== '100755'))
        releaseError(
          'Only regular release files can be prepared.',
          'EWORKSPACEMANIFEST',
        );
      await git(
        staged,
        'update-index',
        '--add',
        '--cacheinfo',
        mode,
        blob,
        change.path,
      );
    }
    const commit = await commitTree(
      context,
      await git(staged, 'write-tree'),
      head,
    );
    await pushRef(
      context,
      refFor(head, undefined, releaseScope(context)),
      commit,
    );
    return commit;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export interface Artifact {
  ref: string;
  commit: string;
  sha256: string;
  integrity: string;
}
export async function retainArtifact(
  context: VerifyConditionsContext,
  head: string,
  id: string,
  prepared: string,
  bytes: Buffer,
  metadata: unknown,
): Promise<Artifact> {
  if (bytes.length > 100 * 1024 * 1024)
    releaseError('Workspace artifacts must be at most 100 MiB.');
  const file = (
    await command(context, 'git', ['hash-object', '-w', '--stdin'], bytes)
  )
    .toString()
    .trim();
  const meta = (
    await command(
      context,
      'git',
      ['hash-object', '-w', '--stdin'],
      JSON.stringify(metadata),
    )
  )
    .toString()
    .trim();
  const tree = (
    await command(
      context,
      'git',
      ['mktree'],
      `100644 blob ${file}\tartifact\n100644 blob ${meta}\tmetadata.json\n`,
    )
  )
    .toString()
    .trim();
  const commit = await commitTree(context, tree, prepared);
  const ref = refFor(head, id, releaseScope(context));
  await pushRef(context, ref, commit);
  return {
    ref,
    commit,
    sha256: digest(bytes),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}
export async function readArtifact(
  context: VerifyConditionsContext,
  artifact: Artifact,
) {
  if ((await fetchRef(context, artifact.ref)) !== artifact.commit)
    releaseError(
      'Retained artifact ref is missing or corrupt.',
      'EWORKSPACEARTIFACT',
    );
  const bytes = await command(context, 'git', [
    'show',
    `${artifact.commit}:artifact`,
  ]);
  if (
    digest(bytes) !== artifact.sha256 ||
    `sha512-${createHash('sha512').update(bytes).digest('base64')}` !==
      artifact.integrity
  )
    releaseError('Retained artifact checksum mismatch.', 'EWORKSPACEARTIFACT');
  const metadata: unknown = JSON.parse(
    (
      await command(context, 'git', [
        'show',
        `${artifact.commit}:metadata.json`,
      ])
    ).toString(),
  );
  return { bytes, metadata };
}

export async function readGitFile(
  context: GitContext,
  revision: string,
  path: string,
): Promise<string | null> {
  const row = await git(
    context,
    '--literal-pathspecs',
    'ls-tree',
    revision,
    '--',
    path,
  );
  if (!row) return null;
  if (!/^100(?:644|755) blob /.test(row))
    releaseError(
      'Release history contains a non-regular file.',
      'EWORKSPACEARTIFACT',
    );
  const bytes = await command(context, 'git', ['show', `${revision}:${path}`]);
  if (!isUtf8(bytes))
    releaseError(
      'Release history must contain valid UTF-8.',
      'EWORKSPACEARTIFACT',
    );
  return bytes.toString('utf8');
}
