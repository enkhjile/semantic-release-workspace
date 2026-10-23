import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
async function fixture(toml: string) {
  const directory = await mkdtemp(join(tmpdir(), 'cargo-discovery-'));
  roots.push(directory);
  const root = await realpath(directory);
  async function file(path: string, value: string) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, value);
  }
  await file('Cargo.toml', toml);
  return {
    root,
    file,
    async crate(directory: string, name: string, extra = '') {
      await file(
        `${directory}/Cargo.toml`,
        `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n${extra}\n`,
      );
      await file(`${directory}/src/lib.rs`, '');
    },
    discover: () => discoverWorkspaces(root),
  };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test('virtual Cargo workspace discovers all members, including hidden crates, without package.json', async () => {
  const f = await fixture(
    '[workspace]\nmembers = ["crates/*"]\ndefault-members = ["crates/a"]\nresolver = "3"\n',
  );
  await f.crate('crates/z', 'z');
  await f.crate('crates/a', 'a');
  await f.crate('crates/.hidden', 'hidden');
  const result = await f.discover();
  expect(result.source).toBe('Cargo.toml');
  expect(
    result.packages.map((pkg) => [
      pkg.ecosystem,
      pkg.name,
      pkg.path,
      pkg.private,
    ]),
  ).toEqual([
    ['cargo', 'hidden', 'crates/.hidden', false],
    ['cargo', 'a', 'crates/a', false],
    ['cargo', 'z', 'crates/z', false],
  ]);
  expect(result.packages[0]?.manifestPath).toBe(
    join(f.root, 'crates/.hidden/Cargo.toml'),
  );
  expect((await readdir(f.root)).sort()).toEqual(['Cargo.toml', 'crates']);
});

test('Cargo exclusions omit members and malformed manifests before parsing', async () => {
  const f = await fixture(
    '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/ignored"]\n',
  );
  await f.crate('crates/a', 'a');
  await f.file('crates/ignored/Cargo.toml', '[broken');
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual(['a']);
});

test('Cargo exclusions are literal paths, not member glob patterns', async () => {
  const f = await fixture(
    '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/ignored*"]\n',
  );
  await f.crate('crates/a', 'a');
  await f.crate('crates/ignored', 'ignored');
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'a',
    'ignored',
  ]);
});

test('explicit Cargo members take precedence over exclusions', async () => {
  const f = await fixture(
    '[workspace]\nmembers = ["crates/a"]\nexclude = ["crates/a"]\n',
  );
  await f.crate('crates/a', 'a');
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual(['a']);
});

test('explicit parent members take precedence over descendant exclusions', async () => {
  const f = await fixture(
    '[workspace]\nmembers = [".", "crates/*"]\nexclude = ["crates/a"]\n',
  );
  await f.crate('crates/a', 'a');
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual(['a']);
});

test('Cargo exclusions also omit path dependencies below an excluded directory', async () => {
  const f = await fixture(
    '[workspace]\nmembers = ["crates/a"]\nexclude = ["internal"]\n',
  );
  await f.crate(
    'crates/a',
    'a',
    '[dependencies]\nhelper = { path = "../../internal/helper" }',
  );
  await f.crate('internal/helper', 'helper');
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual(['a']);
});

test('publish=false and empty registry lists retain private crates', async () => {
  const f = await fixture('[workspace]\nmembers = ["crates/*"]\n');
  await f.crate('crates/a', 'a', 'publish = false');
  await f.crate('crates/b', 'b', 'publish = []');
  await f.crate('crates/c', 'c', 'publish = ["internal"]');
  expect(
    (await f.discover()).packages.map((pkg) => [
      pkg.name,
      pkg.private,
      pkg.publish,
    ]),
  ).toEqual([
    ['a', true, false],
    ['b', true, []],
    ['c', false, ['internal']],
  ]);
});

test('publish.workspace=true inherits the workspace publication policy', async () => {
  const f = await fixture(
    '[workspace]\nmembers = ["crates/*"]\n[workspace.package]\npublish = false\n',
  );
  await f.crate('crates/a', 'a', 'publish.workspace = true');
  expect((await f.discover()).packages).toMatchObject([
    { name: 'a', private: true, publish: false },
  ]);
});

test('a virtual workspace root in members does not become a crate', async () => {
  const f = await fixture('[workspace]\nmembers = ["."]\n');
  expect((await f.discover()).packages).toEqual([]);
});

test('root Cargo packages are members of their workspace', async () => {
  const f = await fixture(
    '[package]\nname = "root-crate"\nversion = "0.1.0"\n[workspace]\nmembers = ["crates/*"]\n',
  );
  await f.file('src/lib.rs', '');
  await f.crate('crates/a', 'a');
  expect(
    (await f.discover()).packages.map((pkg) => [pkg.name, pkg.path]),
  ).toEqual([
    ['root-crate', '.'],
    ['a', 'crates/a'],
  ]);
});

test('a standalone Cargo package is a one-package workspace', async () => {
  const f = await fixture('[package]\nname = "standalone"\npublish = false\n');
  expect((await f.discover()).packages).toMatchObject([
    { ecosystem: 'cargo', name: 'standalone', path: '.', private: true },
  ]);
});

test('Cargo duplicate-name validation includes publish=false crates', async () => {
  const f = await fixture('[workspace]\nmembers = ["crates/*"]\n');
  await f.crate('crates/a', 'duplicate');
  await f.crate('crates/b', 'duplicate', 'publish = false');
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACEDUPLICATE',
    message: expect.stringMatching(/crates\/a.*crates\/b/),
  });
});

test('mixed npm and Cargo workspaces use separate name namespaces', async () => {
  const f = await fixture('[workspace]\nmembers = ["crates/*"]\n');
  await f.file(
    'package.json',
    '{"name":"root","private":true,"workspaces":["packages/*"]}',
  );
  await f.file('packages/shared/package.json', '{"name":"shared"}');
  await f.crate('crates/shared', 'shared');
  expect(await f.discover()).toMatchObject({
    source: 'mixed',
    packages: [
      { ecosystem: 'cargo', name: 'shared' },
      { ecosystem: 'npm', name: 'shared' },
    ],
  });
});

test('local path dependencies automatically become workspace members, including inherited and target dependencies', async () => {
  const f = await fixture(
    '[workspace]\nmembers = ["crates/a"]\n[workspace.dependencies]\nshared = { path = "crates/shared" }\n',
  );
  await f.crate(
    'crates/a',
    'a',
    '[dependencies]\nshared.workspace = true\n[target.\'cfg(unix)\'.build-dependencies]\nhelper = { path = "../helper" }',
  );
  await f.crate('crates/shared', 'shared');
  await f.crate(
    'crates/helper',
    'helper',
    '[dev-dependencies]\nshared = { path = "../shared" }',
  );
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'a',
    'helper',
    'shared',
  ]);
});

test('legacy Cargo dependency tables contribute members, with canonical spelling taking precedence', async () => {
  const f = await fixture('[workspace]\nmembers = ["crates/a"]\n');
  await f.file(
    'crates/a/Cargo.toml',
    `[package]\nname="a"\nversion="0.1.0"\nedition="2021"\n[dev-dependencies]\nhelper={path="../helper"}\n[dev_dependencies]\nignored={path="../ignored"}\n[target.'cfg(unix)'.build_dependencies]\nplatform={path="../platform"}\n`,
  );
  await f.crate('crates/helper', 'helper');
  await f.crate('crates/ignored', 'ignored');
  await f.crate('crates/platform', 'platform');
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual([
    'a',
    'helper',
    'platform',
  ]);
});

test('excluded local path dependencies stay out of the workspace inventory', async () => {
  const f = await fixture(
    '[workspace]\nmembers = ["crates/a"]\nexclude = ["crates/helper"]\n',
  );
  await f.crate(
    'crates/a',
    'a',
    '[dependencies]\nhelper = { path = "../helper" }',
  );
  await f.crate('crates/helper', 'helper');
  expect((await f.discover()).packages.map((pkg) => pkg.name)).toEqual(['a']);
});

test.each([
  '[workspace',
  '[workspace]\nmembers = false',
  '[workspace]\nexclude = [7]',
  '[workspace]\nmembers = ["missing/*"]',
])('invalid Cargo workspace fails: %s', async (toml) => {
  const f = await fixture(toml);
  await expect(f.discover()).rejects.toHaveProperty('semanticRelease', true);
});

test.each([
  'publish = "false"',
  'publish = [7]',
  'publish.workspace = false',
  'publish.workspace = true',
])('invalid or unresolved publish policy fails: %s', async (publish) => {
  const f = await fixture('[workspace]\nmembers = ["crates/*"]\n');
  await f.crate('crates/a', 'a', publish);
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACEMANIFEST',
  });
});

test('declared members must contain a Cargo package manifest', async () => {
  const f = await fixture('[workspace]\nmembers = ["crates/*"]\n');
  await f.file('crates/missing/README.md', 'not a crate');
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACEMANIFEST',
  });
});

test('explicit member paths cannot escape the repository', async () => {
  const f = await fixture('[workspace]\nmembers = ["../outside"]\n');
  await expect(f.discover()).rejects.toMatchObject({ code: 'EWORKSPACEPATH' });
});

test.each(['crates/alias', 'crates/*'])(
  'crate directory aliases cannot bypass workspace boundaries: %s',
  async (pattern) => {
    const f = await fixture(`[workspace]\nmembers = ["${pattern}"]\n`);
    const outside = await fixture('[package]\nname = "outside"\n');
    await mkdir(join(f.root, 'crates'));
    await symlink(outside.root, join(f.root, 'crates/alias'), 'dir');
    await expect(f.discover()).rejects.toMatchObject({
      code: 'EWORKSPACEPATH',
    });
  },
);

test.each(['crates/**', 'crates/alias/**'])(
  'glob traversal stops before following cyclic directory aliases: %s',
  async (pattern) => {
    const f = await fixture(`[workspace]\nmembers = ["${pattern}"]\n`);
    const outside = await fixture('[package]\nname="outside"\n');
    await mkdir(join(f.root, 'crates'));
    await symlink(outside.root, join(f.root, 'crates/alias'), 'dir');
    await symlink(outside.root, join(outside.root, 'a'), 'dir');
    await symlink(outside.root, join(outside.root, 'b'), 'dir');
    await expect(f.discover()).rejects.toMatchObject({
      code: 'EWORKSPACEPATH',
    });
  },
  3_000,
);

test('nested workspace roots cannot silently become parent workspace members', async () => {
  const f = await fixture('[workspace]\nmembers = ["crates/*"]\n');
  await f.crate('crates/a', 'a', '[workspace]');
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACECONFIG',
  });
});

test('a member pointing to another workspace is rejected', async () => {
  const f = await fixture('[workspace]\nmembers = ["crates/*"]\n');
  await f.crate('crates/a', 'a', 'workspace = "../elsewhere"');
  await expect(f.discover()).rejects.toMatchObject({
    code: 'EWORKSPACECONFIG',
  });
});

test.skipIf(spawnSync('cargo', ['--version']).status !== 0)(
  'inventory agrees with real offline Cargo metadata',
  async () => {
    const f = await fixture(
      '[workspace]\nmembers = [".", "crates/*", "crates/forced"]\nexclude = ["crates/ignored", "crates/forced", "crates/literal*"]\nresolver = "3"\n[workspace.package]\npublish = false\n',
    );
    await f.crate(
      'crates/a',
      'a',
      'publish.workspace = true\n[dependencies]\nhelper = { path = "../../internal/helper" }',
    );
    await f.crate('crates/b', 'b', 'publish = ["internal"]');
    await f.crate('crates/ignored', 'ignored');
    await f.crate('crates/forced', 'forced', 'publish = false');
    await f.crate('crates/literal', 'literal');
    await f.crate('internal/helper', 'helper', 'publish = []');
    const before = await readFile(join(f.root, 'Cargo.toml'), 'utf8');
    const inventory = await f.discover();
    expect(await readdir(f.root)).not.toContain('Cargo.lock');
    const metadata = JSON.parse(
      execFileSync(
        'cargo',
        ['metadata', '--offline', '--no-deps', '--format-version=1'],
        { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    const members = new Set(metadata.workspace_members);
    expect(
      // Cargo metadata normalizes publish=false to an empty registry list.
      inventory.packages
        .map((pkg) => [pkg.name, pkg.publish === false ? [] : pkg.publish])
        .sort(),
    ).toEqual(
      metadata.packages
        .filter((pkg: { id: string }) => members.has(pkg.id))
        .map((pkg: { name: string; publish: string[] | null }) => [
          pkg.name,
          pkg.publish ?? true,
        ])
        .sort(),
    );
    expect(await readFile(join(f.root, 'Cargo.toml'), 'utf8')).toBe(before);
  },
);
