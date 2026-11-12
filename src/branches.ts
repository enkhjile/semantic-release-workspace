import type { VerifyConditionsContext } from 'semantic-release';
import { validRange } from 'semver';
import type { Journal } from './journal.js';
import type { ReleasePlan } from './plan-types.js';
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
