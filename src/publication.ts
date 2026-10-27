import type { VerifyConditionsContext } from 'semantic-release';
import { createCargoIdentity, hasCargoIdentity } from './cargo-identity.js';
import { discoverWorkspaces } from './discovery.js';
import { git, gitOutput, snapshot, writeJournal } from './journal.js';
import {
  applyManifests,
  type ManifestChange,
  manifestChanges,
  readReleaseFile,
} from './manifests.js';
import { hasIdentity } from './npm-identity.js';
import {
  validateProvenanceContext,
  verifyProvenance,
} from './npm-provenance.js';
import type { PlanningState } from './plan-types.js';
import type { Execution, PublicationPackage } from './publication-state.js';
import {
  completeCargoDestination,
  destination,
  pack,
  probe,
  upload,
  validateArtifact,
} from './registries.js';
import {
  command,
  fetchRef,
  preparedCommit,
  readArtifact,
  readGitFile,
  refFor,
  releaseError,
  releaseScope,
  retainArtifact,
} from './release-io.js';
import { notesForRelease } from './release-notes.js';
import { record } from './workspace-files.js';

type Planning = PlanningState & {
  current: Awaited<ReturnType<typeof snapshot>>;
};
export function publishing(config: Record<string, unknown>): boolean {
  if (config.publish !== undefined && typeof config.publish !== 'boolean')
    return releaseError('publish must be a boolean.', 'EWORKSPACECONFIG');
  return config.publish !== false;
}
export function npmVisibilityTimeout(config: Record<string, unknown>): number {
  const options = config.npm;
  if (options !== undefined && !record(options))
    return releaseError('npm must be an object.', 'EWORKSPACECONFIG');
  const timeout =
    options?.visibilityTimeout === undefined
      ? 300_000
      : options.visibilityTimeout;
  if (
    !Number.isSafeInteger(timeout) ||
    typeof timeout !== 'number' ||
    timeout < 0
  )
    return releaseError(
      'npm.visibilityTimeout must be a nonnegative integer in milliseconds.',
      'EWORKSPACECONFIG',
    );
  return timeout;
}
function tagName(id: string, version: string): string {
  return `${id.replace(':', '/')}@${version}`;
}
async function tags(
  context: VerifyConditionsContext,
  state: Execution,
  planning: PlanningState,
  create = false,
) {
  for (const entry of state.packages) {
    const pkg = planning.plan.packages.find((pkg) => pkg.id === entry.id);
    if (!pkg?.nextVersion)
      return releaseError(
        'Publication state does not match its plan.',
        'EWORKSPACEJOURNAL',
      );
    const tag = tagName(pkg.id, pkg.nextVersion);
    await git(context, 'check-ref-format', `refs/tags/${tag}`);
    const remote = await git(
      context,
      'ls-remote',
      '--refs',
      '--',
      context.options.repositoryUrl ?? '',
      `refs/tags/${tag}`,
    );
    const local = await git(context, 'tag', '--list', tag);
    if (
      (remote && remote.split(/\s/)[0] !== state.prepared) ||
      (local &&
        (await git(context, 'rev-parse', `refs/tags/${tag}^{commit}`)) !==
          state.prepared)
    )
      return releaseError(
        `Package tag already points elsewhere: ${tag}.`,
        'EWORKSPACETAG',
      );
    if (!remote && entry.tagged) entry.tagged = false;
    if (create && entry.published && !entry.tagged) {
      if (!local) await git(context, 'tag', tag, state.prepared);
      await git(
        context,
        'push',
        '--',
        context.options.repositoryUrl ?? '',
        `refs/tags/${tag}:refs/tags/${tag}`,
      );
      entry.tagged = true;
    }
  }
}
export async function preflight(
  config: Record<string, unknown>,
  context: VerifyConditionsContext,
  planning: Planning,
): Promise<PublicationPackage[]> {
  if (!publishing(config)) {
    if (
      planning.current.journal?.status === 'pending' &&
      planning.current.journal.execution
    )
      return releaseError(
        'Publication is pending; restore publish configuration before retrying.',
        'EWORKSPACEPLAN',
      );
    return [];
  }
  if (
    planning.plan.groups.some(
      (group) =>
        group.length > 1 && group.some((id) => id.startsWith('cargo:')),
    )
  )
    return releaseError(
      'Cyclic Cargo releases cannot be published. Break the cycle before releasing.',
      'EWORKSPACEDEPENDENCY',
    );
  const inventory = await discoverWorkspaces(context.cwd ?? process.cwd());
  const result: PublicationPackage[] = [];
  for (const pkg of planning.plan.packages.filter(
    (entry) => entry.nextVersion && !entry.private,
  )) {
    const source = inventory.packages.find(
      (entry) => `${entry.ecosystem}:${entry.name}` === pkg.id,
    );
    if (!source)
      return releaseError('Discovered packages changed.', 'EWORKSPACEPLAN');
    result.push({
      id: pkg.id,
      destination: await destination(
        context,
        config,
        source,
        planning.current.journal?.status === 'pending'
          ? planning.current.journal.execution?.packages.find(
              (entry) => entry.id === pkg.id,
            )?.destination
          : undefined,
      ),
      intent: false,
      published: false,
      tagged: false,
    });
  }
  for (const entry of result) {
    const retained =
      planning.current.journal?.status === 'pending' &&
      planning.current.journal.execution?.packages.find(
        (pkg) => pkg.id === entry.id,
      )?.artifact;
    if (retained) continue;
    if (
      entry.destination.npmAuth === 'oidc' &&
      !hasIdentity(context.env ?? process.env)
    )
      return releaseError(
        'npm trusted publishing requires a supported CI identity and id-token permissions.',
        'EWORKSPACEOIDC',
      );
    if (
      entry.destination.cargoAuth === 'oidc' &&
      !hasCargoIdentity(context.env ?? process.env)
    )
      return releaseError(
        'Cargo trusted publishing requires GitHub Actions identity permissions or a GitLab CRATES_IO_ID_TOKEN.',
        'EWORKSPACEOIDC',
      );
    if (entry.destination.ecosystem === 'npm')
      validateProvenanceContext(context, entry.destination, planning.plan.head);
  }
  return result;
}
async function retainedArtifacts(
  context: VerifyConditionsContext,
  planning: Planning,
  execution: Execution,
) {
  const retained = new Map<string, Awaited<ReturnType<typeof readArtifact>>>();
  for (const entry of execution.packages) {
    if (!entry.artifact) continue;
    const pkg = planning.plan.packages.find((pkg) => pkg.id === entry.id);
    if (
      !pkg ||
      entry.artifact.ref !==
        refFor(planning.plan.head, entry.id, releaseScope(context))
    )
      return releaseError(
        'Retained artifact belongs to a different release.',
        'EWORKSPACEARTIFACT',
      );
    const artifact = await readArtifact(context, entry.artifact);
    if (
      (await git(context, 'rev-parse', `${entry.artifact.commit}^`)) !==
      execution.prepared
    )
      return releaseError(
        'Retained artifact parent does not match this release.',
        'EWORKSPACEARTIFACT',
      );
    await validateArtifact(
      entry.destination,
      pkg,
      artifact.bytes,
      artifact.metadata,
    );
    if (entry.destination.ecosystem === 'npm')
      await verifyProvenance(
        context,
        entry.destination,
        pkg,
        artifact.bytes,
        artifact.metadata,
        planning.plan.head,
      );
    retained.set(entry.id, artifact);
  }
  return retained;
}
export async function preparePublication(
  config: Record<string, unknown>,
  context: VerifyConditionsContext,
  planning: Planning,
  batchTag: string,
): Promise<void> {
  const entries = await preflight(config, context, planning);
  planning.releaseNotes = await notesForRelease(
    config,
    context,
    planning,
    entries,
  );
  const changes = [
    ...(await manifestChanges(context.cwd ?? process.cwd(), planning.plan)),
    ...planning.releaseNotes.changelogs,
  ];
  const prepared = await preparedCommit(context, planning.plan.head, changes);
  for (const entry of entries)
    if (entry.destination.ecosystem === 'cargo')
      entry.destination = await completeCargoDestination(
        context,
        entry.destination,
      );
  let execution: Execution = { prepared, packages: entries };
  const previous =
    planning.current.journal?.status === 'pending'
      ? planning.current.journal.execution
      : undefined;
  if (previous) {
    if (
      previous.prepared !== prepared ||
      JSON.stringify(
        previous.packages.map(({ id, destination }) => ({ id, destination })),
      ) !==
        JSON.stringify(
          entries.map(({ id, destination }) => ({ id, destination })),
        )
    )
      return releaseError(
        'The pending publication destinations or prepared manifests changed.',
        'EWORKSPACEPLAN',
      );
    execution = previous;
  }
  await tags(context, execution, planning);
  const retained = await retainedArtifacts(context, planning, execution);
  // A foreign version should be rejected before starting an irreversible batch.
  for (const entry of execution.packages) {
    const pkg = planning.plan.packages.find((pkg) => pkg.id === entry.id);
    if (!pkg)
      return releaseError(
        'Publication package is missing from its plan.',
        'EWORKSPACEJOURNAL',
      );
    const found = await probe(
      context,
      entry.destination,
      pkg,
      retained.get(entry.id)?.metadata,
    );
    const expected =
      entry.destination.ecosystem === 'npm'
        ? entry.artifact?.integrity
        : entry.artifact?.sha256;
    if (
      (found !== null && (!entry.intent || found !== expected)) ||
      (found === null && entry.published)
    )
      return releaseError(
        `Registry version conflicts with this batch: ${pkg.id}@${pkg.nextVersion}.`,
        'EWORKSPACECONFLICT',
      );
  }
  await writeJournal(
    context,
    planning.current,
    'pending',
    batchTag,
    planning,
    execution,
  );
}
export async function publishPackages(
  config: Record<string, unknown>,
  context: VerifyConditionsContext,
  planning: Planning,
  batchTag: string,
): Promise<void> {
  const execution = planning.current.journal?.execution;
  if (!execution || planning.current.journal?.status !== 'pending')
    return releaseError(
      'Missing pending publication state.',
      'EWORKSPACEJOURNAL',
    );
  const root = context.cwd ?? process.cwd();
  const inventory = await discoverWorkspaces(root);
  const changes = [
    ...(await manifestChanges(root, planning.plan)),
    ...(planning.releaseNotes?.changelogs ?? []),
  ];
  const persist = () =>
    writeJournal(
      context,
      planning.current,
      'pending',
      batchTag,
      planning,
      execution,
    );
  await tags(context, execution, planning);
  const retained = await retainedArtifacts(context, planning, execution);
  const cargoIdentity = createCargoIdentity(context);
  try {
    await applyManifests(root, changes);
    for (const id of planning.plan.groups.flat()) {
      const entry = execution.packages.find((entry) => entry.id === id);
      const pkg = planning.plan.packages.find((entry) => entry.id === id);
      if (!entry || !pkg) continue;
      if (!entry.artifact) {
        // An artifact ref may have reached the remote just before a process crash.
        const ref = refFor(planning.plan.head, id, releaseScope(context));
        const orphan = await fetchRef(context, ref);
        if (orphan) {
          const bytes = await command(context, 'git', [
            'show',
            `${orphan}:artifact`,
          ]);
          const metadata: unknown = JSON.parse(
            (
              await command(context, 'git', ['show', `${orphan}:metadata.json`])
            ).toString(),
          );
          const created = await retainArtifact(
            context,
            planning.plan.head,
            id,
            execution.prepared,
            bytes,
            metadata,
          );
          if (created.commit !== orphan)
            return releaseError(
              'Artifact does not belong to the prepared release.',
              'EWORKSPACEARTIFACT',
            );
          entry.artifact = created;
        } else {
          const artifact = await pack(
            context,
            entry.destination,
            pkg,
            planning.plan,
            inventory,
            config,
          );
          entry.artifact = await retainArtifact(
            context,
            planning.plan.head,
            id,
            execution.prepared,
            artifact.bytes,
            artifact.metadata,
          );
        }
        await persist();
      }
      if (
        entry.artifact.ref !==
        refFor(planning.plan.head, id, releaseScope(context))
      )
        return releaseError(
          'Retained artifact belongs to a different release.',
          'EWORKSPACEARTIFACT',
        );
      const artifact =
        retained.get(id) ?? (await readArtifact(context, entry.artifact));
      if (
        (await git(context, 'rev-parse', `${entry.artifact.commit}^`)) !==
        execution.prepared
      )
        return releaseError(
          'Retained artifact parent does not match this release.',
          'EWORKSPACEARTIFACT',
        );
      await validateArtifact(
        entry.destination,
        pkg,
        artifact.bytes,
        artifact.metadata,
      );
      if (entry.destination.ecosystem === 'npm')
        await verifyProvenance(
          context,
          entry.destination,
          pkg,
          artifact.bytes,
          artifact.metadata,
          planning.plan.head,
        );
      const expected =
        entry.destination.ecosystem === 'npm'
          ? entry.artifact.integrity
          : entry.artifact.sha256;
      const found = await probe(
        context,
        entry.destination,
        pkg,
        artifact.metadata,
      );
      if (found !== null && (!entry.intent || found !== expected))
        return releaseError(
          `Registry version conflicts with this batch: ${pkg.id}@${pkg.nextVersion}.`,
          'EWORKSPACECONFLICT',
        );
      if (found === null) {
        if (entry.published)
          return releaseError(
            'A previously published package is missing from its registry.',
            'EWORKSPACECONFLICT',
          );
        let failure: unknown;
        if (!entry.acknowledged) {
          entry.intent = true;
          await persist();
          let uploaded = false;
          try {
            await upload(
              context,
              entry.destination,
              artifact.bytes,
              artifact.metadata,
              entry.destination.cargoAuth === 'oidc'
                ? await cargoIdentity.token(entry.destination)
                : undefined,
            );
            uploaded = true;
          } catch (error) {
            failure = error;
          }
          if (uploaded && entry.destination.ecosystem === 'npm') {
            // Record the receipt before waiting so another runner will not upload again.
            entry.acknowledged = true;
            await persist();
          }
        }
        // A successful upload can precede registry visibility; only a matching artifact is proof.
        let confirmed: string | null = null;
        const deadline = performance.now() + npmVisibilityTimeout(config);
        let delay = 250;
        let attempt = 0;
        while (true) {
          confirmed = await probe(
            context,
            entry.destination,
            pkg,
            artifact.metadata,
          );
          if (confirmed !== null) break;
          const remaining = deadline - performance.now();
          if (entry.acknowledged ? remaining <= 0 : attempt >= 4) break;
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              entry.acknowledged ? Math.min(delay, remaining) : delay,
            ),
          );
          delay = Math.min(delay * 2, 10_000);
          attempt++;
        }
        if (confirmed !== expected) {
          if (confirmed !== null)
            return releaseError(
              `Registry version conflicts with this batch: ${pkg.id}@${pkg.nextVersion}.`,
              'EWORKSPACECONFLICT',
            );
          if (failure) throw failure;
          return releaseError(
            `Publication cannot yet be confirmed: ${pkg.id}. Retry this same batch.`,
          );
        }
      }
      entry.published = true;
      await persist();
      await tags(context, execution, planning, true);
      await persist();
      context.logger.log('Published %s@%s.', pkg.id, pkg.nextVersion);
    }
  } finally {
    try {
      await applyManifests(root, changes, true);
    } finally {
      await cargoIdentity.close();
    }
  }
}
export async function recoverManifests(
  context: VerifyConditionsContext,
): Promise<void> {
  const current = await snapshot(context);
  if (current.journal?.status !== 'pending' || !current.journal.execution)
    return;
  const prepared = current.journal.execution.prepared;
  if (
    (await fetchRef(
      context,
      refFor(current.head, undefined, releaseScope(context)),
    )) !== prepared ||
    (await git(context, 'rev-parse', `${prepared}^`)) !== current.head
  )
    return releaseError(
      'Prepared release commit is missing or corrupt.',
      'EWORKSPACEARTIFACT',
    );
  const paths = (
    await gitOutput(
      context,
      'diff',
      '--name-only',
      '-z',
      current.head,
      prepared,
    )
  )
    .split('\0')
    .filter(Boolean);
  const changes: ManifestChange[] = [];
  for (const path of paths) {
    const changelog = current.journal.planning?.releaseNotes?.changelogs.find(
      (change) => change.path === path,
    );
    if (
      (!/(?:^|\/)(?:package.json|Cargo.toml)$/.test(path) && !changelog) ||
      path.split('/').includes('..')
    )
      return releaseError(
        'Prepared commit contains unexpected files.',
        'EWORKSPACEARTIFACT',
      );
    const before = await readGitFile(context, current.head, path);
    const after = await readGitFile(context, prepared, path);
    if (
      after === null ||
      (changelog && (before !== changelog.before || after !== changelog.after))
    )
      return releaseError(
        'Prepared changelog bytes differ from the frozen batch.',
        'EWORKSPACEARTIFACT',
      );
    const actual = await readReleaseFile(context.cwd ?? process.cwd(), path);
    if (actual !== before && actual !== after)
      return releaseError(
        'Checkout contains edits outside the prepared release.',
        'EWORKSPACEDIRTY',
      );
    changes.push({ path, before, after });
  }
  await applyManifests(context.cwd ?? process.cwd(), changes, true);
}
