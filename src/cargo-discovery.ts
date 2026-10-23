import { join, relative, resolve, sep } from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import glob from 'fast-glob';
import { parse } from 'smol-toml';
import {
  assertInside,
  canonicalDirectory,
  record,
  text,
} from './workspace-files.js';
import type {
  WorkspaceInventory,
  WorkspacePackage,
} from './workspace-types.js';

const dependencyKeys = [
  ['dependencies'],
  ['dev-dependencies', 'dev_dependencies'],
  ['build-dependencies', 'build_dependencies'],
];

function cargoError(message: string, code = 'EWORKSPACEMANIFEST'): never {
  throw new SemanticReleaseError(message, code);
}

async function manifest(
  root: string,
  directory: string,
): Promise<Record<string, unknown>> {
  const path = join(directory, 'Cargo.toml');
  const raw = await text(root, path);
  if (raw === undefined)
    cargoError(
      `Cargo member has no Cargo.toml: ${relative(root, directory) || '.'}`,
    );
  try {
    return parse(raw);
  } catch {
    cargoError(`Invalid Cargo manifest: ${path}`);
  }
}

function paths(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    cargoError(
      `${label} must be an array of directory patterns.`,
      'EWORKSPACECONFIG',
    );
  }
  return value.map((path: string) => {
    if (
      !path ||
      path.startsWith('!') ||
      path.includes('\\') ||
      path.split('/').includes('..')
    ) {
      cargoError(`Unsafe Cargo workspace pattern: ${path}`, 'EWORKSPACEPATH');
    }
    // Also catches absolute paths across platforms before any glob expansion.
    if (/^(?:\/|[a-z]:)/i.test(path))
      cargoError(`Unsafe Cargo workspace pattern: ${path}`, 'EWORKSPACEPATH');
    return path.replace(/^\.\//, '').replace(/\/$/, '') || '.';
  });
}

function publishPolicy(
  value: unknown,
  workspace: Record<string, unknown>,
): boolean | string[] {
  if (record(value)) {
    const inherited = record(workspace.package)
      ? workspace.package.publish
      : undefined;
    if (
      value.workspace !== true ||
      inherited === undefined ||
      record(inherited)
    ) {
      cargoError(
        'Cargo publish.workspace must resolve to workspace.package.publish.',
      );
    }
    value = inherited;
  }
  if (value === undefined) return true;
  if (typeof value === 'boolean') return value;
  if (
    Array.isArray(value) &&
    value.every(
      (registry) => typeof registry === 'string' && registry.length > 0,
    )
  )
    return value;
  cargoError('Cargo publish must be a boolean or an array of registry names.');
}

function pathDependencies(
  data: Record<string, unknown>,
  directory: string,
  workspace: Record<string, unknown>,
  root: string,
): string[] {
  const tables: Record<string, unknown>[] = [data];
  if (record(data.target)) {
    for (const table of Object.values(data.target))
      if (record(table)) tables.push(table);
  }
  const found: string[] = [];
  for (const table of tables) {
    for (const aliases of dependencyKeys) {
      const key = aliases.find((name) => table[name] !== undefined);
      if (!key) continue;
      const dependencies = table[key];
      if (!record(dependencies))
        cargoError(`Invalid Cargo dependency table: ${key}`);
      for (const [name, raw] of Object.entries(dependencies)) {
        if (!record(raw)) continue;
        let dependency = raw;
        let base = directory;
        if (raw.workspace === true) {
          const inherited = record(workspace.dependencies)
            ? workspace.dependencies[name]
            : undefined;
          if (inherited === undefined)
            cargoError(`Missing workspace dependency: ${name}`);
          if (!record(inherited)) continue;
          dependency = inherited;
          base = root;
        }
        if (dependency.path !== undefined) {
          if (typeof dependency.path !== 'string' || !dependency.path)
            cargoError(`Invalid Cargo dependency path: ${name}`);
          const target = resolve(base, dependency.path);
          const path = relative(root, target);
          // Outside path dependencies are dependencies, not automatic workspace members.
          if (
            path !== '..' &&
            !path.startsWith(`..${sep}`) &&
            !/^(?:\/|[a-z]:)/i.test(path)
          )
            found.push(target);
        }
      }
    }
  }
  return found;
}

export async function discoverCargoWorkspaces(
  root: string,
): Promise<WorkspaceInventory | undefined> {
  if ((await text(root, join(root, 'Cargo.toml'))) === undefined)
    return undefined;
  const rootManifest = await manifest(root, root);
  if (rootManifest.workspace !== undefined && !record(rootManifest.workspace))
    cargoError('Cargo workspace must be a table.', 'EWORKSPACECONFIG');
  const workspace = record(rootManifest.workspace)
    ? rootManifest.workspace
    : {};
  const members = paths(workspace.members ?? [], 'workspace.members');
  const excluded = paths(workspace.exclude ?? [], 'workspace.exclude').map(
    (path) => resolve(root, path),
  );
  const ignored = new Set(['.git', 'node_modules', '.yarn', '.pnpm', 'target']);
  const options: glob.Options = {
    cwd: root,
    onlyDirectories: false,
    onlyFiles: false,
    dot: true,
    braceExpansion: false,
    extglob: false,
    // Returned candidates are boundary/symlink-checked before reading manifests.
    followSymbolicLinks: false,
    ignore: [...ignored].map((directory) => `**/${directory}/**`),
  };
  const queue: string[] = [];
  const explicit: string[] = [];
  if (rootManifest.package !== undefined) queue.push(root);
  else if (rootManifest.workspace === undefined)
    cargoError('Cargo.toml must define a package or workspace.');
  for (const pattern of members) {
    const dynamic = /[*?[]/.test(pattern);
    if (!dynamic) explicit.push(resolve(root, pattern));
    const input = dynamic ? pattern : glob.escapePath(pattern);
    // A static glob prefix can itself be a directory alias. Check before crawling.
    for (const task of glob.generateTasks(input, options))
      await canonicalDirectory(root, resolve(root, task.base));
    const matches = await glob(input, options);
    if (!matches.length)
      cargoError(
        `Cargo workspace member pattern matches no directories: ${pattern}`,
      );
    queue.push(...matches.map((path) => resolve(root, path)));
  }
  const seen = new Set<string>();
  const packages: WorkspacePackage[] = [];
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index];
    if (!directory || seen.has(directory)) continue;
    assertInside(root, directory);
    // Cargo exclusions are literal path prefixes, unlike member globs.
    if (
      directory !== root &&
      !explicit.some(
        (path) => directory === path || directory.startsWith(`${path}${sep}`),
      ) &&
      (excluded.some(
        (path) => directory === path || directory.startsWith(`${path}${sep}`),
      ) ||
        relative(root, directory)
          .split(sep)
          .some((part) => ignored.has(part)))
    )
      continue;
    const canonical = await canonicalDirectory(root, directory);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    if (canonical === root && rootManifest.package === undefined) continue;
    const data =
      canonical === root ? rootManifest : await manifest(root, canonical);
    if (canonical !== root && data.workspace !== undefined)
      cargoError(
        `Nested Cargo workspace cannot be a member: ${relative(root, canonical)}`,
        'EWORKSPACECONFIG',
      );
    const pkg = data.package;
    if (
      !record(pkg) ||
      typeof pkg.name !== 'string' ||
      !/^[\p{L}\p{N}_-]+$/u.test(pkg.name)
    )
      cargoError(`Cargo package needs a valid name: ${canonical}`);
    if (
      pkg.workspace !== undefined &&
      (typeof pkg.workspace !== 'string' ||
        resolve(canonical, pkg.workspace) !== root ||
        data.workspace !== undefined)
    )
      cargoError(
        `Cargo member points to a different workspace: ${canonical}`,
        'EWORKSPACECONFIG',
      );
    const publish = publishPolicy(pkg.publish, workspace);
    packages.push({
      ecosystem: 'cargo',
      name: pkg.name,
      directory: canonical,
      path: relative(root, canonical).split(sep).join('/') || '.',
      manifestPath: join(canonical, 'Cargo.toml'),
      private:
        publish === false || (Array.isArray(publish) && publish.length === 0),
      publish,
      manifest: data,
    });
    if (rootManifest.workspace !== undefined)
      queue.push(...pathDependencies(data, canonical, workspace, root));
  }
  return { root, source: 'Cargo.toml', packages };
}
