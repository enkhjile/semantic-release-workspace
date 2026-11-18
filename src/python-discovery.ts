import { lstat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import glob from 'fast-glob';
import { parse } from 'smol-toml';
import { pythonSemver } from './python-versions.js';
import { canonicalDirectory, record, text } from './workspace-files.js';
import type {
  WorkspaceInventory,
  WorkspacePackage,
} from './workspace-types.js';

function pythonError(message: string, code: string): never {
  throw new SemanticReleaseError(message, code);
}

async function manifest(root: string, directory: string) {
  const raw = await text(root, join(directory, 'pyproject.toml'));
  if (raw === undefined) return undefined;
  try {
    return parse(raw);
  } catch {
    return pythonError(
      `Invalid pyproject.toml: ${relative(root, directory) || '.'}`,
      'EWORKSPACEMANIFEST',
    );
  }
}
function uv(data: Record<string, unknown>): Record<string, unknown> {
  return record(data.tool) && record(data.tool.uv) ? data.tool.uv : {};
}
function patterns(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    return pythonError(
      `${label} must be an array of directory patterns.`,
      'EWORKSPACECONFIG',
    );
  return value.map((pattern: string) => {
    if (
      !pattern ||
      /^(?:!|\/|[a-z]:)/i.test(pattern) ||
      pattern.includes('\\') ||
      pattern.split('/').includes('..')
    )
      pythonError(`Unsafe uv workspace pattern: ${pattern}`, 'EWORKSPACEPATH');
    return pattern.replace(/^\.\//, '').replace(/\/$/, '') || '.';
  });
}
export async function discoverPythonWorkspaces(
  root: string,
): Promise<WorkspaceInventory | undefined> {
  const data = await manifest(root, root);
  if (!data) return undefined;
  const workspace = uv(data).workspace;
  if (workspace === undefined && data.project === undefined) return undefined;
  if (workspace !== undefined && !record(workspace))
    return pythonError(
      'tool.uv.workspace must be a table.',
      'EWORKSPACECONFIG',
    );
  const members = workspace
    ? patterns(workspace.members ?? [], 'tool.uv.workspace.members')
    : [];
  const exclude =
    workspace?.exclude === undefined
      ? []
      : patterns(workspace.exclude, 'tool.uv.workspace.exclude');
  const options = {
    cwd: root,
    onlyDirectories: false,
    onlyFiles: false,
    dot: true,
    followSymbolicLinks: false,
    braceExpansion: false,
    extglob: false,
    ignore: ['.git', '.venv', 'node_modules', 'target'].flatMap((name) => [
      `**/${name}`,
      `**/${name}/**`,
    ]),
  };
  // fast-glob may traverse a static prefix even with symlink following disabled.
  // Check existing ancestors before either member or exclusion expansion.
  for (const task of [...members, ...exclude].flatMap((pattern) =>
    glob.generateTasks(pattern, options),
  )) {
    let base = resolve(root, task.base);
    while (base !== root) {
      try {
        await lstat(base);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        base = dirname(base);
      }
    }
    await canonicalDirectory(root, base);
  }
  const excluded = new Set(await glob(exclude, options));
  const directories = new Set<string>();
  if (data.project !== undefined) directories.add(root);
  for (const pattern of members) {
    const matches = await glob(pattern, options);
    for (const path of matches) {
      if (excluded.has(path) || (await lstat(resolve(root, path))).isFile())
        continue;
      directories.add(await canonicalDirectory(root, resolve(root, path)));
    }
  }
  const packages: WorkspacePackage[] = [];
  for (const directory of directories) {
    const path = relative(root, directory).split(sep).join('/') || '.';
    const member = directory === root ? data : await manifest(root, directory);
    if (!member && basename(directory).startsWith('.')) continue;
    if (!member)
      pythonError(
        `uv member requires a [project] table: ${path}`,
        'EWORKSPACEMANIFEST',
      );
    const settings = uv(member);
    if (settings.managed !== undefined && typeof settings.managed !== 'boolean')
      pythonError(
        `tool.uv.managed must be a boolean: ${path}`,
        'EWORKSPACECONFIG',
      );
    if (settings.managed === false) continue;
    if (directory !== root && settings.workspace !== undefined)
      pythonError(
        `Nested uv workspaces are not supported: ${path}`,
        'EWORKSPACECONFIG',
      );
    const project = member.project;
    if (!record(project))
      pythonError(
        `uv member requires a [project] table: ${path}`,
        'EWORKSPACEMANIFEST',
      );
    if (
      typeof project.name !== 'string' ||
      project.name.trim() !== project.name ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(project.name)
    )
      pythonError(`Invalid Python project name: ${path}`, 'EWORKSPACEMANIFEST');
    if (
      project.dynamic !== undefined &&
      (!Array.isArray(project.dynamic) ||
        !project.dynamic.every((field) => typeof field === 'string'))
    )
      pythonError(
        `project.dynamic must be an array of field names: ${path}`,
        'EWORKSPACEMANIFEST',
      );
    if (
      (Array.isArray(project.dynamic) && project.dynamic.includes('version')) ||
      !pythonSemver(project.version)
    )
      pythonError(
        `A static project.version with one to three release components and optional aN, bN or rcN is required: ${path}`,
        'EWORKSPACEVERSION',
      );
    if (settings.package !== undefined && typeof settings.package !== 'boolean')
      pythonError(
        `tool.uv.package must be a boolean: ${path}`,
        'EWORKSPACECONFIG',
      );
    const privatePackage =
      settings.package === false ||
      (settings.package !== true && !record(member['build-system']));
    packages.push({
      ecosystem: 'python',
      name: project.name.toLowerCase().replace(/[-_.]+/g, '-'),
      directory,
      path,
      manifestPath: join(directory, 'pyproject.toml'),
      private: privatePackage,
      manifest: member,
    });
  }
  return { root, source: 'pyproject.toml', packages };
}
