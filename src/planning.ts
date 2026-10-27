import { join } from 'node:path';
import { analyzeCommits as analyzeConventionalCommits } from '@semantic-release/commit-analyzer';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import { gt, prerelease, valid } from 'semver';
import { parse } from 'smol-toml';
import { attributeCommits, packageId, sharedPatterns } from './attribution.js';
import {
  branchType,
  checkPackageBranches,
  nextPackageVersion,
  releaseRoute,
} from './branches.js';
import { coordinateDependencies } from './dependencies.js';
import { discoverWorkspaces } from './discovery.js';
import { baseline, git, readCommits, snapshot } from './journal.js';
import type { PackagePlan, PackageVersion, ReleasePlan } from './plan-types.js';
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
  const inventory = await discoverWorkspaces(context.cwd ?? process.cwd());
  const rawCargo = inventory.packages.some((pkg) => pkg.ecosystem === 'cargo')
    ? await text(inventory.root, join(inventory.root, 'Cargo.toml'))
    : undefined;
  const cargo = rawCargo === undefined ? {} : parse(rawCargo);
  const workspace = record(cargo.workspace) ? cargo.workspace : {};
  const tags = (await git(context, 'tag', '--merged', current.head, '--list'))
    .split('\n')
    .filter(Boolean);
  const eligible = (version: string) =>
    !prerelease(version) ||
    (branchType(context) === 'prerelease' &&
      prerelease(version)?.slice(0, -1).join('.') ===
        String(context.branch.prerelease));
  const completed = current.history;
  const ancestors = new Set(
    (await git(context, 'rev-list', '--topo-order', current.head)).split('\n'),
  );
  const versions = new Map<string, PackageVersion>();
  const knownVersions = new Map<string, Set<string>>();
  const rememberVersion = (id: string, version: string) => {
    const known = knownVersions.get(id) ?? new Set<string>();
    known.add(version);
    knownVersions.set(id, known);
  };
  const projections = new Map<
    string,
    import('./plan-types.js').DependencyUpdate
  >();
  for (const entry of completed) {
    if (!ancestors.has(entry.head)) continue;
    for (const version of entry.planning?.versions ?? []) {
      if (!eligible(version.version)) continue;
      rememberVersion(version.id, version.version);
      const previous = versions.get(version.id);
      if (!previous || gt(version.version, previous.version))
        versions.set(version.id, version);
    }
  }
  if (current.journal?.status === 'pending') {
    versions.clear();
    for (const version of current.journal.planning?.versions ?? [])
      versions.set(version.id, version);
  }
  const positions = new Map([...ancestors].map((head, index) => [head, index]));
  const projectionHistory = completed
    .filter(
      (entry) =>
        ancestors.has(entry.head) &&
        (entry.planning?.plan.release?.type !== 'prerelease' ||
          (branchType(context) === 'prerelease' &&
            entry.planning.plan.release.prerelease ===
              String(context.branch.prerelease))),
    )
    .sort(
      (left, right) =>
        (positions.get(left.head) ?? 0) - (positions.get(right.head) ?? 0),
    );
  for (const version of versions.values()) {
    // Later batches carry projections for unchanged packages, including dev-only
    // changes. Legacy journals may be the only record of those earlier releases.
    const carrier = projectionHistory.find((entry) =>
      entry.planning?.versions.some(
        (candidate) =>
          candidate.id === version.id &&
          candidate.version === version.version &&
          candidate.head === version.head,
      ),
    );
    const previousPackage = carrier?.planning?.plan.packages.find(
      (pkg) => pkg.id === version.id,
    );
    if (!previousPackage) continue;
    const currentPackage = inventory.packages.find(
      (pkg) => packageId(pkg) === version.id,
    );
    const file =
      previousPackage.ecosystem === 'npm' ? 'package.json' : 'Cargo.toml';
    const previousManifest = `${previousPackage.path === '.' ? '' : `${previousPackage.path}/`}${file}`;
    for (const update of previousPackage.dependencyUpdates) {
      // Only package-owned fields follow a move. Shared Cargo workspace
      // dependencies remain in the root manifest, even for a former root crate.
      const projection =
        currentPackage &&
        update.manifestPath === previousManifest &&
        update.field[0] !== 'workspace'
          ? {
              ...update,
              manifestPath: `${currentPackage.path === '.' ? '' : `${currentPackage.path}/`}${file}`,
            }
          : update;
      projections.set(
        JSON.stringify([projection.manifestPath, projection.field]),
        projection,
      );
    }
  }
  const packages: PackagePlan[] = [];
  const baselines: {
    pkg: WorkspacePackage;
    version: string | null;
    covered: Set<string>;
  }[] = [];
  for (const pkg of inventory.packages) {
    const id = packageId(pkg);
    const declared = declaredVersion(pkg, workspace);
    const previous = versions.get(id);
    let version = previous?.version ?? declared;
    let taggedVersion = previous?.version;
    let tagHead = previous?.head;
    const prefix = `${pkg.ecosystem}/${pkg.name}@`;
    for (const tag of tags) {
      if (!tag.startsWith(prefix)) continue;
      const candidate = tag.slice(prefix.length);
      if (valid(candidate) !== candidate || !eligible(candidate)) continue;
      rememberVersion(id, candidate);
      if (taggedVersion === undefined || gt(candidate, taggedVersion)) {
        taggedVersion = candidate;
        tagHead = await git(context, 'rev-parse', `refs/tags/${tag}^{commit}`);
      }
    }
    if (taggedVersion && tagHead) {
      version = taggedVersion;
      versions.set(id, { id, version, head: tagHead });
    }
    const covered = tagHead
      ? new Set((await git(context, 'rev-list', tagHead)).split('\n'))
      : new Set<string>();
    baselines.push({ pkg, version, covered });
  }
  const history = baselines.length
    ? await readCommits(context, current.head)
    : [];
  // Only diff commits that remain unreleased for at least one package.
  const needed = history.filter((commit) =>
    baselines.some(({ covered }) => !covered.has(commit.hash)),
  );
  const attributed = await attributeCommits(
    context,
    inventory.packages,
    needed,
    sharedPatterns(config.sharedFiles),
  );
  for (const { pkg, version, covered } of baselines) {
    const id = packageId(pkg);
    const selected = (attributed.get(id) ?? []).filter(
      (commit) => !covered.has(commit.hash),
    );
    const type = await analyzeConventionalCommits(config, {
      ...context,
      commits: selected,
    });
    packages.push({
      id,
      ecosystem: pkg.ecosystem,
      name: pkg.name,
      path: pkg.path,
      private: pkg.private,
      currentVersion: version,
      nextVersion: type ? nextPackageVersion(context, version, type) : null,
      type,
      commits: selected,
      dependencyUpdates: [],
    });
  }
  const legacyPending =
    current.journal?.status === 'pending' &&
    current.journal.planning !== undefined &&
    current.journal.planning.plan.dependencyPolicy === undefined;
  const coordinated = coordinateDependencies(
    inventory,
    packages,
    workspace,
    current.journal?.status === 'pending'
      ? current.journal.planning?.dependencyRanges
      : [...projections.values()],
    (version, type) => nextPackageVersion(context, version, type),
    config.synchronizeDependents === true,
    config.synchronizeDependents === true && !legacyPending,
    knownVersions,
  );
  checkPackageBranches(
    context,
    packages,
    current.history,
    current.reservations,
    ancestors,
  );
  const allocatedTags = new Set(
    (await git(context, 'tag', '--list')).split('\n'),
  );
  for (const pkg of packages) {
    if (!pkg.nextVersion || pkg.private) continue;
    const tag = `${pkg.ecosystem}/${pkg.name}@${pkg.nextVersion}`;
    if (!allocatedTags.has(tag)) continue;
    const prepared =
      current.journal?.status === 'pending'
        ? current.journal.execution?.prepared
        : undefined;
    if (
      !prepared ||
      (await git(context, 'rev-parse', `refs/tags/${tag}^{commit}`)) !==
        prepared
    )
      throw new SemanticReleaseError(
        `Package tag already allocates ${pkg.id}@${pkg.nextVersion}.`,
        'EWORKSPACETAG',
      );
  }
  const route = releaseRoute(context);
  const plan: ReleasePlan = {
    ...(route ? { release: route } : {}),
    schemaVersion: 1,
    head: current.head,
    baseHead: baseline(current),
    packages,
    groups: coordinated.groups,
    ...(!legacyPending
      ? {
          dependencyPolicy:
            config.synchronizeDependents === true
              ? ('synchronize' as const)
              : ('independent' as const),
        }
      : {}),
    ...(coordinated.stagingDependencies.length
      ? { stagingDependencies: coordinated.stagingDependencies }
      : {}),
  };
  if (
    current.journal?.status === 'pending' &&
    current.journal.planning &&
    JSON.stringify(plan) !== JSON.stringify(current.journal.planning.plan)
  )
    throw new SemanticReleaseError(
      'The pending workspace plan changed. Restore its source and configuration before retrying.',
      'EWORKSPACEPLAN',
    );
  return {
    current,
    ...(current.journal?.status === 'pending' &&
    current.journal.planning?.releaseNotes
      ? { releaseNotes: current.journal.planning.releaseNotes }
      : {}),
    plan,
    versions: [...versions.values()],
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
