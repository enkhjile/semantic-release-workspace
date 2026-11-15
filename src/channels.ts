import type {
  GenerateNotesContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { gt, prerelease, valid } from 'semver';
import { assertPendingBranches, npmChannel } from './branches.js';
import { discoverWorkspaces } from './discovery.js';
import { executeGit, git, type Journal, snapshot } from './journal.js';
import { verifyProvenance } from './npm-provenance.js';
import { npmSetChannel } from './npm-registry.js';
import type { PackageVersion } from './plan-types.js';
import { oid } from './plan-validation.js';
import { publishing } from './publication.js';
import { destination, probe, validateArtifact } from './registries.js';
import {
  digest,
  fetchRef,
  readArtifact,
  refFor,
  releaseError,
} from './release-io.js';
import { notesForPromotion } from './release-notes.js';
import { record } from './workspace-files.js';

interface Promotion {
  schemaVersion: 1;
  branch: string;
  head: string;
  batchTag: string;
  channel: string;
  status: 'pending' | 'complete';
  versions?: PackageVersion[];
}
function publicVersions(source: Journal): PackageVersion[] {
  return (
    source.planning?.versions.filter((version) =>
      source.planning?.plan.packages.some(
        (pkg) => pkg.id === version.id && !pkg.private,
      ),
    ) ?? []
  );
}
function validVersions(value: unknown): value is PackageVersion[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        record(entry) &&
        typeof entry.id === 'string' &&
        /^(?:npm|cargo):\S+$/.test(entry.id) &&
        typeof entry.version === 'string' &&
        valid(entry.version) === entry.version &&
        oid(entry.head),
    ) &&
    new Set(value.map((entry: PackageVersion) => entry.id)).size ===
      value.length
  );
}
const promotionRef = (context: VerifyConditionsContext) =>
  `refs/notes/workspace-release-channels/${digest(context.branch.name)}`;
async function save(context: VerifyConditionsContext, promotion: Promotion) {
  const ref = promotionRef(context);
  const anchor = await git(context, 'rev-list', '--max-parents=0', 'HEAD');
  await executeGit(
    context,
    ['notes', `--ref=${ref}`, 'add', '-f', '-F', '-', anchor],
    JSON.stringify(promotion),
  );
  await git(
    context,
    'push',
    '--',
    context.options.repositoryUrl ?? '',
    `${ref}:${ref}`,
  );
}
export async function promotionSource(context: GenerateNotesContext) {
  return (await snapshot(context)).history.find(
    (entry) =>
      entry.batchTag === context.nextRelease.gitTag &&
      entry.branch !== context.branch.name,
  );
}
export async function planPromotion(
  config: Record<string, unknown>,
  context: GenerateNotesContext,
): Promise<string | undefined> {
  const source = await promotionSource(context);
  if (!source) {
    if (await git(context, 'tag', '--list', context.nextRelease.gitTag))
      releaseError(
        'Completed workspace history is required before promoting an existing batch tag.',
        'EWORKSPACEJOURNAL',
      );
    return undefined;
  }
  assertPendingBranches(context, (await snapshot(context)).reservations);
  if (source.execution && !publishing(config))
    releaseError(
      'Restore publication configuration to promote published packages.',
      'EWORKSPACEPLAN',
    );
  if (publishing(config) && !source.execution && publicVersions(source).length)
    releaseError(
      'Completed publication history is required for channel promotion.',
      'EWORKSPACEJOURNAL',
    );
  const head = await git(context, 'rev-parse', 'HEAD');
  const channel = npmChannel(context.branch.channel);
  const retained = await readPromotion(context);
  const promotion: Promotion =
    retained?.versions !== undefined &&
    retained.branch === context.branch.name &&
    retained.head === head &&
    retained.batchTag === source.batchTag &&
    retained.channel === channel
      ? retained
      : {
          schemaVersion: 1,
          branch: context.branch.name,
          head,
          batchTag: source.batchTag,
          channel,
          status: 'pending',
        };
  if (source.execution) {
    // Persist intent before semantic-release records the batch channel. It will not
    // call addChannel again after that note has been pushed, even if the plugin fails.
    await applyPromotion(config, context, promotion, true);
    if (!context.options.dryRun && promotion.status === 'pending')
      await save(context, promotion);
  }
  return notesForPromotion(
    context,
    source,
    (await snapshot(context)).history,
    promotion.versions,
  );
}
async function applyPromotion(
  config: Record<string, unknown>,
  context: VerifyConditionsContext,
  promotion: Promotion,
  inspect = false,
) {
  if (!publishing(config))
    releaseError(
      'Restore publication configuration before retrying channel promotion.',
      'EWORKSPACEPLAN',
    );
  if (
    promotion.branch !== context.branch.name ||
    promotion.channel !== npmChannel(context.branch.channel) ||
    promotion.head !== (await git(context, 'rev-parse', 'HEAD'))
  )
    releaseError(
      'Pending channel promotion changed. Retry its source and channel.',
      'EWORKSPACEPLAN',
    );
  const current = await snapshot(context);
  const source = current.history.find(
    (entry) => entry.batchTag === promotion.batchTag,
  );
  if (!source?.planning || !source.execution)
    releaseError(
      'Completed publication history is required for channel promotion.',
      'EWORKSPACEJOURNAL',
    );
  await git(context, 'merge-base', '--is-ancestor', source.head, current.head);
  const ancestors = new Set(
    (await git(context, 'rev-list', promotion.head)).split('\n'),
  );
  const sourceVersions = publicVersions(source);
  const freeze = promotion.versions === undefined;
  if (freeze)
    promotion.versions = sourceVersions.map((version) => {
      let selected = version;
      for (const entry of current.history) {
        if (!ancestors.has(entry.head) || !entry.execution) continue;
        const pkg = entry.planning?.plan.packages.find(
          (pkg) => pkg.id === version.id && !pkg.private,
        );
        if (
          pkg?.nextVersion &&
          !prerelease(pkg.nextVersion) &&
          gt(pkg.nextVersion, selected.version) &&
          entry.execution.packages.some(
            (pkg) => pkg.id === version.id && pkg.tagged,
          )
        )
          selected = {
            id: version.id,
            version: pkg.nextVersion,
            head: entry.head,
          };
      }
      return selected;
    });
  if (
    !validVersions(promotion.versions) ||
    JSON.stringify(promotion.versions.map((version) => version.id).sort()) !==
      JSON.stringify(sourceVersions.map((version) => version.id).sort())
  )
    releaseError('Invalid channel promotion versions.', 'EWORKSPACEJOURNAL');
  const inventory = await discoverWorkspaces(context.cwd ?? process.cwd());
  const entries = [];
  for (const version of promotion.versions) {
    if (
      !ancestors.has(version.head) ||
      prerelease(version.version) ||
      sourceVersions.some(
        (source) =>
          source.id === version.id && gt(source.version, version.version),
      )
    )
      releaseError(
        'Invalid channel promotion version origin.',
        'EWORKSPACEJOURNAL',
      );
    const origin = current.history.find(
      (entry) =>
        entry.head === version.head &&
        entry.execution &&
        entry.planning?.plan.packages.some(
          (pkg) => pkg.id === version.id && pkg.nextVersion === version.version,
        ),
    );
    const pkg = origin?.planning?.plan.packages.find(
      (pkg) => pkg.id === version.id,
    );
    const publication = origin?.execution?.packages.find(
      (entry) => entry.id === version.id,
    );
    if (
      !pkg ||
      !publication?.artifact ||
      !publication.tagged ||
      !origin?.execution
    )
      releaseError(
        'Promotion artifact history is incomplete.',
        'EWORKSPACEARTIFACT',
      );
    const route = origin.planning?.plan.release;
    const scope = route ? digest(JSON.stringify(route)) : undefined;
    if (
      publication.artifact.ref !== refFor(origin.head, version.id, scope) ||
      (await fetchRef(context, refFor(origin.head, undefined, scope))) !==
        origin.execution.prepared
    )
      releaseError(
        'Promotion artifact does not belong to its original release.',
        'EWORKSPACEARTIFACT',
      );
    const artifact = await readArtifact(context, publication.artifact);
    if (
      (await git(context, 'rev-parse', `${publication.artifact.commit}^`)) !==
      origin.execution.prepared
    )
      releaseError(
        'Promotion artifact does not belong to its original release.',
        'EWORKSPACEARTIFACT',
      );
    const discovered = inventory.packages.find(
      (entry) => `${entry.ecosystem}:${entry.name}` === version.id,
    );
    if (!discovered)
      releaseError(
        'Promoted package is missing from the workspace.',
        'EWORKSPACEPLAN',
      );
    const resolved = await destination(
      context,
      config,
      discovered,
      publication.destination,
    );
    const dest = publication.destination;
    if (
      resolved.registry !== dest.registry ||
      resolved.index !== dest.index ||
      resolved.access !== dest.access ||
      resolved.npmAuth !== dest.npmAuth ||
      resolved.cargoAuth !== dest.cargoAuth
    )
      releaseError(
        'Promotion registry or authentication policy changed.',
        'EWORKSPACEPLAN',
      );
    await validateArtifact(dest, pkg, artifact.bytes, artifact.metadata);
    if (dest.ecosystem === 'npm')
      await verifyProvenance(
        context,
        dest,
        pkg,
        artifact.bytes,
        artifact.metadata,
        origin.head,
      );
    const expected =
      dest.ecosystem === 'npm'
        ? publication.artifact.integrity
        : publication.artifact.sha256;
    if ((await probe(context, dest, pkg, artifact.metadata)) !== expected)
      releaseError(
        'Promoted registry version differs from its retained artifact.',
        'EWORKSPACECONFLICT',
      );
    entries.push({ pkg, dest });
  }
  // Verify every package before moving any channel.
  if (inspect || context.options.dryRun) return;
  // Legacy pending promotions acquire their fixed selection before any writes.
  if (freeze) await save(context, promotion);
  for (const { pkg, dest } of entries)
    if (dest.ecosystem === 'npm')
      await npmSetChannel(
        context,
        { ...dest, tag: promotion.channel },
        pkg.name,
        pkg.nextVersion as string,
      );
  promotion.status = 'complete';
  await save(context, promotion);
}
async function readPromotion(
  context: VerifyConditionsContext,
): Promise<Promotion | undefined> {
  const ref = promotionRef(context);
  if (!(await fetchRef(context, ref))) return;
  const anchor = await git(context, 'rev-list', '--max-parents=0', 'HEAD');
  let value: unknown;
  try {
    value = JSON.parse(
      await git(context, 'notes', `--ref=${ref}`, 'show', anchor),
    );
  } catch {
    releaseError('Invalid channel promotion journal.', 'EWORKSPACEJOURNAL');
  }
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.branch !== 'string' ||
    !oid(value.head) ||
    typeof value.batchTag !== 'string' ||
    !/^workspace-v\d+\.\d+\.\d+$/.test(value.batchTag) ||
    typeof value.channel !== 'string' ||
    (value.versions !== undefined && !validVersions(value.versions)) ||
    !['pending', 'complete'].includes(String(value.status))
  )
    releaseError('Invalid channel promotion journal.', 'EWORKSPACEJOURNAL');
  return value as unknown as Promotion;
}
export async function recoverChannels(
  config: Record<string, unknown>,
  context: VerifyConditionsContext,
): Promise<void> {
  const promotion = await readPromotion(context);
  if (promotion?.status === 'pending')
    await applyPromotion(config, context, promotion);
}
