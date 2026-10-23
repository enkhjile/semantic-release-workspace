import { glob, lstat, readFile, realpath, stat } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import { parseDocument } from 'yaml';

export interface WorkspacePackage {
  name: string;
  directory: string;
  path: string;
  private: boolean;
  manifest: Record<string, unknown> & { name: string };
}

export interface WorkspaceInventory {
  root: string;
  source: 'pnpm-workspace.yaml' | 'package.json' | null;
  packages: WorkspacePackage[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertInside(root: string, path: string): void {
  const child = relative(root, path);
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    throw new SemanticReleaseError(
      `Workspace path escapes the repository: ${path}`,
      'EWORKSPACEPATH',
    );
  }
}

async function text(root: string, path: string): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SemanticReleaseError(
      `Cannot resolve workspace file: ${path}`,
      'EWORKSPACEMANIFEST',
    );
  }
  assertInside(root, canonical);
  try {
    return await readFile(canonical, 'utf8');
  } catch {
    throw new SemanticReleaseError(
      `Cannot read workspace file: ${path}`,
      'EWORKSPACEMANIFEST',
    );
  }
}

function json(raw: string, path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (record(value)) return value;
  } catch {
    // The file path is useful; raw manifest contents may contain private data.
  }
  throw new SemanticReleaseError(
    `Invalid package manifest: ${path}`,
    'EWORKSPACEMANIFEST',
  );
}

function patterns(value: unknown, source: string, npm = false): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new SemanticReleaseError(
      `${source} must declare workspace patterns as an array of strings.`,
      'EWORKSPACECONFIG',
    );
  }
  return value.map((item: string) => {
    const bangs = item.match(/^!+/)?.[0].length ?? 0;
    const excluded = npm ? bangs % 2 === 1 : bangs > 0;
    const path = item.slice(npm ? bangs : excluded ? 1 : 0);
    if (
      !path ||
      isAbsolute(path) ||
      win32.isAbsolute(path) ||
      path.includes('\\') ||
      path.split('/').includes('..')
    ) {
      throw new SemanticReleaseError(
        `Unsafe workspace pattern in ${source}: ${item}`,
        'EWORKSPACEPATH',
      );
    }
    return `${excluded ? '!' : ''}${posix.normalize(path).replace(/\/$/, '')}`;
  });
}

async function directories(
  root: string,
  inputs: string[],
  npm = false,
  cwd = root,
): Promise<string[]> {
  let include = inputs.filter((pattern) => !pattern.startsWith('!'));
  let negatives = inputs
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));
  if (npm) {
    // npm lets a later positive pattern cancel an earlier matching exclusion.
    negatives = [];
    for (const pattern of inputs) {
      if (pattern.startsWith('!')) negatives.push(pattern.slice(1));
      else
        negatives = negatives.filter(
          (negative) => !matchesGlob(pattern, negative),
        );
    }
    include = include.filter(
      (pattern) =>
        !negatives.some((negative) => matchesGlob(pattern, negative)),
    );
  }
  if (!include.length) return [];
  const exclude = [
    '**/node_modules/**',
    '**/.git/**',
    '**/.yarn/**',
    '**/.pnpm/**',
    ...negatives,
  ];
  const found = new Set<string>();
  for await (const path of glob(include, { cwd, exclude })) {
    const absolute = resolve(cwd, path);
    assertInside(root, absolute);
    if (!(await stat(absolute)).isDirectory()) continue;
    const canonical = await realpath(absolute);
    assertInside(root, canonical);
    // Reject directory aliases rather than letting them reintroduce excluded paths.
    for (let cursor = absolute; cursor !== root; cursor = dirname(cursor)) {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new SemanticReleaseError(
          `Use a canonical workspace directory instead of a symlink: ${path}`,
          'EWORKSPACEPATH',
        );
      }
    }
    if (canonical !== root) found.add(canonical);
  }
  // Patterns describe package directories, not necessarily packages. Ignore containers.
  const packages: string[] = [];
  for (const directory of [...found].sort()) {
    if ((await text(root, join(directory, 'package.json'))) !== undefined)
      packages.push(directory);
  }
  return packages;
}

async function jsonDirectories(
  root: string,
  inputs: string[],
  yarn: boolean,
  recursive: boolean,
): Promise<string[]> {
  const selected = await directories(root, inputs, !yarn);
  if (!recursive) return selected;
  const seen = new Set(selected);
  for (let index = 0; index < selected.length; index++) {
    const directory = selected[index];
    if (!directory) continue;
    const raw = await text(root, join(directory, 'package.json'));
    if (raw === undefined)
      throw new SemanticReleaseError(
        `Package disappeared during discovery: ${directory}`,
        'EWORKSPACEMANIFEST',
      );
    const manifest = json(raw, directory);
    if (!('workspaces' in manifest)) continue;
    const definition = manifest.workspaces;
    const nested = patterns(
      record(definition) ? definition.packages : definition,
      `${directory} workspaces`,
    );
    for (const child of await directories(root, nested, false, directory)) {
      if (!seen.has(child)) {
        seen.add(child);
        selected.push(child);
      }
    }
  }
  return selected.sort();
}

export async function discoverWorkspaces(
  directory: string,
): Promise<WorkspaceInventory> {
  const root = await realpath(directory);
  const rootPath = join(root, 'package.json');
  const rawRoot = await text(root, rootPath);
  if (rawRoot === undefined)
    throw new SemanticReleaseError(
      'A root package.json is required.',
      'EWORKSPACEMANIFEST',
    );
  const manifest = json(rawRoot, rootPath);
  const manager =
    typeof manifest.packageManager === 'string'
      ? manifest.packageManager
      : undefined;
  const yarnLock = manager
    ? undefined
    : await text(root, join(root, 'yarn.lock'));
  const yarnConfig = manager
    ? undefined
    : await text(root, join(root, '.yarnrc.yml'));
  const yarn =
    manager?.startsWith('yarn@') ??
    (record(manifest.workspaces) ||
      yarnLock !== undefined ||
      yarnConfig !== undefined);
  const classic =
    manager?.startsWith('yarn@1.') ??
    (record(manifest.workspaces) ||
      yarnLock?.includes('# yarn lockfile v1') === true);
  let packagePatterns: string[] | undefined;
  if ('workspaces' in manifest) {
    const definition = manifest.workspaces;
    packagePatterns = patterns(
      record(definition) ? definition.packages : definition,
      'package.json workspaces',
      !yarn,
    );
  }
  const rawPnpm = await text(root, join(root, 'pnpm-workspace.yaml'));
  let pnpmPatterns: string[] | undefined;
  if (rawPnpm !== undefined) {
    let definition: unknown;
    try {
      const document = parseDocument(rawPnpm);
      if (document.errors.length) throw new Error('Invalid YAML document');
      definition =
        document.contents === null ? {} : document.toJS({ maxAliasCount: 100 });
    } catch {
      throw new SemanticReleaseError(
        'Invalid pnpm-workspace.yaml.',
        'EWORKSPACECONFIG',
      );
    }
    if (!record(definition))
      throw new SemanticReleaseError(
        'pnpm-workspace.yaml must be a mapping.',
        'EWORKSPACECONFIG',
      );
    pnpmPatterns = patterns(
      'packages' in definition ? definition.packages : [],
      'pnpm-workspace.yaml packages',
    );
  }
  const fromJson =
    packagePatterns === undefined
      ? undefined
      : await jsonDirectories(root, packagePatterns, yarn, yarn && !classic);
  const selected =
    pnpmPatterns === undefined
      ? (fromJson ?? [])
      : await directories(root, pnpmPatterns);
  if (
    pnpmPatterns !== undefined &&
    fromJson !== undefined &&
    JSON.stringify(selected) !== JSON.stringify(fromJson)
  ) {
    throw new SemanticReleaseError(
      'pnpm-workspace.yaml and package.json select different workspace packages.',
      'EWORKSPACECONFIG',
    );
  }
  const packages: WorkspacePackage[] = [];
  const names = new Map<string, string>();
  for (const directory of selected) {
    const path = relative(root, directory).split(sep).join('/');
    const raw = await text(root, join(directory, 'package.json'));
    if (raw === undefined)
      throw new SemanticReleaseError(
        `Package disappeared during discovery: ${path}`,
        'EWORKSPACEMANIFEST',
      );
    const manifest = json(raw, path);
    if (
      typeof manifest.name !== 'string' ||
      !manifest.name.trim() ||
      manifest.name !== manifest.name.trim() ||
      ('private' in manifest && typeof manifest.private !== 'boolean')
    ) {
      throw new SemanticReleaseError(
        `Package ${path} needs a nonempty name and a boolean private field when present.`,
        'EWORKSPACEMANIFEST',
      );
    }
    const previous = names.get(manifest.name);
    if (previous)
      throw new SemanticReleaseError(
        `Duplicate package name ${manifest.name}: ${previous} and ${path}`,
        'EWORKSPACEDUPLICATE',
      );
    names.set(manifest.name, path);
    packages.push({
      name: manifest.name,
      directory,
      path,
      private: manifest.private === true,
      manifest: { ...manifest, name: manifest.name },
    });
  }
  return {
    root,
    source:
      pnpmPatterns !== undefined
        ? 'pnpm-workspace.yaml'
        : packagePatterns !== undefined
          ? 'package.json'
          : null,
    packages,
  };
}
