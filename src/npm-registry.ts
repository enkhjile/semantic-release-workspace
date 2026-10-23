import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import npmAgent from '@npmcli/agent';
import Config from '@npmcli/config';
import npmDefinitions from '@npmcli/config/lib/definitions/index.js';
import npmPublish from 'libnpmpublish';
import npmFetch from 'npm-registry-fetch';
import type { VerifyConditionsContext } from 'semantic-release';
import { archiveFile } from './archive.js';
import { hasIdentity, publishingOptions } from './npm-identity.js';
import { provenanceBundle, sigstorePolicy } from './npm-provenance.js';
import type { PackagePlan } from './plan-types.js';
import type { Destination } from './publication-state.js';
import { releaseError } from './release-io.js';
import { record } from './workspace-files.js';

export async function npmConfiguration(context: VerifyConditionsContext) {
  const config = new Config({
    ...npmDefinitions,
    npmPath: dirname(
      fileURLToPath(import.meta.resolve('@npmcli/config/package.json')),
    ),
    argv: [],
    cwd: context.cwd ?? process.cwd(),
    env: context.env ?? process.env,
  });
  await config.load();
  return config;
}

async function options(
  context: VerifyConditionsContext,
  dest: Destination,
  name: string,
) {
  try {
    const config = await npmConfiguration(context);
    const flat = config.flat;
    const scope = name.startsWith('@') ? name.split('/')[0] : undefined;
    const auth = npmFetch.getAuth(dest.registry, flat);
    const transport = {
      ...flat,
      proxy: flat.httpsProxy ?? flat.proxy,
      cert: auth.cert || flat.cert,
      key: auth.key || flat.key,
      rejectUnauthorized: flat.strictSSL !== false,
    };
    return {
      ...flat,
      registry: dest.registry,
      ...(scope ? { [`${scope}:registry`]: dest.registry } : {}),
      defaultTag: dest.tag ?? 'latest',
      access: dest.access ?? null,
      fetchRetries: 0,
      retry: { retries: 0 },
      timeout: 30_000,
      cache: false,
      preferOnline: true,
      provenance: false,
      provenanceFile: undefined,
      // npm-registry-fetch does not forward redirect:error. Its transport invokes
      // this callback for every request, including redirects, before sending headers.
      agent: (target: { href: string }) => {
        const next = new URL(target.href);
        if (
          next.origin !== new URL(dest.registry).origin ||
          next.username ||
          next.password
        )
          return releaseError(
            'Registry redirect left the frozen origin.',
            'EWORKSPACEREDIRECT',
          );
        return npmAgent.getAgent(next, transport);
      },
    };
  } catch {
    return releaseError(
      'Cannot load npm registry configuration.',
      'EWORKSPACECONFIG',
    );
  }
}
export async function npmProbe(
  context: VerifyConditionsContext,
  dest: Destination,
  pkg: PackagePlan,
  metadata?: unknown,
): Promise<string | null> {
  const opts = await options(context, dest, pkg.name);
  let foundVersion = false;
  try {
    const data: unknown = await npmFetch.json(
      `${dest.registry}/${encodeURIComponent(pkg.name)}`,
      opts,
    );
    if (!record(data) || !record(data.versions))
      return releaseError('Invalid npm registry metadata.');
    if (!Object.hasOwn(data.versions, pkg.nextVersion ?? '')) return null;
    const entry = data.versions[pkg.nextVersion ?? ''];
    if (
      !record(entry) ||
      !record(entry.dist) ||
      typeof entry.dist.integrity !== 'string'
    )
      return releaseError('Published npm version has no integrity proof.');
    foundVersion = true;
    const bundle = provenanceBundle(metadata);
    if (bundle) {
      if (
        !record(entry.dist.attestations) ||
        typeof entry.dist.attestations.url !== 'string'
      )
        throw new Error();
      const url = new URL(entry.dist.attestations.url);
      if (
        url.origin !== new URL(dest.registry).origin ||
        url.username ||
        url.password
      )
        throw new Error();
      const proof: unknown = await npmFetch.json(url.href, opts);
      if (
        !record(proof) ||
        !Array.isArray(proof.attestations) ||
        !proof.attestations.some(
          (value) => record(value) && isDeepStrictEqual(value.bundle, bundle),
        )
      )
        throw new Error();
    }
    return entry.dist.integrity;
  } catch (error) {
    if (!foundVersion && record(error) && error.statusCode === 404) return null;
    return releaseError(
      'Cannot verify the npm registry version. Check registry connectivity, redirects and credentials.',
    );
  }
}
export async function npmVisibility(
  context: VerifyConditionsContext,
  dest: Destination,
  name: string,
): Promise<boolean> {
  if (
    dest.access === 'public' ||
    (!name.startsWith('@') && dest.access !== 'restricted')
  )
    return true;
  if (dest.access === 'restricted') return false;
  try {
    const data: unknown = await npmFetch.json(
      `${dest.registry}/-/package/${encodeURIComponent(name)}/visibility`,
      await options(context, dest, name),
    );
    return record(data) && data.public === true;
  } catch (error) {
    if (record(error) && error.statusCode === 404) return false;
    return releaseError(
      'Cannot verify npm package visibility.',
      'EWORKSPACEPROVENANCE',
    );
  }
}
export async function npmUpload(
  context: VerifyConditionsContext,
  dest: Destination,
  bytes: Buffer,
  metadata: unknown,
): Promise<void> {
  try {
    const manifest: unknown = JSON.parse(
      await archiveFile(bytes, 'package/package.json'),
    );
    if (!record(manifest) || typeof manifest.name !== 'string')
      return releaseError(
        'Invalid npm artifact manifest.',
        'EWORKSPACEARTIFACT',
      );
    const opts = await publishingOptions(
      context,
      dest,
      manifest.name,
      await options(context, dest, manifest.name),
    );
    const bundle = provenanceBundle(metadata);
    if (!bundle) {
      await npmPublish.publish(manifest, bytes, opts);
      return;
    }
    const name = manifest.name;
    const version = String(manifest.version);
    const tarballName = `${name}-${version}.tgz`;
    const serialized = JSON.stringify(bundle);
    const dist = {
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      tarball: `${dest.registry}/${name}/-/${tarballName}`,
    };
    await npmFetch(`${dest.registry}/${encodeURIComponent(name)}`, {
      ...opts,
      method: 'PUT',
      ignoreBody: true,
      body: {
        _id: name,
        name,
        description: manifest.description,
        access: dest.access ?? null,
        'dist-tags': { [dest.tag ?? 'latest']: version },
        versions: {
          [version]: {
            ...manifest,
            _id: `${name}@${version}`,
            _nodeVersion: process.versions.node,
            dist,
          },
        },
        _attachments: {
          [tarballName]: {
            content_type: 'application/octet-stream',
            data: bytes.toString('base64'),
            length: bytes.length,
          },
          [`${name}-${version}.sigstore`]: {
            content_type: bundle.mediaType,
            data: serialized,
            length: Buffer.byteLength(serialized),
          },
        },
      },
    });
  } catch (error) {
    if (record(error) && error.code === 'EWORKSPACEOIDC') throw error;
    return releaseError(
      'npm registry rejected the artifact. Check registry access and redirects; retry this batch after resolving the failure.',
    );
  }
}

export async function npmPolicy(
  context: VerifyConditionsContext,
  options: Record<string, unknown>,
  publish: Record<string, unknown>,
  previous?: Destination,
): Promise<Pick<Destination, 'npmAuth' | 'provenance' | 'sigstore'>> {
  const auth = options.trustedPublishing ?? 'auto';
  if (![true, false, 'auto'].includes(auth as boolean | string))
    return releaseError(
      'npm.trustedPublishing must be true, false or auto.',
      'EWORKSPACECONFIG',
    );
  const config = await npmConfiguration(context);
  const provenance =
    options.provenance ??
    publish.provenance ??
    (config.isDefault('provenance') ? 'auto' : config.flat.provenance);
  if (![true, false, 'auto'].includes(provenance as boolean | string))
    return releaseError(
      'npm.provenance must be true, false or auto.',
      'EWORKSPACECONFIG',
    );
  const oidc =
    auth === true ||
    (auth === 'auto' &&
      (previous
        ? previous.npmAuth === 'oidc'
        : hasIdentity(context.env ?? process.env)));
  const sigstore = await sigstorePolicy(context, options.sigstore);
  return {
    ...(sigstore ? { sigstore } : {}),
    ...(oidc ? { npmAuth: 'oidc' as const } : {}),
    ...(provenance === true ||
    (provenance === 'auto' && oidc && (!previous || previous.provenance))
      ? { provenance: provenance as true | 'auto' }
      : {}),
  };
}

export async function npmSetChannel(
  context: VerifyConditionsContext,
  dest: Destination,
  name: string,
  version: string,
): Promise<void> {
  const opts = await options(context, dest, name);
  const endpoint = `${dest.registry}/-/package/${encodeURIComponent(name)}/dist-tags`;
  const read = async () => {
    try {
      const data: unknown = await npmFetch.json(endpoint, opts);
      if (
        !record(data) ||
        Object.values(data).some((value) => typeof value !== 'string')
      )
        throw new Error();
      return data[dest.tag ?? 'latest'];
    } catch {
      return releaseError(
        'Cannot verify npm distribution channel. Check registry access and redirects.',
      );
    }
  };
  if ((await read()) === version) return;
  let failure: unknown;
  try {
    await npmFetch(`${endpoint}/${encodeURIComponent(dest.tag ?? 'latest')}`, {
      ...(await publishingOptions(context, dest, name, opts)),
      method: 'PUT',
      body: JSON.stringify(version),
      headers: { 'content-type': 'application/json' },
      ignoreBody: true,
    });
  } catch (error) {
    failure = error;
  }
  if ((await read()) !== version) {
    if (record(failure) && failure.code === 'EWORKSPACEOIDC') throw failure;
    releaseError(
      'npm channel update could not be confirmed. Check dist-tag permissions and retry the same promotion.',
    );
  }
}
