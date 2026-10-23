import { join } from 'node:path';
import { analyzeCommits as analyzeConventionalCommits } from '@semantic-release/commit-analyzer';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import { gt, inc, prerelease, valid } from 'semver';
import { parse } from 'smol-toml';
import { attributeCommits, packageId, sharedPatterns } from './attribution.js';
import { coordinateDependencies } from './dependencies.js';
import { discoverWorkspaces } from './discovery.js';
import { baseline, git, readCommits, snapshot } from './journal.js';
import type { PackagePlan, PackageVersion, ReleasePlan } from './plan-types.js';
import { record, text } from './workspace-files.js';
import type { WorkspacePackage } from './workspace-types.js';

function stable(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string' && valid(value) === value && !prerelease(value))
    return value;
  throw new SemanticReleaseError(
    `A stable semantic version is required for ${label}.`,
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
  const versions = new Map<string, PackageVersion>(
    (current.journal?.planning?.versions ?? []).map((entry) => [
      entry.id,
      entry,
    ]),
  );
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
      if (valid(candidate) !== candidate || prerelease(candidate)) continue;
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
      nextVersion: type ? (version ? inc(version, type) : '1.0.0') : null,
      type,
      commits: selected,
      dependencyUpdates: [],
    });
  }
  const coordinated = coordinateDependencies(
    inventory,
    packages,
    workspace,
    current.journal?.planning?.dependencyRanges,
  );
  const plan: ReleasePlan = {
    schemaVersion: 1,
    head: current.head,
    baseHead: baseline(current),
    packages,
    groups: coordinated.groups,
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
