import type { VerifyConditionsContext } from 'semantic-release';
import { gte, inc, prerelease, validRange } from 'semver';
import type { Journal } from './journal.js';
import type { PackagePlan, ReleasePlan, ReleaseType } from './plan-types.js';
import { releaseError } from './release-io.js';
export function branchType(context: VerifyConditionsContext): string {
  return 'type' in context.branch ? String(context.branch.type) : 'release';
}
export function releaseRoute(
  context: VerifyConditionsContext,
): ReleasePlan['release'] {
  if (
    context.branches.length === 1 &&
    branchType(context) === 'release' &&
    !context.branch.channel
  )
    return undefined;
  return {
    branch: context.branch.name,
    type: branchType(context),
    channel: context.branch.channel || null,
    ...(branchType(context) === 'prerelease'
      ? { prerelease: String(context.branch.prerelease) }
      : {}),
  };
}
export function npmChannel(channel: string | false | null | undefined): string {
  const tag = channel
    ? validRange(channel)
      ? `release-${channel}`
      : channel
    : 'latest';
  if (!/^[A-Za-z][\w.-]*$/.test(tag))
    releaseError(
      'Branch channel is not a valid npm dist-tag.',
      'EWORKSPACECONFIG',
    );
  return tag;
}
export function nextPackageVersion(
  context: VerifyConditionsContext,
  current: string | null,
  type: ReleaseType,
): string {
  const next = current ? inc(current, type) : '1.0.0';
  if (!next)
    return releaseError(
      'Cannot increment package version.',
      'EWORKSPACEVERSION',
    );
  if (branchType(context) !== 'prerelease') return next;
  const preid = String(context.branch.prerelease);
  return current && prerelease(current) && next === current.split('-')[0]
    ? (inc(current, 'prerelease', preid) ??
        releaseError('Cannot increment prerelease.', 'EWORKSPACEVERSION'))
    : `${next}-${preid}.1`;
}
export function coordinatorType(
  context: VerifyConditionsContext,
  packages: { type: ReleaseType | null }[],
): ReleaseType {
  if (context.branches.length === 1 && branchType(context) === 'release')
    return 'patch';
  return packages.some((p) => p.type === 'major')
    ? 'major'
    : packages.some((p) => p.type === 'minor')
      ? 'minor'
      : 'patch';
}

export function checkPackageBranches(
  context: VerifyConditionsContext,
  packages: PackagePlan[],
  history: Journal[],
  reservations: Journal[],
  ancestors: Set<string>,
): void {
  if (packages.some((pkg) => pkg.nextVersion))
    assertPendingBranches(context, reservations);
  const currentIndex = context.branches.findIndex(
    (branch) => branch.name === context.branch.name,
  );
  const higher = new Set(
    context.branches
      .slice(currentIndex + 1)
      .filter((branch) => !('type' in branch) || branch.type !== 'prerelease')
      .map((branch) => branch.name),
  );
  for (const pkg of packages) {
    if (!pkg.nextVersion) continue;
    if (branchType(context) === 'maintenance' && pkg.currentVersion) {
      const range =
        'mergeRange' in context.branch ? String(context.branch.mergeRange) : '';
      const upper = /<(\d+)\.(\d+)\./.exec(range);
      const ceiling = inc(
        pkg.currentVersion,
        upper && Number(upper[2]) > 0 ? 'minor' : 'major',
      );
      if (ceiling && gte(pkg.nextVersion, ceiling))
        releaseError(
          `Package ${pkg.id} exceeds its maintenance line. Merge this change into a higher release branch.`,
          'EWORKSPACEBRANCH',
        );
    }
    for (const entry of [...history, ...reservations]) {
      if (entry.branch === context.branch.name) continue;
      const allocated = entry.planning?.plan.packages.find(
        (candidate) => candidate.id === pkg.id,
      )?.nextVersion;
      if (!allocated) continue;
      if (
        allocated === pkg.nextVersion ||
        (higher.has(entry.branch) &&
          (entry.status === 'pending' || !ancestors.has(entry.head)) &&
          !prerelease(pkg.nextVersion) &&
          !prerelease(allocated) &&
          gte(pkg.nextVersion, allocated))
      )
        releaseError(
          `Package ${pkg.id}@${pkg.nextVersion} conflicts with release branch ${entry.branch}. Merge or release a higher package version on that branch first.`,
          'EWORKSPACEBRANCH',
        );
    }
  }
}

export function assertPendingBranches(
  context: VerifyConditionsContext,
  reservations: Journal[],
): void {
  if (branchType(context) === 'prerelease') return;
  const pending = reservations.find(
    (entry) =>
      entry.branch !== context.branch.name &&
      entry.planning?.plan.release?.type !== 'prerelease',
  );
  if (pending)
    releaseError(
      `Finish the pending stable batch on ${pending.branch} before releasing another stable branch; its coordinator version is reserved.`,
      'EWORKSPACEPENDING',
    );
}
