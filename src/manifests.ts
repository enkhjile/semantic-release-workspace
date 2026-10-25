import { isUtf8 } from 'node:buffer';
import type { Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import { type AST, parseTOML } from 'toml-eslint-parser';
import { git } from './journal.js';
import type { ReleasePlan } from './plan-types.js';
import { record } from './workspace-files.js';

export interface Edit {
  field: string[];
  value: string | null;
}
const equal = (a: string[], b: string[]) =>
  JSON.stringify(a) === JSON.stringify(b);
const prefix = (a: string[], b: string[]) => a.every((key, i) => key === b[i]);
const keyText = (keys: string[]) =>
  keys
    .map((key) => (/^[\w-]+$/.test(key) ? key : JSON.stringify(key)))
    .join('.');

function editToml(source: string, edit: Edit): string {
  const ast = parseTOML(source);
  const entries: { path: string[]; base: string[]; node: AST.TOMLKeyValue }[] =
    [];
  const tables: {
    path: string[];
    node: AST.TOMLTable | AST.TOMLTopLevelTable;
  }[] = [{ path: [], node: ast.body[0] }];
  function walk(nodes: AST.TOMLKeyValue[], base: string[]) {
    for (const node of nodes) {
      const path = [
        ...base,
        ...node.key.keys.map((key) =>
          key.type === 'TOMLBare' ? key.name : key.value,
        ),
      ];
      entries.push({ path, base, node });
      if (node.value.type === 'TOMLInlineTable') walk(node.value.body, path);
    }
  }
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLKeyValue') walk([node], []);
    else {
      const path = node.resolvedKey.map(String);
      tables.push({ path, node });
      walk(node.body, path);
    }
  }
  const replace = (range: [number, number], value: string) =>
    source.slice(0, range[0]) + value + source.slice(range[1]);
  const exact = entries.find((entry) => equal(entry.path, edit.field));
  if (exact) return replace(exact.node.value.range, JSON.stringify(edit.value));
  const inheritedTable = tables.find((entry) => equal(entry.path, edit.field));
  if (inheritedTable)
    return editToml(replace(inheritedTable.node.range, ''), edit);
  const descendant = entries.find((entry) => prefix(edit.field, entry.path));
  if (descendant)
    return replace(
      descendant.node.range,
      `${keyText(edit.field.slice(descendant.base.length))} = ${JSON.stringify(edit.value)}`,
    );
  const inline = entries
    .filter(
      (entry) =>
        prefix(entry.path, edit.field) &&
        entry.node.value.type === 'TOMLInlineTable',
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (inline && inline.node.value.type === 'TOMLInlineTable') {
    const value = inline.node.value;
    const end = value.range[1] - 1;
    return replace(
      [end, end],
      `${value.body.length ? ', ' : ''}${keyText(edit.field.slice(inline.path.length))} = ${JSON.stringify(edit.value)} `,
    );
  }
  const table = tables
    .filter((entry) => prefix(entry.path, edit.field))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!table) throw new Error('Missing TOML root');
  // Insert after the last complete line so its trailing comment remains intact.
  const last =
    table.node.type === 'TOMLTopLevelTable' ? 0 : table.node.range[1];
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const end = last === 0 ? 0 : source.indexOf('\n', last);
  const offset = end < 0 ? source.length : last === 0 ? 0 : end + 1;
  return replace(
    [offset, offset],
    `${offset && source[offset - 1] !== '\n' ? newline : ''}${keyText(edit.field.slice(table.path.length))} = ${JSON.stringify(edit.value)}${newline}`,
  );
}

export function editManifest(
  path: string,
  source: string,
  edits: Edit[],
): string {
  if (path.endsWith('.toml')) return edits.reduce(editToml, source);
  const value: unknown = JSON.parse(source);
  if (!record(value)) throw new Error('Invalid JSON manifest');
  for (const edit of edits) {
    let target = value;
    for (const key of edit.field.slice(0, -1)) {
      if (!Object.hasOwn(target, key) || !record(target[key]))
        Object.defineProperty(target, key, {
          value: {},
          enumerable: true,
          writable: true,
          configurable: true,
        });
      target = target[key] as Record<string, unknown>;
    }
    Object.defineProperty(target, edit.field.at(-1) ?? '', {
      value: edit.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const indent = /\n([\t ]+)"/.exec(source)?.[1] ?? '  ';
  return `${JSON.stringify(value, null, indent)}\n`.replaceAll(
    '\n',
    source.includes('\r\n') ? '\r\n' : '\n',
  );
}

export interface ManifestChange {
  path: string;
  before: string | null;
  after: string;
}
export async function manifestChanges(
  root: string,
  plan: ReleasePlan,
): Promise<ManifestChange[]> {
  const edits = new Map<string, Edit[]>();
  const add = (path: string, edit: Edit) =>
    edits.set(path, [...(edits.get(path) ?? []), edit]);
  for (const pkg of plan.packages) {
    const version = pkg.nextVersion ?? pkg.currentVersion;
    if (version)
      add(
        join(pkg.path, pkg.ecosystem === 'npm' ? 'package.json' : 'Cargo.toml'),
        {
          field: pkg.ecosystem === 'npm' ? ['version'] : ['package', 'version'],
          value: version,
        },
      );
    for (const change of pkg.dependencyUpdates)
      add(change.manifestPath, { field: change.field, value: change.to });
  }
  return Promise.all(
    [...edits]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([path, changes]) => {
        const before = await readFile(join(root, path), 'utf8');
        return { path, before, after: editManifest(path, before, changes) };
      }),
  );
}

export async function applyManifests(
  root: string,
  changes: ManifestChange[],
  restore = false,
): Promise<void> {
  const gitDir = await git({ cwd: root }, 'rev-parse', '--absolute-git-dir');
  const valid: { change: ManifestChange; mode: number }[] = [];
  let conflict: string | undefined;
  for (const change of changes) {
    try {
      const actual = await readReleaseFile(root, change.path);
      if (actual !== change.before && actual !== change.after)
        conflict ??= change.path;
      else
        valid.push({
          change,
          mode:
            actual === null
              ? 0o644
              : (await lstat(join(root, change.path))).mode,
        });
    } catch {
      conflict ??= change.path;
    }
  }
  if (!conflict || restore)
    for (const { change, mode } of valid) {
      const file = join(root, change.path);
      if (restore && change.before === null) {
        await rm(file, { force: true });
        continue;
      }
      const directory = await mkdtemp(join(gitDir, 'workspace-manifest-'));
      try {
        const temporary = join(directory, 'manifest');
        await writeFile(
          temporary,
          restore ? (change.before as string) : change.after,
        );
        await chmod(temporary, mode);
        // Before/after bytes stay intact even if this process terminates mid-write.
        await rename(temporary, file);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  if (conflict)
    throw new SemanticReleaseError(
      `Manifest changed during release: ${conflict}.`,
      'EWORKSPACEDIRTY',
    );
}

export async function readReleaseFile(
  root: string,
  path: string,
): Promise<string | null> {
  const parts = path.split(/[\\/]/).filter((part) => part !== '.');
  if (isAbsolute(path) || parts.some((part) => part === '..'))
    throw new SemanticReleaseError('Invalid manifest path.', 'EWORKSPACEDIRTY');
  for (let index = 0; index < parts.length; index++) {
    let info: Stats;
    try {
      info = await lstat(join(root, ...parts.slice(0, index + 1)));
    } catch (error) {
      if (
        index === parts.length - 1 &&
        record(error) &&
        error.code === 'ENOENT'
      )
        return null;
      throw error;
    }
    if (
      info.isSymbolicLink() ||
      (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
    )
      throw new SemanticReleaseError(
        `Manifest path changed during release: ${path}.`,
        'EWORKSPACEDIRTY',
      );
  }
  const bytes = await readFile(join(root, path));
  if (!isUtf8(bytes))
    throw new SemanticReleaseError(
      'Release files must contain valid UTF-8.',
      'EWORKSPACEDIRTY',
    );
  return bytes.toString('utf8');
}
