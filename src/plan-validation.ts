import { prerelease, valid } from 'semver';
import type { PlanningState } from './plan-types.js';
import { record } from './workspace-files.js';

export const oid = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function version(value: unknown): value is string {
  return (
    typeof value === 'string' && valid(value) === value && !prerelease(value)
  );
}
function path(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/^(?:\/|[a-z]:)/i.test(value) &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^(?:npm|cargo):\S+/.test(value);
}
function update(value: unknown): boolean {
  return (
    record(value) &&
    id(value.dependency) &&
    path(value.manifestPath) &&
    Array.isArray(value.field) &&
    value.field.length > 0 &&
    value.field.every((key) => typeof key === 'string' && key.length > 0) &&
    (value.from === null || typeof value.from === 'string') &&
    typeof value.to === 'string' &&
    value.to.length > 0 &&
    typeof value.publishedRange === 'string'
  );
}
export function validPlanning(value: unknown): value is PlanningState {
  if (
    !record(value) ||
    !record(value.plan) ||
    !Array.isArray(value.versions) ||
    !Array.isArray(value.dependencyRanges)
  )
    return false;
  const plan = value.plan;
  if (
    plan.schemaVersion !== 1 ||
    !oid(plan.head) ||
    !(plan.baseHead === null || oid(plan.baseHead)) ||
    !Array.isArray(plan.packages) ||
    !Array.isArray(plan.groups)
  )
    return false;
  const names = new Set<string>();
  const released = new Set<string>();
  for (const pkg of plan.packages) {
    if (
      !record(pkg) ||
      !['npm', 'cargo'].includes(String(pkg.ecosystem)) ||
      typeof pkg.name !== 'string' ||
      pkg.id !== `${pkg.ecosystem}:${pkg.name}` ||
      !id(pkg.id) ||
      names.has(pkg.id) ||
      !path(pkg.path) ||
      typeof pkg.private !== 'boolean' ||
      !(pkg.currentVersion === null || version(pkg.currentVersion)) ||
      !(pkg.nextVersion === null || version(pkg.nextVersion)) ||
      !(
        pkg.type === null ||
        ['major', 'minor', 'patch'].some((type) => type === pkg.type)
      ) ||
      (pkg.type === null) !== (pkg.nextVersion === null) ||
      !Array.isArray(pkg.commits) ||
      !pkg.commits.every(
        (commit) =>
          record(commit) &&
          oid(commit.hash) &&
          typeof commit.message === 'string',
      ) ||
      !Array.isArray(pkg.dependencyUpdates) ||
      !pkg.dependencyUpdates.every(update)
    )
      return false;
    names.add(pkg.id);
    if (pkg.type) released.add(pkg.id);
  }
  const grouped = new Set<string>();
  for (const group of plan.groups) {
    if (!Array.isArray(group) || !group.length) return false;
    for (const entry of group) {
      if (
        typeof entry !== 'string' ||
        !released.has(entry) ||
        grouped.has(entry)
      )
        return false;
      grouped.add(entry);
    }
  }
  if (grouped.size !== released.size) return false;
  const versions = new Set<string>();
  if (
    !value.versions.every((entry) => {
      if (
        !record(entry) ||
        !id(entry.id) ||
        versions.has(entry.id) ||
        !version(entry.version) ||
        !oid(entry.head)
      )
        return false;
      versions.add(entry.id);
      return true;
    })
  )
    return false;
  return value.dependencyRanges.every(update);
}
