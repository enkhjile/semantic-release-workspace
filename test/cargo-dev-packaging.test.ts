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

test.each([
  ['direct', false],
  ['direct', true],
  ['target', false],
  ['target', true],
  ['inherited', false],
  ['inherited', true],
  ['features', true],
  ['legacy-features', true],
  ['versioned', true],
  ['shared', true],
] as const)(
  'Cargo preserves %s dev dependency packaging when helper release=%s',
  async (mode, bumpHelper) => {
    const repo = fixture();
    const service = await registry();
    const privateHelper = mode !== 'versioned' && mode !== 'shared';
    const inherited = mode === 'inherited' || mode === 'shared';
    const omittedFeatures = mode === 'features' || mode === 'legacy-features';
    const dependency = inherited
      ? 'helper.workspace = true\n'
      : `helper = { package = "dev-helper", path = "../helper"${mode === 'versioned' ? ', version = "=1.0.0"' : ''} }\n`;
    const files: Record<string, string> = {
      '.gitignore': 'target/\nCargo.lock\n',
      '.cargo/config.toml': `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
      'Cargo.toml': `[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n${inherited ? '\n[workspace.dependencies]\nhelper = { package = "dev-helper", path = "crates/helper" }\n' : ''}`,
      'crates/helper/Cargo.toml': `[package]\nname = "dev-helper"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "fixture"\npublish = ${privateHelper ? '[]' : '["fixture"]'}\n\n[features]\nextra = []\n`,
      'crates/helper/src/lib.rs': 'pub fn value() -> u32 { 1 }\n',
      'crates/core/Cargo.toml': `[package]\nname = "public-core"\nversion = "1.0.0"\nedition = "${mode === 'legacy-features' ? '2021' : '2024'}"\nlicense = "MIT"\ndescription = "fixture"\npublish = ["fixture"]\n${mode === 'shared' ? '\n[dependencies]\nhelper.workspace = true\n' : ''}\n${mode === 'target' ? "[target.'cfg(unix)'.dev-dependencies]" : '[dev-dependencies]'}\n${dependency}${mode === 'legacy-features' ? '\n[dev_dependencies]\nhelper = { package = "dev-helper", version = "=1.0.0" }\n' : ''}${omittedFeatures || mode === 'shared' || mode === 'versioned' ? '\n[features]\nlocal = []\ntest-extra = ["helper/extra", "local"]\n' : ''}`,
      'crates/core/src/lib.rs': 'pub fn value() -> u32 { 1 }\n',
    };
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
      writeFileSync(join(repo.cwd, path), contents);
    }
    repo.git(repo.cwd, 'add', '.');
    repo.commit(bumpHelper ? 'feat: add crates' : 'chore: set up crates');
    if (!bumpHelper) {
      files['crates/core/src/lib.rs'] = 'pub fn value() -> u32 { 2 }\n';
      writeFileSync(
        join(repo.cwd, 'crates/core/src/lib.rs'),
        files['crates/core/src/lib.rs'],
      );
      repo.git(repo.cwd, 'add', '.');
      repo.commit('feat: update public core');
    }
    if (privateHelper) {
      const target = join(service.root, 'native-target');
      const native = spawnSync(
        'cargo',
        [
          'package',
          '--offline',
          '--registry',
          'fixture',
          '-p',
          'public-core',
          '--target-dir',
          target,
        ],
        {
          cwd: repo.cwd,
          env: { ...repo.env, ...service.env },
          encoding: 'utf8',
        },
      );
      expect(native.status, `${native.stdout}\n${native.stderr}`).toBe(0);
      const manifest = await archiveFile(
        readFileSync(join(target, 'package/public-core-1.0.0.crate')),
        'public-core-1.0.0/Cargo.toml',
      );
      expect(manifest).not.toContain('dev-helper');
      if (omittedFeatures)
        expect(parse(manifest).features).toEqual({
          local: [],
          'test-extra': ['local'],
        });
    }
    const settings = {
      env: service.env,
      pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
    };
    const refs = repo.refs();
    const dry = repo.run({ ...settings, dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().requests).toEqual([]);
    const result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    const state = service.state();
    expect(state.uploads).toEqual(
      privateHelper
        ? ['cargo:public-core@1.1.0']
        : ['cargo:dev-helper@1.1.0', 'cargo:public-core@1.1.0'],
    );
    const entry = state.cargo['public-core']['1.1.0'];
    const manifest = parse(
      await archiveFile(
        Buffer.from(entry.artifact, 'base64'),
        'public-core-1.1.0/Cargo.toml',
      ),
    );
    if (mode === 'versioned')
      expect(manifest['dev-dependencies']).toMatchObject({
        helper: { version: '=1.1.0' },
      });
    else
      expect(manifest['dev-dependencies'] ?? {}).not.toHaveProperty('helper');
    if (omittedFeatures)
      expect(manifest.features).toEqual({ local: [], 'test-extra': ['local'] });
    if (mode === 'shared' || mode === 'versioned')
      expect(manifest.features).toEqual({
        local: [],
        'test-extra': ['helper/extra', 'local'],
      });
    if (mode === 'shared')
      expect(manifest.dependencies).toMatchObject({
        helper: { version: '1.1.0' },
      });
    if (privateHelper) {
      expect(JSON.stringify(manifest)).not.toContain('dev-helper');
      expect(entry.metadata.deps).toEqual([]);
      expect(
        state.requests.some((call: { path: string }) =>
          call.path.includes('/de/v-/dev-helper'),
        ),
      ).toBe(false);
    }
    expect(repo.state().status).toBe('complete');
    for (const [path, contents] of Object.entries(files))
      expect(readFileSync(join(repo.cwd, path), 'utf8'), path).toBe(contents);
    expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  },
);
