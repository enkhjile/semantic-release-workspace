import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';

const execute = promisify(execFile);
const journalRef = 'refs/notes/semantic-release-workspace';

export interface Journal {
  schemaVersion: 1;
  branch: string;
  status: 'pending' | 'complete';
  head: string;
  baseHead: string | null;
  batchTag: string;
}

export interface Snapshot {
  anchor: string;
  head: string;
  journal: Journal | undefined;
}

export async function git(
  context: VerifyConditionsContext,
  ...args: string[]
): Promise<string> {
  try {
    const { stdout } = await execute('git', args, {
      cwd: context.cwd,
      env: context.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    // Git errors may include an authenticated remote URL; do not expose it.
    throw new SemanticReleaseError(
      `Workspace Git operation failed: ${args[0]}.`,
      'EWORKSPACEGIT',
      'Check repository access, full history, and serialized release execution.',
    );
  }
}

function parseJournal(raw: string): Journal {
  try {
    const value: unknown = JSON.parse(raw);
    const oid = (input: unknown): input is string =>
      typeof input === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input);
    if (
      typeof value === 'object' &&
      value !== null &&
      'schemaVersion' in value &&
      value.schemaVersion === 1 &&
      'branch' in value &&
      typeof value.branch === 'string' &&
      'status' in value &&
      (value.status === 'pending' || value.status === 'complete') &&
      'head' in value &&
      oid(value.head) &&
      'baseHead' in value &&
      (value.baseHead === null || oid(value.baseHead)) &&
      'batchTag' in value &&
      typeof value.batchTag === 'string' &&
      /^workspace-v\d+\.\d+\.\d+$/.test(value.batchTag)
    )
      return value as Journal;
  } catch {
    // Invalid state is an error, never a reason to release the entire history.
  }
  throw new SemanticReleaseError(
    'Invalid workspace release journal.',
    'EWORKSPACEJOURNAL',
  );
}

export async function snapshot(
  context: VerifyConditionsContext,
): Promise<Snapshot> {
  const repositoryUrl = context.options.repositoryUrl;
  if (!repositoryUrl)
    throw new SemanticReleaseError(
      'A repository URL is required.',
      'EWORKSPACECONFIG',
    );
  const head = await git(context, 'rev-parse', 'HEAD');
  const anchor = await git(context, 'rev-list', '--max-parents=0', head);
  if (anchor.includes('\n')) {
    throw new SemanticReleaseError(
      'Multiple unrelated Git roots are unsupported.',
      'EWORKSPACEHISTORY',
    );
  }
  const remoteRef = await git(
    context,
    'ls-remote',
    '--refs',
    '--',
    repositoryUrl,
    journalRef,
  );
  if (!remoteRef) {
    if (await git(context, 'tag', '--merged', head, '--list', 'workspace-v*')) {
      throw new SemanticReleaseError(
        'Workspace batch tags exist but their completion journal is missing.',
        'EWORKSPACEJOURNAL',
        'Restore the journal before releasing; batch tags alone do not prove completion.',
      );
    }
    return { anchor, head, journal: undefined };
  }
  await git(
    context,
    'fetch',
    '--no-tags',
    '--',
    repositoryUrl,
    `+${journalRef}:${journalRef}`,
  );
  const journal = parseJournal(
    await git(context, 'notes', `--ref=${journalRef}`, 'show', anchor),
  );
  if (journal.branch !== context.branch.name) {
    throw new SemanticReleaseError(
      'The journal belongs to a different release branch.',
      'EWORKSPACECONFIG',
    );
  }
  if (journal.status === 'pending' && journal.head !== head) {
    throw new SemanticReleaseError(
      `Workspace batch at ${journal.head} is unfinished.`,
      'EWORKSPACEPENDING',
      `Rerun the release at ${journal.head} before releasing newer work.`,
    );
  }
  const tagged = await git(context, 'tag', '--list', journal.batchTag);
  if (
    (journal.status === 'complete' && !tagged) ||
    (tagged &&
      (await git(
        context,
        'rev-parse',
        `refs/tags/${journal.batchTag}^{commit}`,
      )) !== journal.head)
  ) {
    throw new SemanticReleaseError(
      'Workspace journal does not match its batch tag.',
      'EWORKSPACEJOURNAL',
    );
  }
  await git(context, 'merge-base', '--is-ancestor', journal.head, head);
  if (journal.baseHead)
    await git(
      context,
      'merge-base',
      '--is-ancestor',
      journal.baseHead,
      journal.head,
    );
  return { anchor, head, journal };
}

export function baseline(current: Snapshot): string | null {
  return current.journal?.status === 'pending'
    ? current.journal.baseHead
    : (current.journal?.head ?? null);
}

export async function commitsSinceCompletion(context: VerifyConditionsContext) {
  const current = await snapshot(context);
  const baseHead = baseline(current);
  const output = await git(
    context,
    'log',
    '-z',
    '--format=%H%x00%B',
    baseHead ? `${baseHead}..${current.head}` : current.head,
    '--',
  );
  const fields = output.split('\0');
  const commits: { hash: string; message: string }[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const hash = fields[index];
    const message = fields[index + 1]?.trim();
    if (
      hash &&
      message &&
      !/\[skip\s+release\]|\[release\s+skip\]/i.test(message)
    ) {
      commits.push({ hash, message });
    }
  }
  return { current, commits };
}

export async function writeJournal(
  context: VerifyConditionsContext,
  current: Snapshot,
  status: Journal['status'],
  batchTag: string,
): Promise<void> {
  const journal: Journal = {
    schemaVersion: 1,
    branch: context.branch.name,
    status,
    head: current.head,
    baseHead: baseline(current),
    batchTag,
  };
  await git(
    context,
    'notes',
    `--ref=${journalRef}`,
    'add',
    '-f',
    '-m',
    JSON.stringify(journal),
    current.anchor,
  );
  // Normal push rejects a conflicting journal update. CI must serialize releases.
  await git(
    context,
    'push',
    '--',
    context.options.repositoryUrl ?? '',
    `${journalRef}:${journalRef}`,
  );
}
