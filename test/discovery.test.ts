import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { discoverWorkspaces } from '../src/discovery.js';

const roots: string[] = [];
async function fixture(manifest: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-discovery-'));
  roots.push(dir);
  const root = await realpath(dir);
  async function file(path: string, contents: string) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
  await file(
    'package.json',
    JSON.stringify({ name: 'root', private: true, ...manifest }),
  );
  return {
    root,
    file,
    pkg: (directory: string, value: Record<string, unknown>) =>
      file(`${directory}/package.json`, JSON.stringify(value)),
    discover: () => discoverWorkspaces(root),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test('npm workspace globs produce a sorted inventory with canonical paths', async () => {
  const f = await fixture({ workspaces: ['packages/*'] });
  await f.pkg('packages/z', {
    name: '@test/z',
    version: '1.2.0',
    dependencies: { '@test/a': 'workspace:^' },
  });
  await f.pkg('packages/a', { name: '@test/a', private: true });
  const result = await f.discover();
  expect(result.source).toBe('package.json');
  expect(
    result.packages.map((pkg) => [pkg.name, pkg.path, pkg.private]),
  ).toEqual([
    ['@test/a', 'packages/a', true],
    ['@test/z', 'packages/z', false],
  ]);
  expect(result.packages[0]?.directory).toBe(join(f.root, 'packages/a'));
  expect(result.packages[1]?.manifest.dependencies).toEqual({
    '@test/a': 'workspace:^',
  });
});

test('pnpm YAML handles comments, exclusions, nested packages, and unrelated settings', async () => {
  const f = await fixture();
  await f.file(
    'pnpm-workspace.yaml',
    "# workspace\npackages:\n  - packages/**\n  - '!**/fixtures/**'\ncatalog:\n  typescript: ^7.0.0\n",
  );
  await f.pkg('packages/a', { name: 'a' });
  await f.pkg('packages/a/nested', { name: 'nested', private: true });
  await f.pkg('packages/fixtures/ignored', { name: 'ignored' });
  expect(await f.discover()).toMatchObject({
    source: 'pnpm-workspace.yaml',
    packages: [{ name: 'a' }, { name: 'nested', private: true }],
  });
});

test('Yarn classic workspaces object uses packages while ignoring nohoist rules', async () => {
  const f = await fixture({
    packageManager: 'yarn@1.22.22',
    workspaces: { packages: ['packages/*'], nohoist: ['**/native'] },
  });
  await f.pkg('packages/app', { name: 'app', private: true });
  expect((await f.discover()).packages).toMatchObject([
    { name: 'app', private: true },
  ]);
});

test('Yarn modern array workspaces need no lockfile or installed package manager', async () => {
  const f = await fixture({
    packageManager: 'yarn@4.0.0',
    workspaces: ['modules/{core,ui}'],
  });
  await f.pkg('modules/core', { name: 'core' });
  await f.pkg('modules/ui', { name: 'ui' });
  await f.pkg('modules/other', { name: 'other' });
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'core',
    'ui',
  ]);
});

test('root is excluded even when explicit; overlapping globs do not duplicate packages', async () => {
  const f = await fixture({
    private: false,
    workspaces: ['.', 'packages/**', 'packages/*'],
  });
  await f.pkg('packages/a', { name: 'a' });
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual(['a']);
});

test('pnpm exclusions are final regardless of pattern order and normalize relative prefixes', async () => {
  const f = await fixture();
  await f.file(
    'pnpm-workspace.yaml',
    'packages: ["!./packages/legacy/**", "./packages//*", "packages/**"]',
  );
  await f.pkg('packages/core', { name: 'core' });
  await f.pkg('packages/legacy/child', { name: 'legacy' });
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'core',
  ]);
});

test('package-manager caches and Git directories are never workspace packages', async () => {
  const f = await fixture({ workspaces: ['**'] });
  await f.pkg('packages/core', { name: 'core' });
  for (const path of [
    'node_modules/dependency',
    'packages/a/node_modules/transitive',
    '.git/fixture',
  ]) {
    await f.pkg(path, { name: 'ignored' });
  }
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'core',
  ]);
});

test('duplicate names fail with both package locations, including private packages', async () => {
  const f = await fixture({ workspaces: ['packages/*'] });
  await f.pkg('packages/a', { name: 'duplicate' });
  await f.pkg('packages/b', { name: 'duplicate', private: true });
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACEDUPLICATE',
    message: expect.stringMatching(/packages\/a.*packages\/b/),
  });
});

test('matching pnpm and package.json definitions can coexist', async () => {
  const f = await fixture({ workspaces: ['packages/*'] });
  await f.file('pnpm-workspace.yaml', 'packages: ["./packages/**"]\n');
  await f.pkg('packages/a', { name: 'a' });
  expect(await f.discover()).toMatchObject({
    source: 'pnpm-workspace.yaml',
    packages: [{ name: 'a' }],
  });
});

test('conflicting pnpm and package.json membership is rejected', async () => {
  const f = await fixture({ workspaces: ['apps/*'] });
  await f.file('pnpm-workspace.yaml', 'packages: ["packages/*"]\n');
  await f.pkg('packages/a', { name: 'a' });
  await f.pkg('apps/b', { name: 'b' });
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACECONFIG',
  });
});

test('no definition or pnpm configuration without packages yields an empty inventory', async () => {
  const f = await fixture();
  expect(await f.discover()).toMatchObject({ source: null, packages: [] });
  await f.file('pnpm-workspace.yaml', 'onlyBuiltDependencies: []\n');
  expect(await f.discover()).toMatchObject({
    source: 'pnpm-workspace.yaml',
    packages: [],
  });
});

test.each([null, 'packages/*', [7], { packages: 'packages/*' }])(
  'invalid workspace declaration %j fails',
  async (workspaces) => {
    const f = await fixture({ workspaces });
    await expect(f.discover()).rejects.toMatchObject({
      code: 'EWORKSPACECONFIG',
    });
  },
);

test.each([
  'packages: [',
  'packages: false',
  'packages: null',
  'packages: [7]',
  'null',
])('invalid pnpm YAML %s fails', async (yaml) => {
  const f = await fixture();
  await f.file('pnpm-workspace.yaml', yaml);
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACECONFIG',
  });
});

test.each([
  '../*',
  '/tmp/*',
  'C:/outside/*',
  'packages/../../outside/*',
  '!../*',
  '',
])('unsafe pattern %s fails', async (pattern) => {
  const f = await fixture({ workspaces: [pattern] });
  await expect(f.discover()).rejects.toMatchObject({ code: 'EWORKSPACEPATH' });
});

test.each([{ name: '' }, { name: 7 }, {}, { name: 'a', private: 'false' }])(
  'invalid selected manifest %j fails',
  async (manifest) => {
    const f = await fixture({ workspaces: ['packages/*'] });
    await f.pkg('packages/a', manifest);
    await expect(f.discover()).rejects.toMatchObject({
      code: 'EWORKSPACEMANIFEST',
    });
  },
);

test('malformed selected JSON fails, while non-package directories are ignored', async () => {
  const f = await fixture({ workspaces: ['packages/*'] });
  await f.file('packages/not-a-package/README.md', 'not a package');
  expect((await f.discover()).packages).toEqual([]);
  await f.file('packages/broken/package.json', '{invalid');
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACEMANIFEST',
  });
});

test('symlinked workspace paths may not escape the repository', async () => {
  const f = await fixture({ workspaces: ['packages/external'] });
  const outside = await fixture();
  await mkdir(join(f.root, 'packages'));
  await symlink(outside.root, join(f.root, 'packages/external'), 'dir');
  await expect(f.discover()).rejects.toMatchObject({ code: 'EWORKSPACEPATH' });
});

test('a selected package manifest may not be a symlink outside the repository', async () => {
  const f = await fixture({ workspaces: ['packages/*'] });
  const outside = await fixture();
  await mkdir(join(f.root, 'packages/external'), { recursive: true });
  await symlink(
    join(outside.root, 'package.json'),
    join(f.root, 'packages/external/package.json'),
  );
  await expect(f.discover()).rejects.toMatchObject({ code: 'EWORKSPACEPATH' });
});

test('directory aliases cannot bypass cache exclusions', async () => {
  const f = await fixture({ workspaces: ['packages/*'] });
  await f.pkg('node_modules/cached', { name: 'cached' });
  await mkdir(join(f.root, 'packages'));
  await symlink(
    join(f.root, 'node_modules/cached'),
    join(f.root, 'packages/alias'),
    'dir',
  );
  await expect(f.discover()).rejects.toMatchObject({ code: 'EWORKSPACEPATH' });
});

test('directory aliases cannot bypass explicit workspace exclusions', async () => {
  const f = await fixture({ workspaces: ['packages/*', '!packages/excluded'] });
  await f.pkg('packages/excluded', { name: 'excluded' });
  await symlink(
    join(f.root, 'packages/excluded'),
    join(f.root, 'packages/alias'),
    'dir',
  );
  await expect(f.discover()).rejects.toMatchObject({ code: 'EWORKSPACEPATH' });
});

test('npm permits explicit later reinclusion of an excluded workspace', async () => {
  const f = await fixture({
    packageManager: 'npm@12.2.1',
    workspaces: ['packages/**', '!packages/b/**', 'packages/b/a'],
  });
  await f.pkg('packages/b/a', { name: 'a' });
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual(['a']);
});

test('Yarn keeps exclusions final rather than applying npm reinclusion rules', async () => {
  const f = await fixture({
    packageManager: 'yarn@4.0.0',
    workspaces: ['packages/**', '!packages/b/**', 'packages/b/a'],
  });
  await f.pkg('packages/b/a', { name: 'a' });
  expect((await f.discover()).packages).toEqual([]);
});

test('Yarn recursively discovers workspace declarations in selected packages', async () => {
  const f = await fixture({
    packageManager: 'yarn@4.0.0',
    workspaces: ['packages/*'],
  });
  await f.pkg('packages/group', {
    name: 'group',
    private: true,
    workspaces: ['inner/*'],
  });
  await f.pkg('packages/group/inner/child', { name: 'child' });
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'group',
    'child',
  ]);
});

test('Yarn lockfile identifies recursive workspaces without packageManager', async () => {
  const f = await fixture({ workspaces: ['packages/*'] });
  await f.file('yarn.lock', '# yarn lockfile');
  await f.pkg('packages/group', { name: 'group', workspaces: ['inner/*'] });
  await f.pkg('packages/group/inner/child', { name: 'child' });
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'group',
    'child',
  ]);
});

test('Yarn configuration identifies a new modern project without a lockfile', async () => {
  const f = await fixture({ workspaces: ['packages/*'] });
  await f.file('.yarnrc.yml', 'nodeLinker: node-modules');
  await f.pkg('packages/group', { name: 'group', workspaces: ['inner/*'] });
  await f.pkg('packages/group/inner/child', { name: 'child' });
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'group',
    'child',
  ]);
});

test.each(['', '# pnpm settings only\n'])(
  'empty pnpm YAML %j describes a root-only workspace',
  async (yaml) => {
    const f = await fixture();
    await f.file('pnpm-workspace.yaml', yaml);
    expect(await f.discover()).toMatchObject({
      source: 'pnpm-workspace.yaml',
      packages: [],
    });
  },
);
