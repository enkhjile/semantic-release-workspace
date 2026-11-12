import { join } from 'node:path';
import { analyzeCommits as analyzeConventionalCommits } from '@semantic-release/commit-analyzer';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import { gt, prerelease, valid } from 'semver';
import { parse } from 'smol-toml';
import { attributeCommits, packageId, sharedPatterns } from './attribution.js';
import { assertPendingBranches, branchType, releaseRoute } from './branches.js';
import { coordinateDependencies } from './dependencies.js';
import { discoverWorkspaces } from './discovery.js';
import { baseline, git, readCommits, snapshot } from './journal.js';
import type { PackagePlan, ReleasePlan, ReleaseType } from './plan-types.js';
import { record, text } from './workspace-files.js';
import type { WorkspacePackage } from './workspace-types.js';

function stable(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string' && valid(value) === value) return value;
  throw new SemanticReleaseError(
    `A semantic version is required for ${label}.`,
    'EWORKSPACEVERSION',
  );
}
function declaredVersion(
  pkg: WorkspacePackage,
  workspace: Record<string, unknown>,
): string | null {
  const data = pkg.ecosystem === 'npm' ? pkg.manifest : pkg.manifest.package;
  if (!record(data)) return null;
  let version = data.version;
  if (record(version) && version.workspace === true)
    version = record(workspace.package) ? workspace.package.version : undefined;
  if (record(data.version) && version === undefined)
    throw new SemanticReleaseError(
      `Unresolved inherited version for ${pkg.name}.`,
      'EWORKSPACEVERSION',
    );
  return stable(version, packageId(pkg));
}
export async function createVersionPlan(
  config: Record<string, unknown>,
  context: VerifyConditionsContext,
) {
  const current = await snapshot(context);
  const pending =
    current.journal?.status === 'pending' ? current.journal : undefined;
  const release =
    'nextRelease' in context
      ? (context.nextRelease as { version: string; type: ReleaseType })
      : undefined;
  const version = release?.version ?? pending?.planning?.plan.version;
  const type = release?.type ?? pending?.planning?.plan.releaseType;
  if (!version || !valid(version) || !type)
    throw new SemanticReleaseError(
      'semantic-release must assign the shared release version before planning.',
      'EWORKSPACEVERSION',
    );
  const inventory = await discoverWorkspaces(context.cwd ?? process.cwd());
  const rawCargo = inventory.packages.some((pkg) => pkg.ecosystem === 'cargo')
    ? await text(inventory.root, join(inventory.root, 'Cargo.toml'))
    : undefined;
  const cargo = rawCargo === undefined ? {} : parse(rawCargo);
  const workspace = record(cargo.workspace) ? cargo.workspace : {};
  const lastRelease =
    'lastRelease' in context
      ? (context.lastRelease as { version?: string; gitHead?: string })
      : undefined;
  const baseHead = pending
    ? pending.baseHead
    : lastRelease?.gitHead || baseline(current);
  const commits = await readCommits(context, current.head, baseHead);
  if (
    pending &&
    (await analyzeConventionalCommits(config, { ...context, commits })) !== type
  )
    throw new SemanticReleaseError(
      'The pending workspace commit analysis changed. Restore its release rules before retrying.',
      'EWORKSPACEPLAN',
    );
  const attributed = await attributeCommits(
    context,
    inventory.packages,
    commits,
    sharedPatterns(config.sharedFiles),
  );
  const tags = (
    await git(context, 'tag', '--merged', current.head, '--list')
  ).split('\n');
  const ancestors = new Set(
    (await git(context, 'rev-list', current.head)).split('\n'),
  );
  const legacyVersions = current.history
    .filter(
      (entry) =>
        ancestors.has(entry.head) &&
        entry.planning?.plan.versioning !== 'shared',
    )
    .flatMap((entry) => entry.planning?.versions ?? []);
  const packages: PackagePlan[] = inventory.packages.map((pkg) => {
    const id = packageId(pkg);
    const declared = declaredVersion(pkg, workspace);
    // A prerelease may start from a source manifest declaring its stable base.
    if (
      !pkg.private &&
      declared &&
      gt(declared.replace(/-.*/, ''), version.replace(/-.*/, ''))
    )
      throw new SemanticReleaseError(
        `${id} declares ${declared}, above shared version ${version}. Establish a shared coordinator baseline at or above existing versions before migrating.`,
        'EWORKSPACEMIGRATION',
      );
    for (const previous of legacyVersions) {
      if (pkg.private || previous.id !== id) continue;
      const preid = prerelease(previous.version);
      if (
        preid &&
        (branchType(context) !== 'prerelease' ||
          preid.slice(0, -1).join('.') !== String(context.branch.prerelease))
      )
        continue;
      if (gt(previous.version, version))
        throw new SemanticReleaseError(
          `Completed legacy release ${id}@${previous.version} exceeds shared version ${version}. Establish a shared coordinator baseline before migrating.`,
          'EWORKSPACEMIGRATION',
        );
    }
    for (const tag of tags) {
      const prefix = `${pkg.ecosystem}/${pkg.name}@`;
      if (pkg.private || !tag.startsWith(prefix)) continue;
      const allocated = tag.slice(prefix.length);
      if (valid(allocated) !== allocated) continue;
      const preid = prerelease(allocated);
      if (
        preid &&
        (branchType(context) !== 'prerelease' ||
          preid.slice(0, -1).join('.') !== String(context.branch.prerelease))
      )
        continue;
      if (gt(allocated, version))
        throw new SemanticReleaseError(
          `Existing release ${tag} exceeds shared version ${version}. Establish a shared coordinator baseline before migrating.`,
          'EWORKSPACEMIGRATION',
        );
    }
    return {
      id,
      ecosystem: pkg.ecosystem,
      name: pkg.name,
      path: pkg.path,
      private: pkg.private,
      currentVersion:
        pending?.planning?.plan.packages.find((entry) => entry.id === id)
          ?.currentVersion ??
        (pkg.private ? declared : (lastRelease?.version ?? null)),
      nextVersion: pkg.private ? null : version,
      type: pkg.private ? null : type,
      commits: attributed.get(id) ?? [],
      dependencyUpdates: [],
    };
  });
  const coordinated = coordinateDependencies(inventory, packages, workspace);
  assertPendingBranches(context, current.reservations);
  const allocatedTags = new Set(
    (await git(context, 'tag', '--list')).split('\n'),
  );
  for (const pkg of packages) {
    if (!pkg.nextVersion || pkg.private) continue;
    const tag = `${pkg.ecosystem}/${pkg.name}@${pkg.nextVersion}`;
    if (!allocatedTags.has(tag)) continue;
    throw new SemanticReleaseError(
      `Legacy package tag already allocates ${pkg.id}@${pkg.nextVersion}. Establish a newer shared coordinator version before migrating.`,
      'EWORKSPACETAG',
    );
  }
  const route = releaseRoute(context);
  const plan: ReleasePlan = {
    ...(route ? { release: route } : {}),
    schemaVersion: 1,
    versioning: 'shared',
    version,
    releaseType: type,
    head: current.head,
    baseHead,
    packages,
    groups: coordinated.groups,
    ...(coordinated.stagingDependencies.length
      ? { stagingDependencies: coordinated.stagingDependencies }
      : {}),
  };
  if (
    pending?.planning &&
    JSON.stringify(plan) !== JSON.stringify(pending.planning.plan)
  )
    throw new SemanticReleaseError(
      'The pending workspace plan changed. Restore its source and configuration before retrying.',
      'EWORKSPACEPLAN',
    );
  return {
    current,
    ...(pending?.planning?.releaseNotes
      ? { releaseNotes: pending.planning.releaseNotes }
      : {}),
    plan,
    versions: [] as import('./plan-types.js').PackageVersion[],
    dependencyRanges: coordinated.dependencyRanges,
  };
}
export function planNotes(plan: ReleasePlan, publish = false): string {
  return [
    '# Workspace version plan',
    '',
    ...plan.packages
      .filter((pkg) => pkg.type)
      .map(
        (pkg) =>
          `- ${pkg.id}: ${pkg.currentVersion ?? 'unreleased'} → ${pkg.nextVersion} (${pkg.type}${pkg.private ? ', private' : ''})`,
      ),
    '',
    publish
      ? 'Package versions, manifest edits and dependency-first publication order are frozen for this batch.'
      : 'Planning only; manifests and registries are unchanged.',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
  ].join('\n');
}
