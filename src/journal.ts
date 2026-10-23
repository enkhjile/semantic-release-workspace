import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import { valid } from 'semver';
import { branchType } from './branches.js';
import type { PlanningState } from './plan-types.js';
import { oid, validPlanning } from './plan-validation.js';
import { type Execution, validExecution } from './publication-state.js';

const execute = promisify(execFile);
const legacyRef = 'refs/notes/semantic-release-workspace';

export interface Journal {
  schemaVersion: 1 | 2 | 3;
  branch: string;
  status: 'pending' | 'complete';
  head: string;
  baseHead: string | null;
  batchTag: string;
  planning?: PlanningState;
  execution?: Execution;
}

export function journalRef(context: VerifyConditionsContext): string {
  return branchType(context) === 'release' &&
    'main' in context.branch &&
    context.branch.main
    ? legacyRef
    : `refs/notes/workspace-release-branches/${createHash('sha256').update(context.branch.name).digest('hex')}`;
}
export interface Snapshot {
  history: Journal[];
  reservations: Journal[];
  anchor: string;
  head: string;
  journal: Journal | undefined;
}

export interface GitContext {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function git(
  context: GitContext,
  ...args: string[]
): Promise<string> {
  return (await gitOutput(context, ...args)).trim();
}

export async function gitOutput(
  context: GitContext,
  ...args: string[]
): Promise<string> {
  return executeGit(context, args);
}

export async function executeGit(
  context: GitContext,
  args: string[],
  input?: string,
): Promise<string> {
  try {
    const pending = execute('git', args, {
      cwd: context.cwd,
      env: context.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (input !== undefined) pending.child.stdin?.end(input);
    const { stdout } = await pending;
    return stdout;
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
    if (
      typeof value === 'object' &&
      value !== null &&
      'schemaVersion' in value &&
      (value.schemaVersion === 1 ||
        ((value.schemaVersion === 2 || value.schemaVersion === 3) &&
          'planning' in value &&
          validPlanning(value.planning) &&
          (value.schemaVersion !== 3 ||
            ('execution' in value && validExecution(value.execution))))) &&
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
      value.batchTag.startsWith('workspace-v') &&
      valid(value.batchTag.slice(11)) !== null
    ) {
      const result = value as Journal;
      if (
        result.schemaVersion !== 1 &&
        (result.planning?.plan.head !== result.head ||
          result.planning?.plan.baseHead !== result.baseHead)
      )
        throw new Error('Mismatched plan');
      if (result.status === 'complete' && result.planning) {
        for (const pkg of result.planning.plan.packages) {
          const completed = result.planning.versions.find(
            (entry) => entry.id === pkg.id,
          );
          const expected = pkg.nextVersion ?? pkg.currentVersion;
          if (
            (completed && completed.version !== expected) ||
            (pkg.nextVersion && (!completed || completed.head !== result.head))
          )
            throw new Error('Mismatched completed package version');
        }
      }
      if (result.schemaVersion !== 3 && result.execution !== undefined)
        throw new Error('Unexpected execution payload');
      if (result.execution && result.planning) {
        const ids = result.planning.plan.packages
          .filter((pkg) => pkg.nextVersion && !pkg.private)
          .map((pkg) => pkg.id)
          .sort();
        if (
          JSON.stringify(ids) !==
            JSON.stringify(
              result.execution.packages.map((pkg) => pkg.id).sort(),
            ) ||
          (result.status === 'complete' &&
            result.execution.packages.some((pkg) => !pkg.tagged))
        )
          throw new Error('Incomplete execution');
      }
      if (result.schemaVersion === 1 && result.planning !== undefined)
        throw new Error('Unexpected planning payload');
      if (result.status === 'complete' && result.planning) {
        const updates = new Map(
          result.planning.plan.packages.flatMap((pkg) =>
            pkg.dependencyUpdates.map(
              (entry) =>
                [
                  JSON.stringify([entry.manifestPath, entry.field]),
                  entry,
                ] as const,
            ),
          ),
        );
        if (
          updates.size !== result.planning.dependencyRanges.length ||
          result.planning.dependencyRanges.some(
            (entry) =>
              JSON.stringify(
                updates.get(JSON.stringify([entry.manifestPath, entry.field])),
              ) !== JSON.stringify(entry),
          )
        )
          throw new Error('Mismatched dependency projection');
      }
      return result;
    }
  } catch {
    // Invalid state is an error, never a reason to release the entire history.
  }
  throw new SemanticReleaseError(
    'Invalid workspace release journal.',
    'EWORKSPACEJOURNAL',
  );
}

const noteCache = new Map<
  string,
  { tip: string; notes: { object: string; entry: Journal }[] }
>();
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
  const ref = journalRef(context);
  const advertised = await git(
    context,
    'ls-remote',
    '--refs',
    '--',
    repositoryUrl,
    legacyRef,
    'refs/notes/workspace-release-*',
  );
  const remoteRefs = advertised
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1] as string)
    .filter(
      (name) =>
        name === legacyRef ||
        name.startsWith('refs/notes/workspace-release-branches/') ||
        name.startsWith('refs/notes/workspace-release-history/'),
    );
  const history: Journal[] = [];
  const reservations: Journal[] = [];
  let journal: Journal | undefined;
  for (const remote of remoteRefs) {
    const tip =
      advertised
        .split('\n')
        .find((line) => line.endsWith(`\t${remote}`))
        ?.split('\t')[0] ?? '';
    const cacheKey = JSON.stringify([context.cwd, repositoryUrl, remote]);
    let cached = noteCache.get(cacheKey);
    if (!cached || cached.tip !== tip) {
      await git(
        context,
        'fetch',
        '--no-tags',
        '--',
        repositoryUrl,
        `+${remote}:${remote}`,
      );
      const notes = (await git(context, 'notes', `--ref=${remote}`, 'list'))
        .split('\n')
        .filter(Boolean);
      const parsed = [];
      for (const note of notes) {
        const object = note.split(' ')[1] as string;
        parsed.push({
          object,
          entry: parseJournal(
            await git(context, 'notes', `--ref=${remote}`, 'show', object),
          ),
        });
      }
      cached = { tip, notes: parsed };
      noteCache.set(cacheKey, cached);
    }
    for (const { object, entry } of cached.notes) {
      if (entry.status === 'pending') {
        if (
          entry.branch === context.branch.name &&
          object === anchor &&
          remote !== ref
        )
          throw new SemanticReleaseError(
            'The pending branch role changed. Restore its branch configuration before retrying.',
            'EWORKSPACEPLAN',
          );
        reservations.push(entry);
      }
      if (
        entry.status === 'complete' &&
        !history.some((old) => old.batchTag === entry.batchTag)
      )
        history.push(entry);
      if (remote === ref && object === anchor) journal = entry;
    }
  }
  if (!journal) {
    if (
      (!remoteRefs.length ||
        history.some((entry) => entry.branch === context.branch.name)) &&
      (await git(context, 'tag', '--merged', head, '--list', 'workspace-v*'))
    )
      throw new SemanticReleaseError(
        'Workspace batch tags exist but their completion journal is missing.',
        'EWORKSPACEJOURNAL',
      );
    return { anchor, head, journal, history, reservations };
  }
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
  return { anchor, head, journal, history, reservations };
}

export function baseline(current: Snapshot): string | null {
  return current.journal?.status === 'pending'
    ? current.journal.baseHead
    : (current.journal?.head ?? null);
}

export async function commitsSinceCompletion(context: VerifyConditionsContext) {
  const current = await snapshot(context);
  return {
    current,
    commits: await readCommits(context, current.head, baseline(current)),
  };
}

export async function readCommits(
  context: GitContext,
  head: string,
  baseHead: string | null = null,
) {
  const output = await git(
    context,
    'log',
    '-z',
    '--format=%H%x00%B',
    baseHead ? `${baseHead}..${head}` : head,
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
  return commits;
}

export async function writeJournal(
  context: VerifyConditionsContext,
  current: Snapshot,
  status: Journal['status'],
  batchTag: string,
  planning?: PlanningState,
  execution?: Execution,
): Promise<void> {
  const journal: Journal = {
    schemaVersion: execution ? 3 : planning ? 2 : 1,
    branch: context.branch.name,
    status,
    head: current.head,
    baseHead: baseline(current),
    batchTag,
  };
  if (execution) journal.execution = execution;
  if (planning) {
    const versions = new Map(
      planning.versions.map((entry) => [entry.id, entry]),
    );
    const ranges = new Map(
      planning.dependencyRanges.map((entry) => [
        JSON.stringify([entry.manifestPath, entry.field]),
        entry,
      ]),
    );
    if (status === 'complete')
      for (const pkg of planning.plan.packages) {
        if (pkg.nextVersion)
          versions.set(pkg.id, {
            id: pkg.id,
            version: pkg.nextVersion,
            head: current.head,
          });
        for (const entry of pkg.dependencyUpdates)
          ranges.set(JSON.stringify([entry.manifestPath, entry.field]), entry);
      }
    journal.planning = {
      ...(planning.releaseNotes ? { releaseNotes: planning.releaseNotes } : {}),
      plan: planning.plan,
      versions: [...versions.values()].sort((a, b) => a.id.localeCompare(b.id)),
      dependencyRanges: [...ranges.values()],
    };
  }
  const ref = journalRef(context);
  if (status === 'complete') {
    const historyRef = `refs/notes/workspace-release-history/${createHash('sha256').update(context.branch.name).digest('hex')}`;
    await executeGit(
      context,
      ['notes', `--ref=${historyRef}`, 'add', '-f', '-F', '-', current.head],
      JSON.stringify(journal),
    );
    await git(
      context,
      'push',
      '--',
      context.options.repositoryUrl ?? '',
      `${historyRef}:${historyRef}`,
    );
  }
  await executeGit(
    context,
    ['notes', `--ref=${ref}`, 'add', '-f', '-F', '-', current.anchor],
    JSON.stringify(journal),
  );
  // Normal push rejects a conflicting journal update. CI must serialize releases.
  await git(
    context,
    'push',
    '--',
    context.options.repositoryUrl ?? '',
    `${ref}:${ref}`,
  );
}
