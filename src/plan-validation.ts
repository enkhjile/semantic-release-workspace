import { valid } from 'semver';
import type { PlanningState } from './plan-types.js';
import { record } from './workspace-files.js';

export const oid = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function version(value: unknown): value is string {
  return typeof value === 'string' && valid(value) === value;
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
    (plan.release !== undefined &&
      (!record(plan.release) ||
        typeof plan.release.branch !== 'string' ||
        !['release', 'maintenance', 'prerelease'].includes(
          String(plan.release.type),
        ) ||
        !(
          plan.release.channel === null ||
          typeof plan.release.channel === 'string'
        ) ||
        (plan.release.type === 'prerelease' &&
          (typeof plan.release.prerelease !== 'string' ||
            valid(`1.0.0-${plan.release.prerelease}.1`) === null)))) ||
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
  const planned = plan.packages;
  if (value.releaseNotes !== undefined) {
    const notes = value.releaseNotes;
    if (
      !record(notes) ||
      typeof notes.changelog !== 'boolean' ||
      typeof notes.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(notes.date) ||
      !Array.isArray(notes.packages) ||
      !Array.isArray(notes.changelogs) ||
      notes.packages.length !== released.size ||
      new Set(
        notes.packages.map((entry: unknown) =>
          record(entry) ? entry.id : null,
        ),
      ).size !== released.size ||
      !notes.packages.every(
        (entry: unknown) =>
          record(entry) &&
          typeof entry.id === 'string' &&
          released.has(entry.id) &&
          entry.version ===
            planned.find((pkg: Record<string, unknown>) => pkg.id === entry.id)
              ?.nextVersion &&
          (entry.channel === null || typeof entry.channel === 'string') &&
          typeof entry.notes === 'string',
      ) ||
      (!notes.changelog && notes.changelogs.length > 0) ||
      new Set(
        notes.changelogs.map((entry: unknown) =>
          record(entry) ? entry.path : null,
        ),
      ).size !== notes.changelogs.length ||
      !notes.changelogs.every(
        (entry: unknown) =>
          record(entry) &&
          path(entry.path) &&
          planned.some(
            (pkg: Record<string, unknown>) =>
              pkg.nextVersion &&
              entry.path ===
                (pkg.path === '.'
                  ? 'CHANGELOG.md'
                  : `${pkg.path}/CHANGELOG.md`),
          ) &&
          (entry.before === null || typeof entry.before === 'string') &&
          typeof entry.after === 'string',
      )
    )
      return false;
  }
  return value.dependencyRanges.every(update);
}
