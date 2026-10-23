import type { VerifyConditionsContext } from 'semantic-release';
import { executeGit, git, type Snapshot } from './journal.js';
import { releaseError } from './release-io.js';
import { record } from './workspace-files.js';

// Core 25 reads channel notes by commit, taking the first JSON note. Keep a
// plugin-owned, lexically earlier note so root journals cannot shadow channels
// and multiple prerelease tags on the same commit retain every channel.
const ref = 'refs/notes/semantic-release-0-workspace';
function channels(raw: string): (string | null)[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      record(value) &&
      Array.isArray(value.channels) &&
      value.channels.every(
        (channel) => channel === null || typeof channel === 'string',
      )
    )
      return value.channels;
  } catch {
    /* Invalid state must not silently drop a channel. */
  }
  return releaseError(
    'Invalid workspace coordinator channel note.',
    'EWORKSPACEJOURNAL',
  );
}
export async function recordChannels(
  context: VerifyConditionsContext,
  head: string,
  channel: string | null = context.branch.channel || null,
): Promise<void> {
  if (context.options.dryRun) return;
  const repository = context.options.repositoryUrl ?? '';
  const remote = await git(
    context,
    'ls-remote',
    '--refs',
    '--',
    repository,
    ref,
  );
  if (remote)
    await git(
      context,
      'fetch',
      '--no-tags',
      '--',
      repository,
      `+${ref}:${ref}`,
    );
  else await git(context, 'update-ref', '-d', ref);
  const notes = remote
    ? (await git(context, 'notes', `--ref=${ref}`, 'list')).split('\n')
    : [];
  const previous = notes.some((note) => note.split(' ')[1] === head)
    ? channels(await git(context, 'notes', `--ref=${ref}`, 'show', head))
    : [];
  const union = new Set<string | null>([...previous, channel]);
  const tags = (
    await git(context, 'tag', '--points-at', head, '--list', 'workspace-v*')
  )
    .split('\n')
    .filter(Boolean);
  const coreRefs = new Set(
    (
      await git(
        context,
        'for-each-ref',
        '--format=%(refname)',
        'refs/notes/semantic-release-workspace-v*',
      )
    ).split('\n'),
  );
  for (const tag of tags) {
    const coreRef = `refs/notes/semantic-release-${tag}`;
    if (!coreRefs.has(coreRef)) continue;
    for (const channel of channels(
      await git(context, 'notes', `--ref=${coreRef}`, 'show', head),
    ))
      union.add(channel);
  }
  if (
    previous.length === union.size &&
    previous.every((channel) => union.has(channel))
  )
    return;
  const combined = [...union].sort((left, right) =>
    (left ?? '').localeCompare(right ?? ''),
  );
  await executeGit(
    context,
    ['notes', `--ref=${ref}`, 'add', '-f', '-F', '-', head],
    JSON.stringify({ channels: combined }),
  );
  await git(context, 'push', '--', repository, `${ref}:${ref}`);
}

// Core has already loaded its tag list before verifyConditions. Repair persisted
// legacy metadata, then stop so a fresh invocation can reload the fixed notes.
export async function repairChannels(
  context: VerifyConditionsContext,
  current: Snapshot,
): Promise<void> {
  if (!('tags' in context.branch) || !Array.isArray(context.branch.tags))
    return;
  const repairs: { head: string; channel: string | null }[] = [];
  for (const tag of context.branch.tags) {
    if (
      !record(tag) ||
      typeof tag.gitTag !== 'string' ||
      !tag.gitTag.startsWith('workspace-v') ||
      Array.isArray(tag.channels)
    )
      continue;
    const owner = [...current.history, ...current.reservations].find(
      (entry) => entry.batchTag === tag.gitTag,
    );
    if (!owner)
      releaseError(
        'Cannot repair coordinator channels without the owning release journal.',
        'EWORKSPACEJOURNAL',
      );
    repairs.push({
      head: owner.head,
      channel: owner.planning?.plan.release?.channel ?? null,
    });
  }
  if (!repairs.length) return;
  if (context.options.dryRun)
    releaseError(
      'Legacy coordinator channel metadata needs repair. Run the release without dry-run, then rerun it to continue the frozen batch.',
      'EWORKSPACECHANNELRETRY',
    );
  for (const { head, channel } of repairs)
    await recordChannels(context, head, channel);
  releaseError(
    'Coordinator channel metadata repaired. Rerun the release to reload it and continue the frozen batch.',
    'EWORKSPACECHANNELRETRY',
  );
}
