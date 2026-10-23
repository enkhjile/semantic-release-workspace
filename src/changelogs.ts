import { join } from 'node:path';
import type { VerifyConditionsContext } from 'semantic-release';
import { gt, lte, prerelease } from 'semver';
import { git, type Journal, type Snapshot } from './journal.js';
import { readReleaseFile } from './manifests.js';
import type {
  ChangelogChange,
  PlanningState,
  ReleaseNotes,
} from './plan-types.js';
import {
  digest,
  fetchRef,
  readGitFile,
  refFor,
  releaseError,
} from './release-io.js';

type Planning = PlanningState & { current: Snapshot };

function changelogOrigin(
  path: string,
  planning: Planning,
  ancestors: Map<string, number>,
): Journal | undefined {
  const origins: Journal[] = [];
  for (const pkg of planning.plan.packages.filter(
    (entry) => join(entry.path, 'CHANGELOG.md') === path,
  )) {
    const current = pkg.currentVersion;
    if (!current) continue;
    let selected: Journal | undefined;
    let selectedVersion: string | undefined;
    for (const entry of planning.current.history) {
      if (
        !entry.execution ||
        !ancestors.has(entry.head) ||
        !entry.planning?.releaseNotes?.changelogs.some(
          (change) => change.path === path,
        )
      )
        continue;
      const version = entry.planning.plan.packages.find(
        (old) => old.id === pkg.id,
      )?.nextVersion;
      if (!version || !lte(version, current)) continue;
      const pre = prerelease(version);
      if (
        pre &&
        (!prerelease(current) ||
          pre.slice(0, -1).join('.') !==
            prerelease(current)?.slice(0, -1).join('.'))
      )
        continue;
      if (!selectedVersion || gt(version, selectedVersion)) {
        selected = entry;
        selectedVersion = version;
      }
    }
    if (selected) origins.push(selected);
  }
  return origins.sort(
    (a, b) => (ancestors.get(a.head) ?? 0) - (ancestors.get(b.head) ?? 0),
  )[0];
}

export async function changelogChanges(
  context: VerifyConditionsContext,
  planning: Planning,
  notes: ReleaseNotes,
): Promise<ChangelogChange[]> {
  if (!notes.changelog) return [];
  const paths = new Map<string, ReleaseNotes['packages']>();
  for (const pkg of notes.packages) {
    const planned = planning.plan.packages.find((entry) => entry.id === pkg.id);
    if (!planned) continue;
    const path = join(planned.path, 'CHANGELOG.md');
    paths.set(path, [...(paths.get(path) ?? []), pkg]);
  }
  const ancestors = new Map(
    (await git(context, 'rev-list', '--topo-order', planning.plan.head))
      .split('\n')
      .map((head, index) => [head, index]),
  );
  const changes: ChangelogChange[] = [];
  for (const [path, packages] of paths) {
    const before = await readReleaseFile(context.cwd ?? process.cwd(), path);
    if (before !== (await readGitFile(context, planning.plan.head, path)))
      releaseError(
        'Changelog differs from committed source history.',
        'EWORKSPACEDIRTY',
      );
    const origin = changelogOrigin(path, planning, ancestors);
    let base = before ?? '';
    const previous = origin?.planning?.releaseNotes?.changelogs.find(
      (change) => change.path === path,
    );
    if (origin?.execution && previous && before === previous.before) {
      const route = origin.planning?.plan.release;
      const ref = refFor(
        origin.head,
        undefined,
        route ? digest(JSON.stringify(route)) : undefined,
      );
      if (
        (await fetchRef(context, ref)) !== origin.execution.prepared ||
        (await readGitFile(context, origin.head, path)) !== previous.before ||
        (await readGitFile(context, origin.execution.prepared, path)) !==
          previous.after
      )
        releaseError(
          'The previous changelog snapshot is missing or corrupt.',
          'EWORKSPACEARTIFACT',
        );
      base = previous.after;
    }
    const header = /^(#[ \t][^\n]*(?:\r?\n)+)/.exec(base)?.[0];
    const entries = packages
      .map(
        (pkg) =>
          `## ${pkg.id}@${pkg.version} (${notes.date})\n\nChannel: \`${pkg.channel ?? 'default'}\`\n\n${pkg.notes}`,
      )
      .join('\n\n');
    changes.push({
      path,
      before,
      after: `${header ?? '# Changelog\n\n'}${entries}\n\n${header ? base.slice(header.length) : base}`,
    });
  }
  return changes;
}
