import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, test, vi } from 'vitest';
import { archiveFile } from '../src/archive.js';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const repo = fixture({ synchronizeDependents: true });
  const service = await registry();
  const inherited =
    'version.workspace = true\nedition.workspace = true\nlicense.workspace = true\n';
  const privateCrate = (name: string, helper?: string) =>
    `[package]\nname = "${name}"\n${inherited}publish = false\n${helper ? `\n[dependencies]\nprivate-helper = { path = "${helper}", version = "=1.0.0" }\n` : ''}`;
  const files: Record<string, string> = {
    '.gitignore': 'Cargo.lock\ntarget/\n',
    '.cargo/config.toml': `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
    'Cargo.toml':
      '[workspace]\nmembers = ["crates/core", "crates/outer", "crates/outer/inner", "crates/outer/inner/nested", "crates/out", "crates/private-helper"]\nresolver = "3"\n\n[workspace.package]\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\n\n[workspace.dependencies]\nrenamed = { package = "nested-core", path = "crates/core", version = "=1.0.0" }\n',
    'crates/core/Cargo.toml': `[package]\nname = "nested-core"\n${inherited}description = "Nested packaging fixture"\npublish = ["fixture"]\n`,
    'crates/core/src/lib.rs': 'pub fn value() -> u32 { 1 }\n',
    'crates/outer/Cargo.toml': privateCrate(
      'private-outer',
      '../private-helper',
    ),
    'crates/outer/inner/Cargo.toml': privateCrate(
      'private-inner',
      '../../private-helper',
    ),
    'crates/outer/inner/nested/Cargo.toml': `[package]\nname = "nested-adapter"\n${inherited}description = "Nested packaging fixture"\npublish = ["fixture"]\n\n[dependencies]\nrenamed.workspace = true\n`,
    'crates/outer/inner/nested/src/lib.rs':
      'pub fn value() -> u32 { renamed::value() }\n',
    // This sibling shares a textual prefix with "crates/outer" but is not
    // an ancestor. Its unpublished dependency must stay out of packaging.
    'crates/out/Cargo.toml': privateCrate(
      'private-prefix',
      '../private-helper',
    ),
    'crates/private-helper/Cargo.toml': privateCrate('private-helper'),
  };
  for (const directory of [
    'crates/outer',
    'crates/outer/inner',
    'crates/out',
    'crates/private-helper',
  ])
    files[`${directory}/src/lib.rs`] = 'pub fn value() -> u32 { 0 }\n';
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(repo.cwd, file, '..'), { recursive: true });
    writeFileSync(join(repo.cwd, file), contents);
  }
  const native = spawnSync(
    'cargo',
    [
      'test',
      '--workspace',
      '--offline',
      '--target-dir',
      join(service.root, 'target'),
    ],
    {
      cwd: repo.cwd,
      env: { ...repo.env, ...service.env },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  expect(native.status, `${native.stdout}\n${native.stderr}`).toBe(0);
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: add nested Cargo workspace');
  files['crates/core/src/lib.rs'] = 'pub fn value() -> u32 { 2 }\n';
  writeFileSync(
    join(repo.cwd, 'crates/core/src/lib.rs'),
    files['crates/core/src/lib.rs'],
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat(core): add a core capability');
  const settings = {
    env: service.env,
    pluginConfig: {
      publish: true,
      cargo: { registry: 'fixture', trustedPublishing: false },
    },
  };
  const unchanged = (directory = repo.cwd) => {
    for (const [file, contents] of Object.entries(files))
      expect(readFileSync(join(directory, file), 'utf8'), file).toBe(contents);
    expect(repo.git(directory, 'status', '--porcelain')).toBe('');
  };
  return { repo, service, settings, unchanged };
}

async function publishedManifest(
  service: Awaited<ReturnType<typeof registry>>,
  name: string,
  version: string,
) {
  const response = await fetch(
    `${service.url}/cargo/api/v1/crates/${name}/${version}/download`,
  );
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    service.state().cargo[name][version].cksum,
  );
  return parse(await archiveFile(bytes, `${name}-${version}/Cargo.toml`));
}

async function assertPublished(service: Awaited<ReturnType<typeof registry>>) {
  expect(service.state().uploads).toEqual([
    'cargo:nested-core@1.1.0',
    'cargo:nested-adapter@1.0.1',
  ]);
  for (const [name, version] of [
    ['nested-core', '1.1.0'],
    ['nested-adapter', '1.0.1'],
  ] as const) {
    const manifest = await publishedManifest(service, name, version);
    expect(manifest.package).toMatchObject({
      name,
      version,
      edition: '2024',
      license: 'MIT',
    });
    if (name === 'nested-adapter')
      expect(manifest.dependencies).toEqual({
        renamed: {
          package: 'nested-core',
          version: '=1.1.0',
          'registry-index': `sparse+${service.url}/cargo/index/`,
        },
      });
  }
}

test('Cargo publishes a nested member through private inherited ancestors while isolating unrelated siblings', async () => {
  const { repo, service, settings, unchanged } = await setup();
  const refs = repo.refs();
  const dry = repo.run({ ...settings, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(refs);
  unchanged();

  const released = repo.run(settings);
  expect(released.ok, released.logs).toBe(true);
  await assertPublished(service);
  expect(repo.state().status).toBe('complete');
  expect(
    repo
      .tags()
      .filter((tag) => tag.startsWith('cargo/'))
      .sort(),
  ).toEqual(['cargo/nested-adapter@1.0.1', 'cargo/nested-core@1.1.0']);
  unchanged();
  const before = service.state();
  const completedRefs = repo.refs();
  const noChange = repo.run(settings);
  expect(noChange.ok, noChange.logs).toBe(true);
  expect(noChange.result).toBe(false);
  expect(service.state()).toEqual(before);
  expect(repo.refs()).toBe(completedRefs);
  unchanged();
});

test.each(['registry rejection', 'native package failure'])(
  'fresh-clone Cargo retry after %s publishes the nested member without republishing its dependency',
  async (failure) => {
    const { repo, service, settings, unchanged } = await setup();
    const env: Record<string, string> = { ...settings.env };
    const runSettings = { ...settings, env };
    if (failure === 'registry rejection') service.control('reject-second');
    else {
      const nativeCargo = spawnSync('rustup', ['which', 'cargo'], {
        encoding: 'utf8',
      });
      expect(nativeCargo.status, nativeCargo.stderr).toBe(0);
      const directory = join(service.root, 'bin');
      mkdirSync(directory);
      const marker = join(service.root, 'fail-once');
      writeFileSync(marker, '');
      const wrapper = join(directory, 'cargo');
      // Inject one failure before packaging the nested crate; every other
      // invocation, including its fresh-clone retry, executes native Cargo.
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, unlinkSync } = require('node:fs');
if (process.argv[2] === 'package' && process.cwd().endsWith('/crates/outer/inner/nested') && existsSync(${JSON.stringify(marker)})) {
  unlinkSync(${JSON.stringify(marker)});
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(nativeCargo.stdout.trim())}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      );
      chmodSync(wrapper, 0o755);
      env.PATH = `${directory}${delimiter}${repo.env.PATH}`;
    }
    const failed = repo.run(runSettings);
    expect(failed.ok).toBe(false);
    expect(service.state().uploads).toEqual(['cargo:nested-core@1.1.0']);
    const pending = repo.state();
    expect(pending.status).toBe('pending');
    expect(pending.execution.packages[0].published).toBe(true);
    const artifacts = pending.execution.packages.map(
      (entry: { artifact: unknown }) => entry.artifact,
    );
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toBeDefined();
    if (failure === 'registry rejection') {
      // A rejected registry upload must have completed native Cargo packaging.
      expect(artifacts[1], failed.logs).toBeDefined();
    } else expect(artifacts[1], failed.logs).toBeUndefined();
    unchanged();

    service.control('');
    const clone = repo.clone();
    const released = repo.run(runSettings, clone);
    expect(released.ok, released.logs).toBe(true);
    await assertPublished(service);
    const completed = repo.state();
    expect(completed.status).toBe('complete');
    const completedArtifacts = completed.execution.packages.map(
      (entry: { artifact: unknown }) => entry.artifact,
    );
    expect(completedArtifacts[0]).toEqual(artifacts[0]);
    if (failure === 'registry rejection')
      expect(completedArtifacts).toEqual(artifacts);
    else expect(completedArtifacts[1]).toBeDefined();
    for (const entry of completed.execution.packages)
      expect(entry.artifact.sha256).toBe(
        service.state().cargo[entry.id.slice('cargo:'.length)][
          entry.id === 'cargo:nested-core' ? '1.1.0' : '1.0.1'
        ].cksum,
      );
    expect(repo.tags()).toContain('cargo/nested-adapter@1.0.1');
    unchanged(clone);
  },
);
