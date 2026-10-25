import {
  access,
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { VerifyConditionsContext } from 'semantic-release';
import { parse, stringify } from 'smol-toml';
import { archiveFile } from './archive.js';
import { npmChannel, releaseRoute } from './branches.js';
import { cargoPolicy, cargoUserAgent } from './cargo-identity.js';
import { git } from './journal.js';
import { type Edit, editManifest } from './manifests.js';
import { serviceURL } from './npm-identity.js';
import { createProvenance } from './npm-provenance.js';
import {
  npmPolicy,
  npmProbe,
  npmUpload,
  npmVisibility,
} from './npm-registry.js';
import type { PackagePlan, ReleasePlan } from './plan-types.js';
import type { Destination } from './publication-state.js';
import { command, releaseError } from './release-io.js';
import { record } from './workspace-files.js';
import type {
  WorkspaceInventory,
  WorkspacePackage,
} from './workspace-types.js';

function url(value: unknown): string {
  if (typeof value !== 'string')
    return releaseError(
      'Registry URL must be an HTTP(S) URL.',
      'EWORKSPACECONFIG',
    );
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
    return parsed.href.replace(/\/$/, '');
  } catch {
    return releaseError(
      'Registry URL must be HTTP(S), without embedded credentials, query or fragment.',
      'EWORKSPACECONFIG',
    );
  }
}
async function toml(path: string): Promise<Record<string, unknown>> {
  try {
    return parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return {};
    return releaseError(
      'Cannot read Cargo registry configuration.',
      'EWORKSPACECONFIG',
    );
  }
}
async function cargoConfiguration(context: VerifyConditionsContext) {
  const home =
    context.env?.CARGO_HOME ?? join(context.env?.HOME ?? homedir(), '.cargo');
  const global = await toml(join(home, 'config.toml'));
  const local = await toml(
    join(context.cwd ?? process.cwd(), '.cargo/config.toml'),
  );
  const registries = {
    ...(record(global.registries) ? global.registries : {}),
    ...(record(local.registries) ? local.registries : {}),
  };
  return { home, global, local, registries };
}
export async function destination(
  context: VerifyConditionsContext,
  config: Record<string, unknown>,
  pkg: WorkspacePackage,
  previous?: Destination,
): Promise<Destination> {
  if (pkg.ecosystem === 'npm') {
    const options = config.npm === undefined ? {} : config.npm;
    if (!record(options))
      return releaseError(
        'npm configuration must be an object.',
        'EWORKSPACECONFIG',
      );
    const publish = record(pkg.manifest.publishConfig)
      ? pkg.manifest.publishConfig
      : {};
    let configured = options.registry ?? publish.registry;
    if (configured === undefined && pkg.name.startsWith('@')) {
      configured = (
        await command(context, 'npm', [
          'config',
          'get',
          `${pkg.name.split('/')[0]}:registry`,
        ])
      )
        .toString()
        .trim();
      if (configured === 'undefined') configured = undefined;
    }
    const registry = url(
      configured ??
        (await command(context, 'npm', ['config', 'get', 'registry']))
          .toString()
          .trim(),
    );
    const nativeAccess = (
      await command(context, 'npm', ['config', 'get', 'access'])
    )
      .toString()
      .trim();
    let access: unknown;
    if (options.access !== undefined) access = options.access;
    else if (publish.access !== undefined) access = publish.access;
    else
      access = ['null', 'undefined'].includes(nativeAccess)
        ? null
        : nativeAccess;
    const tag =
      (releaseRoute(context)
        ? npmChannel(context.branch.channel)
        : undefined) ??
      options.tag ??
      publish.tag ??
      (await command(context, 'npm', ['config', 'get', 'tag']))
        .toString()
        .trim();
    if (
      (access !== null && access !== 'public' && access !== 'restricted') ||
      typeof tag !== 'string' ||
      !/^[A-Za-z][\w.-]*$/.test(tag)
    )
      return releaseError(
        'Invalid npm access or dist-tag.',
        'EWORKSPACECONFIG',
      );
    return {
      ecosystem: 'npm',
      registry,
      access,
      tag,
      ...(await npmPolicy(context, options, publish, previous)),
    };
  }
  const options = config.cargo === undefined ? {} : config.cargo;
  if (!record(options))
    return releaseError(
      'Cargo configuration must be an object.',
      'EWORKSPACECONFIG',
    );
  const configuration = await cargoConfiguration(context);
  const defaultRegistry = record(configuration.local.registry)
    ? configuration.local.registry.default
    : record(configuration.global.registry)
      ? configuration.global.registry.default
      : undefined;
  const name =
    options.registry ??
    context.env?.CARGO_REGISTRY_DEFAULT ??
    (Array.isArray(pkg.publish) && pkg.publish.length === 1
      ? pkg.publish[0]
      : defaultRegistry) ??
    'crates-io';
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z][\w-]*$/.test(name) ||
    (Array.isArray(pkg.publish) && !pkg.publish.includes(name))
  )
    return releaseError(
      `Cargo publish registry is not allowed for ${pkg.name}.`,
      'EWORKSPACECONFIG',
    );
  const entry = configuration.registries[name];
  const index =
    context.env?.[
      `CARGO_REGISTRIES_${name.toUpperCase().replaceAll('-', '_')}_INDEX`
    ] ??
    (record(entry) ? entry.index : undefined) ??
    (name === 'crates-io' ? 'sparse+https://index.crates.io/' : undefined);
  if (typeof index !== 'string' || !index.startsWith('sparse+'))
    return releaseError(
      'Cargo publishing requires a named HTTP sparse registry. Configure its index in .cargo/config.toml or CARGO_REGISTRIES_<NAME>_INDEX.',
      'EWORKSPACECONFIG',
    );
  return {
    ecosystem: 'cargo',
    registry: name,
    index: `${url(index.slice(7))}/`,
    ...cargoPolicy(context, options, previous),
  };
}
async function cargoToken(
  context: VerifyConditionsContext,
  registry: string,
): Promise<string | undefined> {
  const name = registry.toUpperCase().replaceAll('-', '_');
  const env = context.env ?? process.env;
  const token =
    env[`CARGO_REGISTRIES_${name}_TOKEN`] ??
    (registry === 'crates-io' ? env.CARGO_REGISTRY_TOKEN : undefined);
  if (token) return token;
  const { home } = await cargoConfiguration(context);
  const credentials = await toml(join(home, 'credentials.toml'));
  const entry =
    registry === 'crates-io'
      ? credentials.registry
      : record(credentials.registries)
        ? credentials.registries[registry]
        : undefined;
  return record(entry) && typeof entry.token === 'string'
    ? entry.token
    : undefined;
}
async function request(
  target: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    const headers = new Headers(init.headers);
    headers.set('user-agent', cargoUserAgent);
    const result = await fetch(target, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (result.status !== 404 && !result.ok)
      return releaseError(`Registry request failed (HTTP ${result.status}).`);
    return result;
  } catch {
    return releaseError(
      'Registry request failed. Check registry connectivity and credentials.',
    );
  }
}
export const cargoIndexPath = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.length < 3) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
};
export async function completeCargoDestination(
  context: VerifyConditionsContext,
  dest: Destination,
): Promise<Destination> {
  const token = await cargoToken(context, dest.registry);
  const response = await request(
    `${dest.index}config.json`,
    token ? { headers: { authorization: token } } : {},
  );
  if (!response.ok)
    return releaseError('Cargo registry config.json is missing.');
  const data: unknown = await response
    .json()
    .catch(() => releaseError('Invalid Cargo registry configuration.'));
  if (!record(data)) return releaseError('Invalid Cargo registry config.json.');
  const api = url(data.api);
  if (dest.cargoAuth === 'oidc') serviceURL(api);
  return { ...dest, api };
}
export async function probe(
  context: VerifyConditionsContext,
  dest: Destination,
  pkg: PackagePlan,
  metadata?: unknown,
): Promise<string | null> {
  if (dest.ecosystem === 'npm') return npmProbe(context, dest, pkg, metadata);
  const token = await cargoToken(context, dest.registry);
  const result = await request(`${dest.index}${cargoIndexPath(pkg.name)}`, {
    headers: {
      ...(token ? { authorization: token } : {}),
      'cache-control': 'no-cache',
    },
  });
  if (result.status === 404) return null;
  try {
    const versions: unknown[] = (await result.text())
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const found = versions.find(
      (entry) => record(entry) && entry.vers === pkg.nextVersion,
    );
    if (!found) return null;
    if (
      !record(found) ||
      typeof found.cksum !== 'string' ||
      found.yanked === true
    )
      return releaseError(
        'Cargo version has invalid or yanked registry metadata.',
      );
    return found.cksum;
  } catch {
    return releaseError('Invalid Cargo sparse index response.');
  }
}
function npmArtifactManifest(
  pkg: PackagePlan,
  source: string,
  plan: ReleasePlan,
  inventory: WorkspaceInventory,
  dest: Destination,
): string {
  const value = JSON.parse(source) as Record<string, unknown>;
  const edits: Edit[] = [
    { field: ['publishConfig', 'registry'], value: dest.registry },
    { field: ['publishConfig', 'tag'], value: dest.tag ?? 'latest' },
    { field: ['publishConfig', 'access'], value: dest.access ?? null },
  ];
  for (const section of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    const table = value[section];
    if (!record(table)) continue;
    for (const [name, spec] of Object.entries(table)) {
      if (typeof spec !== 'string' || !/^(workspace:|file:|link:)/.test(spec))
        continue;
      let ref = spec.slice(spec.indexOf(':') + 1);
      const alias = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(ref);
      const path =
        /^(?:file:|link:)/.test(spec) || ref.startsWith('.')
          ? resolve(inventory.root, pkg.path, ref)
          : undefined;
      const target = inventory.packages.find(
        (candidate) =>
          candidate.ecosystem === 'npm' &&
          (path
            ? candidate.directory === path
            : candidate.name === (alias?.[1] ?? name)),
      );
      const planned = plan.packages.find(
        (entry) => entry.id === `npm:${target?.name}`,
      );
      const version = planned?.nextVersion ?? planned?.currentVersion;
      if (
        !target ||
        !version ||
        (target.private && section !== 'devDependencies')
      )
        return releaseError(
          `Cannot publish unresolved or private local dependency ${name}.`,
        );
      if (alias) ref = alias[2] ?? '*';
      let range =
        path || ref === '*'
          ? version
          : ref === '^' || ref === '~'
            ? `${ref}${version}`
            : ref;
      const update = pkg.dependencyUpdates.find(
        (entry) => entry.field[0] === section && entry.field[1] === name,
      );
      range = update?.publishedRange ?? range;
      if ((alias || name !== target.name) && !range.startsWith('npm:'))
        range = `npm:${target.name}@${range}`;
      edits.push({ field: [section, name], value: range });
    }
  }
  return editManifest('package.json', source, edits);
}
export async function pack(
  context: VerifyConditionsContext,
  dest: Destination,
  pkg: PackagePlan,
  plan: ReleasePlan,
  inventory: WorkspaceInventory,
  config: Record<string, unknown>,
): Promise<{ bytes: Buffer; metadata: unknown }> {
  if (pkg.ecosystem === 'npm') {
    const canonical = await readFile(
      join(inventory.root, pkg.path, 'package.json'),
      'utf8',
    );
    const directory = await mkdtemp(join(tmpdir(), 'workspace-pack-'));
    const source = join(directory, 'source');
    const file = join(source, pkg.path, 'package.json');
    const packedManifest = npmArtifactManifest(
      pkg,
      canonical,
      plan,
      inventory,
      dest,
    );
    try {
      await stageSource(context, inventory.root, source, plan.head, false);
      // Reuse installed build tools without copying node_modules or modifying source manifests.
      for (const path of new Set([
        '.',
        ...inventory.packages.map((entry) => entry.path),
      ])) {
        const modules = join(inventory.root, path, 'node_modules');
        try {
          await access(modules);
        } catch {
          continue;
        }
        await symlink(modules, join(source, path, 'node_modules'), 'junction');
      }
      await writeFile(file, packedManifest);
      const output = await command(
        { ...context, cwd: join(source, pkg.path) },
        'npm',
        [
          'pack',
          '--json',
          '--workspaces=false',
          '--pack-destination',
          directory,
        ],
      );
      const result: unknown = JSON.parse(output.toString());
      const entry = Array.isArray(result) ? result[0] : undefined;
      if (
        !record(entry) ||
        entry.name !== pkg.name ||
        entry.version !== pkg.nextVersion ||
        typeof entry.filename !== 'string' ||
        basename(entry.filename) !== entry.filename
      )
        return releaseError('npm pack did not produce a valid artifact.');
      const bytes = await readFile(join(directory, entry.filename));
      const packed = JSON.parse(
        await archiveFile(bytes, 'package/package.json'),
      ) as Record<string, unknown>;
      if (
        packed.name !== pkg.name ||
        packed.version !== pkg.nextVersion ||
        !record(packed.publishConfig) ||
        packed.publishConfig.registry !== dest.registry ||
        packed.publishConfig.tag !== dest.tag ||
        (packed.publishConfig.access ?? null) !== (dest.access ?? null)
      )
        return releaseError(
          'Packed npm manifest differs from the frozen publication policy.',
          'EWORKSPACEARTIFACT',
        );
      return {
        bytes,
        metadata: await createProvenance(
          context,
          dest,
          pkg,
          bytes,
          plan.head,
          () => npmVisibility(context, dest, pkg.name),
        ),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'workspace-cargo-'));
  const source = join(directory, 'source');
  try {
    await stageSource(context, inventory.root, source, plan.head, true);
    // Local path dependencies need a registry version even when this batch does not bump them.
    for (const path of new Set([
      'Cargo.toml',
      ...inventory.packages
        .filter((entry) => entry.ecosystem === 'cargo')
        .map((entry) => join(entry.path, 'Cargo.toml')),
    ])) {
      const file = join(source, path);
      const data = parse(await readFile(file, 'utf8'));
      const tables: Record<string, unknown>[] = [data];
      if (record(data.workspace)) tables.push(data.workspace);
      if (record(data.target))
        for (const target of Object.values(data.target))
          if (record(target)) tables.push(target);
      let changed = false;
      for (const table of tables)
        for (const section of [
          'dependencies',
          'build-dependencies',
          'build_dependencies',
          'dev-dependencies',
          'dev_dependencies',
        ]) {
          const deps = table[section];
          if (!record(deps)) continue;
          for (const dep of Object.values(deps)) {
            if (!record(dep) || typeof dep.path !== 'string') continue;
            const target = inventory.packages.find(
              (entry) =>
                entry.ecosystem === 'cargo' &&
                entry.directory ===
                  resolve(
                    inventory.root,
                    path.slice(0, -'Cargo.toml'.length),
                    dep.path as string,
                  ),
            );
            if (!target) continue;
            const planned = plan.packages.find(
              (entry) => entry.id === `cargo:${target.name}`,
            );
            const version = planned?.nextVersion ?? planned?.currentVersion;
            if (typeof dep.version !== 'string' && version)
              dep.version = version;
            const targetDestination = await destination(
              context,
              config,
              target,
            );
            dep.registry = targetDestination.registry;
            changed = true;
          }
        }
      if (changed) await writeFile(file, stringify(data));
    }
    const workspaceFile = join(source, 'Cargo.toml');
    const workspace = parse(await readFile(workspaceFile, 'utf8'));
    if (record(workspace.workspace)) {
      workspace.workspace.members = pkg.path === '.' ? [] : [pkg.path];
      workspace.workspace['default-members'] =
        pkg.path === '.' ? ['.'] : [pkg.path];
      // Keep unrelated packages out of native Cargo's workspace-wide resolution.
      workspace.workspace.exclude = inventory.packages
        .filter(
          (entry) =>
            entry.ecosystem === 'cargo' &&
            entry.path !== pkg.path &&
            entry.path !== '.',
        )
        .map((entry) => entry.path);
      if (pkg.path !== '.') delete workspace.package;
      await writeFile(workspaceFile, stringify(workspace));
    }
    const local = { ...context, cwd: join(source, pkg.path) };
    // Explicit registry selection is also used for resolving staged internal dependencies.
    const args = [
      'package',
      '--allow-dirty',
      '--registry',
      dest.registry,
      '--target-dir',
      join(directory, 'target'),
    ];
    await command(local, 'cargo', args);
    const verified = {
      ...context,
      cwd: join(directory, 'target/package', `${pkg.name}-${pkg.nextVersion}`),
    };
    const output = await command(verified, 'cargo', [
      'metadata',
      '--no-deps',
      '--format-version',
      '1',
    ]);
    const metadata = JSON.parse(output.toString()) as {
      packages: Record<string, unknown>[];
    };
    const item = metadata.packages.find((entry) => entry.name === pkg.name);
    if (!item || !Array.isArray(item.dependencies))
      return releaseError(
        'Cargo metadata did not describe the release package.',
      );
    const meta: Record<string, unknown> = {
      name: pkg.name,
      vers: pkg.nextVersion,
      deps: item.dependencies.map((dep: Record<string, unknown>) => ({
        name: dep.name,
        version_req: dep.req,
        features: dep.features,
        optional: dep.optional,
        default_features: dep.uses_default_features,
        target: dep.target,
        kind: dep.kind ?? 'normal',
        registry:
          dep.registry === `sparse+${dest.index}` ||
          (dest.registry === 'crates-io' &&
            (dep.registry === null ||
              dep.registry === 'https://github.com/rust-lang/crates.io-index'))
            ? null
            : (dep.registry ?? 'https://github.com/rust-lang/crates.io-index'),
        explicit_name_in_toml: dep.rename,
      })),
      features: item.features,
    };
    for (const key of [
      'authors',
      'description',
      'documentation',
      'homepage',
      'keywords',
      'categories',
      'license',
      'license_file',
      'repository',
      'links',
      'rust_version',
    ])
      meta[key] = item[key] ?? null;
    meta.readme_file = item.readme ?? null;
    meta.readme =
      typeof item.readme === 'string'
        ? await readFile(resolve(verified.cwd, item.readme), 'utf8')
        : null;
    return {
      bytes: await readFile(
        join(
          directory,
          'target/package',
          `${pkg.name}-${pkg.nextVersion}.crate`,
        ),
      ),
      metadata: meta,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function upload(
  context: VerifyConditionsContext,
  dest: Destination,
  bytes: Buffer,
  metadata: unknown,
  publishingToken?: string,
): Promise<void> {
  if (dest.ecosystem === 'npm')
    return npmUpload(context, dest, bytes, metadata);
  const token =
    dest.cargoAuth === 'oidc'
      ? publishingToken
      : await cargoToken(context, dest.registry);
  if (!token)
    return releaseError(
      'Cargo token is required. Use CARGO_REGISTRY_TOKEN, CARGO_REGISTRIES_<NAME>_TOKEN or cargo login credentials; external credential providers are not supported.',
    );
  const data = Buffer.from(JSON.stringify(metadata));
  const first = Buffer.alloc(4);
  first.writeUInt32LE(data.length);
  const second = Buffer.alloc(4);
  second.writeUInt32LE(bytes.length);
  const response = await request(`${dest.api}/api/v1/crates/new`, {
    method: 'PUT',
    headers: {
      authorization: token,
      'content-type': 'application/octet-stream',
      accept: 'application/json',
    },
    body: Buffer.concat([first, data, second, bytes]),
  });
  if (!response.ok) return releaseError('Cargo registry rejected the upload.');
  const result: unknown = await response
    .json()
    .catch(() => releaseError('Invalid Cargo registry upload response.'));
  if (!record(result) || (Array.isArray(result.errors) && result.errors.length))
    return releaseError('Cargo registry rejected the package.');
}

export async function validateArtifact(
  dest: Destination,
  pkg: PackagePlan,
  bytes: Buffer,
  metadata: unknown,
): Promise<void> {
  if (
    !record(metadata) ||
    metadata.name !== pkg.name ||
    (pkg.ecosystem === 'npm' ? metadata.version : metadata.vers) !==
      pkg.nextVersion
  )
    return releaseError(
      'Retained artifact metadata does not match the planned package.',
      'EWORKSPACEARTIFACT',
    );
  if (pkg.ecosystem === 'npm') {
    const value: unknown = JSON.parse(
      await archiveFile(bytes, 'package/package.json'),
    );
    if (
      !record(value) ||
      value.name !== pkg.name ||
      value.version !== pkg.nextVersion ||
      value.private ||
      !record(value.publishConfig) ||
      value.publishConfig.registry !== dest.registry ||
      value.publishConfig.tag !== dest.tag ||
      (value.publishConfig.access ?? null) !== (dest.access ?? null)
    )
      return releaseError(
        'Retained npm manifest differs from the frozen policy.',
        'EWORKSPACEARTIFACT',
      );
  } else {
    const value = parse(
      await archiveFile(bytes, `${pkg.name}-${pkg.nextVersion}/Cargo.toml`),
    );
    if (
      !record(value.package) ||
      value.package.name !== pkg.name ||
      value.package.version !== pkg.nextVersion
    )
      return releaseError(
        'Retained Cargo manifest differs from the planned package.',
        'EWORKSPACEARTIFACT',
      );
  }
}

async function stageSource(
  context: VerifyConditionsContext,
  root: string,
  source: string,
  head: string,
  cargo: boolean,
): Promise<void> {
  await command(context, 'git', [
    'clone',
    '--shared',
    '--no-checkout',
    '--quiet',
    '--',
    root,
    source,
  ]);
  await command({ ...context, cwd: source }, 'git', ['read-tree', head]);
  await cp(root, source, {
    recursive: true,
    filter: (path) =>
      !['.git', 'node_modules', ...(cargo ? ['target'] : [])].includes(
        basename(path),
      ),
  });
  // Preserve all ignore sources, including local info/exclude and core.excludesFile.
  const ignored = (
    await command(context, 'git', [
      'ls-files',
      '--others',
      '--ignored',
      '--directory',
      '--exclude-standard',
      '-z',
    ])
  )
    .toString()
    .split('\0')
    .filter(Boolean);
  if (ignored.some((path) => /[\r\n]/.test(path)))
    return releaseError(
      'Ignored paths containing newlines cannot be staged safely.',
    );
  const patterns = ignored
    .map((path) => `/${path.replace(/[\\*?[\] #!]/g, '\\$&')}`)
    .join('\n');
  const gitDir = await git(
    { ...context, cwd: source },
    'rev-parse',
    '--absolute-git-dir',
  );
  await writeFile(join(gitDir, 'info/exclude'), `${patterns}\n`);
}
