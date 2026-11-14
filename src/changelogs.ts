import type { VerifyConditionsContext } from 'semantic-release';
import { lte, prerelease } from 'semver';
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
): ChangelogOrigin[] {
  // Root history survives package moves and releases of other members. Legacy
  // member changelogs remain untouched; users can curate them into the root file.
  return planning.current.history
    .flatMap((journal) => {
      const previousPrerelease = journal.planning?.plan.release?.prerelease;
      if (
        previousPrerelease &&
        previousPrerelease !== planning.plan.release?.prerelease
      )
        return [];
      const change = journal.planning?.releaseNotes?.changelogs.find(
        (entry) => entry.path === path,
      );
      if (!journal.execution || !ancestors.has(journal.head) || !change)
        return [];
      const eligible = journal.planning?.plan.packages.every((old) => {
        if (!old.nextVersion || old.private) return true;
        const current = planning.plan.packages.find(
          (pkg) => pkg.id === old.id,
        )?.currentVersion;
        // Removed members still belong in repository history.
        if (!current) return true;
        const pre = prerelease(old.nextVersion);
        return (
          lte(old.nextVersion, current) &&
          (!pre ||
            pre.slice(0, -1).join('.') ===
              prerelease(current)?.slice(0, -1).join('.'))
        );
      });
      return eligible ? [{ journal, change }] : [];
    })
    .sort(
      (a, b) =>
        (ancestors.get(a.journal.head) ?? 0) -
        (ancestors.get(b.journal.head) ?? 0),
    );
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
  const packages = notes.packages.filter((pkg) =>
    planning.plan.packages.some(
      (entry) => entry.id === pkg.id && !entry.private,
    ),
  );
  if (!packages.length) return [];
  const path = 'CHANGELOG.md';
  const ancestors = new Map(
    (await git(context, 'rev-list', '--topo-order', planning.plan.head))
      .split('\n')
      .map((head, index) => [head, index]),
  );
  const before = await readReleaseFile(context.cwd ?? process.cwd(), path);
  if (before !== (await readGitFile(context, planning.plan.head, path)))
    releaseError(
      'Changelog differs from committed source history.',
      'EWORKSPACEDIRTY',
    );
  let base = before ?? '';
  const retained = new Set<string>();
  const origins = changelogOrigins(path, planning, ancestors);
  for (const origin of origins) {
    if (before !== origin.change.before) continue;
    const body = origin.change.after.replace(title, '');
    if ([...retained].some((snapshot) => snapshot.endsWith(body))) continue;
    await verifyChangelog(context, origin);
    retained.add(origin.change.after);
  }
  const bodies = [...retained];
  if (bodies[0]) base = bodies[0];
  for (const snapshot of bodies.slice(1)) {
    const body = snapshot.replace(title, '');
    if (base.endsWith(body)) continue;
    if (body.endsWith(base.replace(title, ''))) {
      base = snapshot;
      continue;
    }
    // Archived before/after snapshots prove shared suffixes; notes remain opaque.
    const common = origins
      .flatMap((origin) =>
        [
          origin.change.after,
          ...(origin.change.before === before && before ? [before] : []),
        ].map((snapshot) => ({
          origin,
          body: snapshot.replace(title, ''),
        })),
      )
      .filter(
        (entry) =>
          entry.body && base.endsWith(entry.body) && body.endsWith(entry.body),
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
  return [
    {
      path,
      before,
      after: `${header ?? '# Changelog\n\n'}${entries}\n\n${header ? base.slice(header.length) : base}`,
    },
  ];
}
