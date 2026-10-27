import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function cargoWorkspace(home: string, global: string, local: string) {
  const repo = fixture();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), global);
  mkdirSync(join(repo.cwd, '.cargo'));
  writeFileSync(join(repo.cwd, '.cargo/config.toml'), local);
  mkdirSync(join(repo.cwd, 'crates/lib/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/lib/Cargo.toml'),
    '[package]\nname = "cargo-configuration-fixture"\nversion = "1.0.0"\nedition = "2024"\npublish = ["fixture", "other"]\nlicense = "MIT"\ndescription = "fixture"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/lib/src/lib.rs'),
    'pub fn value() -> u32 { 1 }\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add crate');
  return repo;
}

test('Cargo retains the home default registry when the local registry table only configures credentials', async () => {
  const service = await registry();
  const repo = cargoWorkspace(
    service.env.CARGO_HOME,
    `[registry]\ndefault = "fixture"\n[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
    '[registry]\nglobal-credential-providers = ["cargo:token"]\n',
  );
  const settings = { env: service.env, pluginConfig: { publish: true } };
  const before = repo.refs();
  const dry = repo.run({ ...settings, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(before);
  const first = repo.run({ ...settings, failure: 'publish' });
  expect(first.codes, first.logs).toContain('EINJECTED');
  const retained = repo.state().execution.packages[0];
  expect(retained.destination).toMatchObject({
    registry: 'fixture',
    index: `${service.url}/cargo/index/`,
    api: `${service.url}/cargo`,
  });
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:cargo-configuration-fixture@1.1.0',
  ]);
  expect(repo.state().execution.packages[0].artifact).toEqual(
    retained.artifact,
  );
  expect(repo.state().status).toBe('complete');
});

test('Cargo retains a home named-registry index when local configuration only adds its credential provider', async () => {
  const service = await registry();
  const repo = cargoWorkspace(
    service.env.CARGO_HOME,
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
    '[registries.fixture]\ncredential-provider = "cargo:token"\n',
  );
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  };
  const dry = repo.run({ ...settings, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:cargo-configuration-fixture@1.1.0',
  ]);
  expect(repo.state().execution.packages[0].destination).toMatchObject({
    registry: 'fixture',
    index: `${service.url}/cargo/index/`,
  });
});

test.each(['default', 'index'] as const)(
  'Cargo local %s takes precedence over the corresponding home key',
  async (key) => {
    const service = await registry();
    const other = await registry();
    const repo = cargoWorkspace(
      service.env.CARGO_HOME,
      `[registry]\ndefault = "${key === 'default' ? 'other' : 'fixture'}"\n[registries.fixture]\nindex = "sparse+${key === 'index' ? other.url : service.url}/cargo/index/"\n[registries.other]\nindex = "sparse+${other.url}/cargo/index/"\n`,
      key === 'default'
        ? '[registry]\ndefault = "fixture"\n'
        : `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
    );
    const result = repo.run({
      env: service.env,
      pluginConfig: { publish: true },
    });
    expect(result.ok, result.logs).toBe(true);
    expect(service.state().uploads).toEqual([
      'cargo:cargo-configuration-fixture@1.1.0',
    ]);
    expect(other.state().requests).toEqual([]);
    expect(repo.state().execution.packages[0].destination).toMatchObject({
      registry: 'fixture',
      index: `${service.url}/cargo/index/`,
    });
  },
);
