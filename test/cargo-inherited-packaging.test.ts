import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

async function setup(inherited = true, shared = false) {
  const repo = fixture();
  const service = await registry();
  const files: Record<string, string> = {
    '.gitignore': 'Cargo.lock\ntarget/\n',
    '.cargo/config.toml': `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
    'Cargo.toml': `[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n\n[workspace.package]\nversion = "1.0.0" # canonical root version\nedition = "2024" # canonical edition\nlicense = "MIT"\n${shared ? '\n[workspace.dependencies]\nrenamed = { package = "inherited-core", path = "crates/core", version = "=1.0.0" } # canonical dependency\n' : ''}`,
    'crates/core/Cargo.toml': `[package]\nname = "inherited-core"\nversion.workspace = true # canonical inherited version\n${inherited ? 'edition.workspace = true # canonical inherited edition\nlicense.workspace = true\n' : 'edition = "2024"\nlicense = "MIT"\n'}description = "Inherited packaging fixture"\npublish = ["fixture"]\n`,
    'crates/core/src/lib.rs': 'pub fn value() -> u32 { 1 }\n',
    'crates/adapter/Cargo.toml': `[package]\nname = "inherited-adapter"\nversion.workspace = true\nedition.workspace = true\nlicense.workspace = true\ndescription = "Inherited packaging fixture"\npublish = ["fixture"]\n\n[dependencies]\n${shared ? 'renamed.workspace = true # canonical shared dependency\n' : 'renamed = { package = "inherited-core", path = "../core", version = "=1.0.0" } # canonical direct dependency\n'}`,
    'crates/adapter/src/lib.rs': 'pub fn value() -> u32 { renamed::value() }\n',
    // Neither private crate exists in the registry. Keeping them in staged
    // resolution would require an unpublished private dependency after projection.
    'crates/private-tool/Cargo.toml':
      '[package]\nname = "private-tool"\nversion = "1.0.0"\nedition = "2024"\npublish = false\n\n[dependencies]\nprivate-helper = { path = "../private-helper", version = "=1.0.0" }\n',
    'crates/private-tool/src/lib.rs':
      'pub fn value() -> u32 { private_helper::value() }\n',
    'crates/private-helper/Cargo.toml':
      '[package]\nname = "private-helper"\nversion = "1.0.0"\nedition = "2024"\npublish = false\n',
    'crates/private-helper/src/lib.rs': 'pub fn value() -> u32 { 0 }\n',
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(repo.cwd, file, '..'), { recursive: true });
    writeFileSync(join(repo.cwd, file), contents);
  }
  // Establish that the original fixture is valid native Cargo, before asking
  // semantic-release to prepare or package any changed manifests.
  const native = spawnSync(
    'cargo',
    [
      'test',
      '--workspace',
      '--offline',
      '--target-dir',
      join(service.root, 'native-target'),
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
  repo.commit('feat: add inherited crates');
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

async function downloadedManifest(
  service: Awaited<ReturnType<typeof registry>>,
  name: string,
) {
  const response = await fetch(
    `${service.url}/cargo/api/v1/crates/${name}/1.1.0/download`,
  );
  expect(response.status).toBe(200);
  return parse(
    await archiveFile(
      Buffer.from(await response.arrayBuffer()),
      `${name}-1.1.0/Cargo.toml`,
    ),
  );
}

test.each([
  {
    inherited: false,
    shared: false,
    label: 'own target metadata and direct dependency',
  },
  {
    inherited: true,
    shared: false,
    label: 'inherited target metadata and direct dependency',
  },
  {
    inherited: true,
    shared: true,
    label: 'inherited target metadata and shared dependency',
  },
])(
  'Cargo publishes native verified crates with $label while isolating private siblings',
  async ({ inherited, shared }) => {
    const { repo, service, settings, unchanged } = await setup(
      inherited,
      shared,
    );
    const refs = repo.refs();
    const dry = repo.run({ ...settings, dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(service.state().requests).toEqual([]);
    expect(repo.refs()).toBe(refs);
    unchanged();

    const result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    expect(service.state().uploads).toEqual([
      'cargo:inherited-core@1.1.0',
      'cargo:inherited-adapter@1.1.0',
    ]);
    expect(repo.state().status).toBe('complete');
    expect(repo.tags()).toContain('cargo/inherited-core@1.1.0');
    expect(repo.tags()).toContain('cargo/inherited-adapter@1.1.0');
    expect(repo.tags().some((tag) => tag.includes('private-'))).toBe(false);
    for (const name of ['inherited-core', 'inherited-adapter']) {
      const manifest = await downloadedManifest(service, name);
      expect(manifest.package).toMatchObject({
        name,
        version: '1.1.0',
        edition: '2024',
        license: 'MIT',
      });
      if (name === 'inherited-adapter')
        expect(manifest.dependencies).toMatchObject({
          renamed: {
            package: 'inherited-core',
            version: '=1.1.0',
            'registry-index': `sparse+${service.url}/cargo/index/`,
          },
        });
    }
    unchanged();
    const before = service.state();
    const completedRefs = repo.refs();
    const noChange = repo.run(settings);
    expect(noChange.ok, noChange.logs).toBe(true);
    expect(noChange.result).toBe(false);
    expect(service.state()).toEqual(before);
    expect(repo.refs()).toBe(completedRefs);
    unchanged();
  },
);

test('fresh-clone Cargo retry retains a published inherited dependency and the rejected dependent artifact', async () => {
  const { repo, service, settings, unchanged } = await setup(true, true);
  service.control('reject-second');
  const failed = repo.run(settings);
  expect(failed.ok).toBe(false);
  expect(service.state().uploads).toEqual(['cargo:inherited-core@1.1.0']);
  const pending = repo.state();
  expect(pending.status).toBe('pending');
  expect(
    pending.execution.packages.find(
      (entry: { id: string }) => entry.id === 'cargo:inherited-core',
    ).published,
  ).toBe(true);
  // A rejected second upload must already have completed native packaging.
  expect(
    pending.execution.packages.find(
      (entry: { id: string }) => entry.id === 'cargo:inherited-adapter',
    ).artifact,
  ).toBeDefined();
  const artifacts = pending.execution.packages.map(
    (entry: { artifact: unknown }) => entry.artifact,
  );
  unchanged();

  service.control('');
  const clone = repo.clone();
  const result = repo.run(settings, clone);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:inherited-core@1.1.0',
    'cargo:inherited-adapter@1.1.0',
  ]);
  expect(repo.state().status).toBe('complete');
  expect(
    repo
      .state()
      .execution.packages.map((entry: { artifact: unknown }) => entry.artifact),
  ).toEqual(artifacts);
  expect(
    (await downloadedManifest(service, 'inherited-adapter')).package,
  ).toMatchObject({
    version: '1.1.0',
    edition: '2024',
    license: 'MIT',
  });
  unchanged(clone);
});
