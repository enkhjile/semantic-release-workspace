import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateNotes as conventionalNotes } from '@semantic-release/release-notes-generator';
import type { VerifyConditionsContext } from 'semantic-release';
import { npmChannel } from './branches.js';
import { changelogChanges } from './changelogs.js';
import { git, type Journal, type Snapshot } from './journal.js';
import type {
  PackageVersion,
  PlanningState,
  ReleaseNotes,
} from './plan-types.js';
import { planNotes } from './planning.js';
import type { PublicationPackage } from './publication-state.js';
import { releaseError } from './release-io.js';

export function changelogEnabled(config: Record<string, unknown>): boolean {
  if (config.changelog !== undefined && typeof config.changelog !== 'boolean')
    releaseError('changelog must be a boolean.', 'EWORKSPACECONFIG');
  return config.changelog === true;
}
export function checkNotesPolicy(
  config: Record<string, unknown>,
  pending?: Journal,
) {
  const enabled = changelogEnabled(config);
  if (
    pending?.status === 'pending' &&
    pending.planning?.plan.packages.length &&
    enabled !== (pending.planning?.releaseNotes?.changelog ?? false)
  )
    releaseError(
      'Restore the pending batch changelog policy before retrying.',
      'EWORKSPACEPLAN',
    );
}
export async function notesForRelease(
  config: Record<string, unknown>,
  context: VerifyConditionsContext,
  planning: PlanningState & { current: Snapshot },
  destinations: PublicationPackage[],
): Promise<ReleaseNotes> {
  if (planning.releaseNotes) return planning.releaseNotes;
  const date = await git(
    context,
    'show',
    '--no-patch',
    '--format=%cs',
    planning.plan.head,
  );
  const repository = context.options.repositoryUrl ?? '';
  const result: ReleaseNotes = {
    changelog: changelogEnabled(config),
    date,
    packages: [],
    changelogs: [],
  };
  for (const pkg of planning.plan.packages) {
    if (!pkg.nextVersion) continue;
    const body = await conventionalNotes(
      {
        preset: config.preset,
        config: config.config,
        presetConfig: config.presetConfig,
        parserOpts: config.parserOpts,
        linkCompare: false,
        linkReferences: false,
        writerOpts: {
          headerPartial: '',
          finalizeContext: (value: Record<string, unknown>) => ({
            ...value,
            date,
          }),
        },
      },
      {
        ...context,
        cwd: context.cwd ?? process.cwd(),
        commits: pkg.commits,
        lastRelease: {
          gitTag: pkg.currentVersion
            ? `${pkg.id.replace(':', '/')}@${pkg.currentVersion}`
            : undefined,
        },
        nextRelease: {
          version: pkg.nextVersion,
          gitTag: `${pkg.id.replace(':', '/')}@${pkg.nextVersion}`,
        },
        options: {
          ...context.options,
          repositoryUrl: isAbsolute(repository)
            ? pathToFileURL(repository).href
            : repository,
        },
      },
    );
    const dependencies = pkg.dependencyUpdates.length
      ? [
          '### Dependencies',
          '',
          ...pkg.dependencyUpdates.map(
            (update) =>
              `- ${update.dependency}: ${update.from ?? 'unspecified'} → ${update.to} (published: ${update.publishedRange}).`,
          ),
        ].join('\n')
      : '';
    let channel: string | null = null;
    if (!pkg.private) {
      if (pkg.ecosystem === 'npm') {
        channel =
          destinations.find((entry) => entry.id === pkg.id)?.destination.tag ??
          npmChannel(context.branch.channel);
      } else {
        channel = context.branch.channel || null;
      }
    }
    result.packages.push({
      id: pkg.id,
      version: pkg.nextVersion,
      channel,
      notes:
        [body.trim(), dependencies].filter(Boolean).join('\n\n') ||
        'Maintenance release.',
    });
  }
  result.changelogs = await changelogChanges(context, planning, result);
  return result;
}
export function formatReleaseNotes(
  context: VerifyConditionsContext,
  planning: PlanningState,
  notes: ReleaseNotes,
  publish: boolean,
  promotion = false,
): string {
  const channels = [
    ...new Set(
      notes.packages
        .filter((pkg) => pkg.id.startsWith('npm:') && pkg.channel !== null)
        .map((pkg) => pkg.channel),
    ),
  ];
  return [
    promotion ? '# Workspace channel promotion' : '# Workspace release',
    '',
    `Branch: \`${context.branch.name}\` · Source date: ${notes.date}`,
    ...(channels.length
      ? [
          `npm channel: ${channels.map((channel) => `\`${channel}\``).join(', ')}`,
        ]
      : []),
    ...(notes.packages.some((pkg) => pkg.id.startsWith('cargo:'))
      ? [
          `Cargo uses SemVer versions and Git channel \`${context.branch.channel || 'default'}\`; registries have no dist-tags.`,
        ]
      : []),
    ...(promotion
      ? ['No new changelog entries, package versions or artifacts are created.']
      : []),
    '',
    ...notes.packages.flatMap((pkg) => [
      `## ${pkg.id}@${pkg.version}${planning.plan.packages.find((entry) => entry.id === pkg.id)?.private ? ' (private)' : ''}`,
      '',
      pkg.notes,
      '',
    ]),
    ...(notes.changelogs.length
      ? [
          `Changelogs: ${notes.changelogs.map((change) => `\`${change.path}\``).join(', ')}`,
          '',
        ]
      : []),
    '<details>',
    '<summary>Workspace version plan</summary>',
    '',
    planNotes(planning.plan, publish),
    '',
    '</details>',
  ].join('\n');
}

export async function notesForPromotion(
  context: VerifyConditionsContext,
  source: Journal,
  history: Journal[],
  versions: PackageVersion[] = source.planning?.versions ?? [],
): Promise<string> {
  if (!source.planning)
    return `# Workspace channel promotion\n\nBranch: \`${context.branch.name}\` · Channel: \`${npmChannel(context.branch.channel)}\`\n\nNo new changelog entries or artifacts are created.`;
  const notes: ReleaseNotes = {
    changelog: false,
    date:
      source.planning.releaseNotes?.date ??
      (await git(context, 'show', '--no-patch', '--format=%cs', source.head)),
    packages: [],
    changelogs: [],
  };
  for (const version of versions) {
    if (
      !source.planning.plan.packages.some(
        (pkg) => pkg.id === version.id && !pkg.private,
      )
    )
      continue;
    const original = history
      .filter((entry) => entry.head === version.head)
      .flatMap((entry) => entry.planning?.releaseNotes?.packages ?? [])
      .find((pkg) => pkg.id === version.id && pkg.version === version.version);
    notes.packages.push({
      id: version.id,
      version: version.version,
      channel: version.id.startsWith('npm:')
        ? npmChannel(context.branch.channel)
        : context.branch.channel || null,
      notes:
        original?.notes ??
        'No retained package notes are available for this historical version.',
    });
  }
  return formatReleaseNotes(
    context,
    source.planning,
    notes,
    Boolean(source.execution),
    true,
  );
}
