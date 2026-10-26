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
type ChangelogOrigin = { journal: Journal; change: ChangelogChange };
const title = /^(#[ \t][^\n]*(?:\r?\n)+)/;

function changelogOrigins(
  path: string,
  planning: Planning,
  ancestors: Map<string, number>,
): { origins: ChangelogOrigin[]; history: ChangelogOrigin[] } {
  const origins: ChangelogOrigin[] = [];
  const history: ChangelogOrigin[] = [];
  for (const pkg of planning.plan.packages.filter(
    (entry) => join(entry.path, 'CHANGELOG.md') === path,
  )) {
    const current = pkg.currentVersion;
    if (!current) continue;
    let selected: ChangelogOrigin | undefined;
    let selectedVersion: string | undefined;
    for (const entry of planning.current.history) {
      const previousPackage = entry.planning?.plan.packages.find(
        (old) => old.id === pkg.id,
      );
      const change = previousPackage
        ? entry.planning?.releaseNotes?.changelogs.find(
            (change) =>
              change.path === join(previousPackage.path, 'CHANGELOG.md'),
          )
        : undefined;
      if (!entry.execution || !ancestors.has(entry.head) || !change) continue;
      const version = previousPackage?.nextVersion;
      if (!version || !lte(version, current)) continue;
      const pre = prerelease(version);
      if (
        pre &&
        (!prerelease(current) ||
          pre.slice(0, -1).join('.') !==
            prerelease(current)?.slice(0, -1).join('.'))
      )
        continue;
      history.push({ journal: entry, change });
      if (!selectedVersion || gt(version, selectedVersion)) {
        selected = { journal: entry, change };
        selectedVersion = version;
      }
    }
    if (selected) origins.push(selected);
  }
  const unique = new Map<string, ChangelogOrigin>();
  for (const origin of origins.sort(
    (a, b) =>
      (ancestors.get(a.journal.head) ?? 0) -
      (ancestors.get(b.journal.head) ?? 0),
  ))
    if (!unique.has(origin.change.path)) unique.set(origin.change.path, origin);
  return { origins: [...unique.values()], history };
}

async function verifyChangelog(
  context: VerifyConditionsContext,
  { journal, change }: ChangelogOrigin,
): Promise<void> {
  const route = journal.planning?.plan.release;
  const ref = refFor(
    journal.head,
    undefined,
    route ? digest(JSON.stringify(route)) : undefined,
  );
  if (
    !journal.execution ||
    (await fetchRef(context, ref)) !== journal.execution.prepared ||
    (await readGitFile(context, journal.head, change.path)) !== change.before ||
    (await readGitFile(context, journal.execution.prepared, change.path)) !==
      change.after
  )
    releaseError(
      'The previous changelog snapshot is missing or corrupt.',
      'EWORKSPACEARTIFACT',
    );
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
    let base = before ?? '';
    const retained = new Set<string>();
    const { origins, history } = changelogOrigins(path, planning, ancestors);
    for (const origin of origins) {
      if (before !== origin.change.before) continue;
      await verifyChangelog(context, origin);
      retained.add(origin.change.after);
    }
    const bodies = [...retained];
    if (bodies[0]) base = bodies[0];
    for (const snapshot of bodies.slice(1)) {
      const body = snapshot.replace(title, '');
      // Only complete archived histories identify shared suffixes; notes remain opaque.
      const common = history
        .map((origin) => ({
          origin,
          body: origin.change.after.replace(title, ''),
        }))
        .filter(
          (entry) =>
            entry.body &&
            base.endsWith(entry.body) &&
            body.endsWith(entry.body),
        )
        .sort((a, b) => b.body.length - a.body.length)[0];
      if (common) {
        await verifyChangelog(context, common.origin);
        base = `${base.slice(0, -common.body.length)}${body.slice(0, -common.body.length)}${common.body}`;
      } else base = `${base}\n\n${body}`;
    }
    const header = title.exec(base)?.[0];
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
