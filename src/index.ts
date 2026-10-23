import { realpath } from 'node:fs/promises';
import { analyzeCommits as analyzeConventionalCommits } from '@semantic-release/commit-analyzer';
import SemanticReleaseError from '@semantic-release/error';
import type {
  AnalyzeCommitsContext,
  FailContext,
  GenerateNotesContext,
  PrepareContext,
  PublishContext,
  SuccessContext,
  VerifyConditionsContext,
  VerifyReleaseContext,
} from 'semantic-release';
import {
  assertPendingBranches,
  branchType,
  coordinatorType,
  npmChannel,
} from './branches.js';
import { recordChannels, repairChannels } from './channel-notes.js';
import { planPromotion, promotionSource, recoverChannels } from './channels.js';
import { discoverWorkspaces } from './discovery.js';
import {
  commitsSinceCompletion,
  git,
  snapshot,
  writeJournal,
} from './journal.js';
import { createVersionPlan } from './planning.js';
import {
  preflight,
  preparePublication,
  publishing,
  publishPackages,
  recoverManifests,
} from './publication.js';
import {
  changelogEnabled,
  checkNotesPolicy,
  formatReleaseNotes,
  notesForRelease,
} from './release-notes.js';

type PluginConfig = Record<string, unknown>;

export async function verifyConditions(
  config: PluginConfig,
  context: VerifyConditionsContext,
): Promise<void> {
  if (
    // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this placeholder.
    context.options.tagFormat !== 'workspace-v${version}'
  ) {
    throw new SemanticReleaseError(
      'Use the documented workspace tag format.',
      'EWORKSPACECONFIG',
    );
  }
  changelogEnabled(config);
  npmChannel(context.branch.channel);
  if (
    branchType(context) === 'prerelease' &&
    (String(context.branch.prerelease).includes('.') ||
      /^\d+$/.test(String(context.branch.prerelease)))
  )
    throw new SemanticReleaseError(
      'Use a prerelease identifier containing a letter or hyphen and no dots; semantic-release 25 cannot recover numeric or dotted identifiers.',
      'EWORKSPACECONFIG',
    );
  const root = await git(context, 'rev-parse', '--show-toplevel');
  if (
    (await realpath(context.cwd ?? process.cwd())) !== (await realpath(root))
  ) {
    throw new SemanticReleaseError(
      'Run the workspace plugin from the repository root.',
      'EWORKSPACECONFIG',
    );
  }
  checkNotesPolicy(config, (await snapshot(context)).journal);
  if (publishing(config) && !context.options.dryRun)
    await recoverManifests(context);
  if (await git(context, 'status', '--porcelain', '--untracked-files=normal')) {
    throw new SemanticReleaseError(
      'The workspace checkout must be clean.',
      'EWORKSPACEDIRTY',
    );
  }
  const inventory = await discoverWorkspaces(root);
  context.logger.log(
    'Discovered %d workspace packages (%d publishable).',
    inventory.packages.length,
    inventory.packages.filter((pkg) => !pkg.private).length,
  );
  const current = await snapshot(context);
  await repairChannels(context, current);
  await recoverChannels(config, context);
}

export async function analyzeCommits(
  config: PluginConfig,
  context: AnalyzeCommitsContext,
): Promise<import('./plan-types.js').ReleaseType | undefined> {
  const planning = await createVersionPlan(config, context);
  if (planning.plan.packages.length)
    return planning.current.journal?.status === 'pending' ||
      planning.plan.packages.some((pkg) => pkg.type)
      ? coordinatorType(context, planning.plan.packages)
      : undefined;
  const { current, commits } = await commitsSinceCompletion(context);
  const release = await analyzeConventionalCommits(config, {
    ...context,
    commits,
  });
  if (current.journal?.status === 'pending' || release) {
    assertPendingBranches(context, current.reservations);
    return 'patch';
  }
  return undefined;
}

export async function verifyRelease(
  _config: PluginConfig,
  context: VerifyReleaseContext,
): Promise<void> {
  const planning = await createVersionPlan(_config, context);
  if (
    context.nextRelease.type !==
    coordinatorType(context, planning.plan.packages)
  ) {
    throw new SemanticReleaseError(
      'The workspace coordinator must own commit analysis.',
      'EWORKSPACECONFIG',
    );
  }
  await preflight(_config, context, planning);
}

export async function generateNotes(
  config: PluginConfig,
  context: GenerateNotesContext,
): Promise<string> {
  const promotion = await planPromotion(config, context);
  if (promotion) return promotion;
  const planning = await createVersionPlan(config, context);
  if (planning.plan.packages.length) {
    const notes = await notesForRelease(
      config,
      context,
      planning,
      await preflight(config, context, planning),
    );
    return formatReleaseNotes(context, planning, notes, publishing(config));
  }
  const { current, commits } = await commitsSinceCompletion(context);
  return [
    '# Workspace batch lifecycle proof',
    '',
    current.journal?.status === 'pending'
      ? 'Retrying unfinished workspace work.'
      : 'Workspace work awaiting completion.',
    '',
    ...commits.map(
      ({ hash, message }) =>
        `- ${message.split('\n')[0]} (${hash.slice(0, 7)})`,
    ),
    '',
    'No workspace packages were discovered; this batch contains repository-wide lifecycle proof work.',
  ].join('\n');
}

export async function prepare(
  config: PluginConfig,
  context: PrepareContext,
): Promise<void> {
  const planning = await createVersionPlan(config, context);
  if (publishing(config) && planning.plan.packages.length) {
    await preparePublication(
      config,
      context,
      planning,
      context.nextRelease.gitTag,
    );
    await recordChannels(context, planning.plan.head);
    return;
  }
  if (planning.plan.packages.length)
    planning.releaseNotes = await notesForRelease(
      config,
      context,
      planning,
      [],
    );
  await writeJournal(
    context,
    planning.current,
    'pending',
    context.nextRelease.gitTag,
    planning.plan.packages.length || planning.current.journal?.planning
      ? planning
      : undefined,
  );
  await recordChannels(context, planning.plan.head);
}

export async function publish(config: PluginConfig, context: PublishContext) {
  const planning = await createVersionPlan(config, context);
  const { plan } = planning;
  if (publishing(config) && planning.current.journal?.execution) {
    await publishPackages(
      config,
      context,
      planning,
      context.nextRelease.gitTag,
    );
    return { name: 'Workspace packages', plan };
  }
  context.logger.log(
    'Workspace planning completed; no packages were published.',
  );
  return { name: 'Workspace version plan', plan };
}

export async function addChannel(
  config: PluginConfig,
  context: PublishContext,
) {
  await recoverChannels(config, context);
  await recordChannels(
    context,
    await git(
      context,
      'rev-parse',
      `refs/tags/${context.nextRelease.gitTag}^{commit}`,
    ),
  );
  return { name: 'Workspace channel promotion' };
}

export async function success(
  config: PluginConfig,
  context: SuccessContext,
): Promise<void> {
  if (await promotionSource(context)) return;
  const planning = await createVersionPlan(config, context);
  await writeJournal(
    context,
    planning.current,
    'complete',
    context.nextRelease.gitTag,
    planning.plan.packages.length || planning.current.journal?.planning
      ? planning
      : undefined,
    planning.current.journal?.execution,
  );
}

export async function fail(
  _config: PluginConfig,
  context: FailContext,
): Promise<void> {
  context.logger.error(
    'Workspace batch did not complete. Any pending journal is preserved for retry.',
  );
}
