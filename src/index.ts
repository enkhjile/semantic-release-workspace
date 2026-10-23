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
import { discoverWorkspaces } from './discovery.js';
import {
  commitsSinceCompletion,
  git,
  snapshot,
  writeJournal,
} from './journal.js';
import { createVersionPlan, planNotes } from './planning.js';
import {
  preflight,
  preparePublication,
  publishing,
  publishPackages,
  recoverManifests,
} from './publication.js';

type PluginConfig = Record<string, unknown>;

export async function verifyConditions(
  config: PluginConfig,
  context: VerifyConditionsContext,
): Promise<void> {
  if (
    // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this placeholder.
    context.options.tagFormat !== 'workspace-v${version}' ||
    context.branches.length !== 1 ||
    !('type' in context.branch) ||
    context.branch.type !== 'release'
  ) {
    throw new SemanticReleaseError(
      'Use one stable release branch and the documented workspace tag format.',
      'EWORKSPACECONFIG',
    );
  }
  const root = await git(context, 'rev-parse', '--show-toplevel');
  if (
    (await realpath(context.cwd ?? process.cwd())) !== (await realpath(root))
  ) {
    throw new SemanticReleaseError(
      'Run the workspace plugin from the repository root.',
      'EWORKSPACECONFIG',
    );
  }
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
  await snapshot(context);
}

export async function analyzeCommits(
  config: PluginConfig,
  context: AnalyzeCommitsContext,
): Promise<'patch' | undefined> {
  const planning = await createVersionPlan(config, context);
  if (planning.plan.packages.length)
    return planning.current.journal?.status === 'pending' ||
      planning.plan.packages.some((pkg) => pkg.type)
      ? 'patch'
      : undefined;
  const { current, commits } = await commitsSinceCompletion(context);
  const release = await analyzeConventionalCommits(config, {
    ...context,
    commits,
  });
  return current.journal?.status === 'pending' || release ? 'patch' : undefined;
}

export async function verifyRelease(
  _config: PluginConfig,
  context: VerifyReleaseContext,
): Promise<void> {
  if (context.nextRelease.type !== 'patch') {
    throw new SemanticReleaseError(
      'The workspace coordinator must own commit analysis.',
      'EWORKSPACECONFIG',
    );
  }
  const planning = await createVersionPlan(_config, context);
  await preflight(_config, context, planning);
}

export async function generateNotes(
  config: PluginConfig,
  context: GenerateNotesContext,
): Promise<string> {
  const planning = await createVersionPlan(config, context);
  if (planning.plan.packages.length)
    return planNotes(planning.plan, publishing(config));
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
    return;
  }
  await writeJournal(
    context,
    planning.current,
    'pending',
    context.nextRelease.gitTag,
    planning.plan.packages.length || planning.current.journal?.planning
      ? planning
      : undefined,
  );
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

export async function success(
  config: PluginConfig,
  context: SuccessContext,
): Promise<void> {
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
