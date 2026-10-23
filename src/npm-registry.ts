import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import npmAgent from '@npmcli/agent';
import Config from '@npmcli/config';
import npmDefinitions from '@npmcli/config/lib/definitions/index.js';
import npmPublish from 'libnpmpublish';
import npmFetch from 'npm-registry-fetch';
import type { VerifyConditionsContext } from 'semantic-release';
import { archiveFile } from './archive.js';
import type { PackagePlan } from './plan-types.js';
import type { Destination } from './publication-state.js';
import { releaseError } from './release-io.js';
import { record } from './workspace-files.js';

async function options(
  context: VerifyConditionsContext,
  dest: Destination,
  name: string,
) {
  try {
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
): Promise<string | null> {
  const opts = await options(context, dest, pkg.name);
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
    return entry.dist.integrity;
  } catch (error) {
    if (record(error) && error.statusCode === 404) return null;
    return releaseError(
      'Cannot verify the npm registry version. Check registry connectivity, redirects and credentials.',
    );
  }
}
export async function npmUpload(
  context: VerifyConditionsContext,
  dest: Destination,
  bytes: Buffer,
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
    await npmPublish.publish(
      manifest,
      bytes,
      await options(context, dest, manifest.name),
    );
  } catch {
    return releaseError(
      'npm registry rejected the artifact. Check registry access and redirects; retry this batch after resolving the failure.',
    );
  }
}
