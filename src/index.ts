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

type PluginConfig = Record<string, unknown>;

export async function verifyConditions(
  _config: PluginConfig,
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
  _config: PluginConfig,
  context: AnalyzeCommitsContext,
): Promise<'patch' | undefined> {
  const { current, commits } = await commitsSinceCompletion(context);
  const release = await analyzeConventionalCommits({}, { ...context, commits });
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
  await snapshot(context);
}

export async function generateNotes(
  _config: PluginConfig,
  context: GenerateNotesContext,
): Promise<string> {
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
    'Per-package versioning and publication are not implemented in this milestone.',
  ].join('\n');
}

export async function prepare(
  _config: PluginConfig,
  context: PrepareContext,
): Promise<void> {
  await writeJournal(
    context,
    await snapshot(context),
    'pending',
    context.nextRelease.gitTag,
  );
}

export async function publish(
  _config: PluginConfig,
  context: PublishContext,
): Promise<{ name: string }> {
  await snapshot(context);
  context.logger.log(
    'Workspace lifecycle proof completed; no packages were published.',
  );
  return { name: 'Workspace batch lifecycle proof' };
}

export async function success(
  _config: PluginConfig,
  context: SuccessContext,
): Promise<void> {
  await writeJournal(
    context,
    await snapshot(context),
    'complete',
    context.nextRelease.gitTag,
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
