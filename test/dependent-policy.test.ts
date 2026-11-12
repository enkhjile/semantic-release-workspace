import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function npmPackages(repo: ReturnType<typeof fixture>) {
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const [name, dependency] of [
    ['core', undefined],
    ['exact-app', '1.0.0'],
    ['workspace-app', 'workspace:^1.0.0'],
    ['workspace-star', 'workspace:*'],
    ['external', '^9.0.0'],
  ]) {
    const dir = join(repo.cwd, 'packages', name as string);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(dependency ? { dependencies: { core: dependency } } : {}),
      }),
    );
    writeFileSync(join(dir, 'index.js'), 'export const value = 1;\n');
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add packages');
}

function changeCore(
  repo: ReturnType<typeof fixture>,
  value: number,
  message: string,
) {
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    `export const value = ${value};\n`,
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit(message);
}

test('core-only npm changes release every public member and refresh source pins through a major release', async () => {
  const repo = fixture();
  const service = await registry();
  npmPackages(repo);
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const names = [
    'core',
    'exact-app',
    'external',
    'workspace-app',
    'workspace-star',
  ];
  for (const [version, message, value] of [
    ['1.0.0', '', 1],
    ['1.0.1', 'fix: update core', 2],
    [
      '2.0.0',
      'feat: remove old core API\n\nBREAKING CHANGE: remove old core API',
      3,
    ],
    ['2.0.1', 'fix: update core again', 4],
  ] as const) {
    if (message) changeCore(repo, value, message);
    const before = service.state().uploads.length;
    const refs = repo.refs();
    const dry = repo.run({ ...settings, dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().uploads).toHaveLength(before);
    const result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    expect(service.state().uploads.slice(before)).toEqual(
      names.map((name) => `npm:${name}@${version}`),
    );
    for (const name of ['exact-app', 'workspace-star'])
      expect(service.state().npm[name][version].metadata.dependencies).toEqual({
        core: version,
      });
    expect(
      service.state().npm['workspace-app'][version].metadata.dependencies,
    ).toEqual({ core: `^${version}` });
    expect(service.state().npm.external[version].metadata.dependencies).toEqual(
      { core: '^9.0.0' },
    );
    expect(repo.tags()).toContain(`workspace-v${version}`);
    expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
    const noop = repo.run(settings);
    expect(noop.ok, noop.logs).toBe(true);
    expect(noop.result).toBe(false);
  }
  expect(
    JSON.parse(
      readFileSync(join(repo.cwd, 'packages/exact-app/package.json'), 'utf8'),
    ).dependencies,
  ).toEqual({ core: '1.0.0' });
});

test('core-only Cargo changes release every public crate and keep the tagged workspace resolvable', async () => {
  const repo = fixture();
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  };
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
  );
  mkdirSync(join(repo.cwd, '.cargo'), { recursive: true });
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  writeFileSync(join(repo.cwd, '.gitignore'), 'Cargo.lock\ntarget/\n');
  for (const name of ['core', 'app', 'private']) {
    const dir = join(repo.cwd, 'crates', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'Cargo.toml'),
      `[package]\nname = "policy-${name}"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Policy fixture"\n${name === 'private' ? 'publish = false\n' : ''}${name !== 'core' ? '\n[dependencies]\npolicy-core = { path = "../core", version = "=1.0.0" }\n' : ''}`,
    );
    writeFileSync(
      join(dir, 'src/lib.rs'),
      name === 'core'
        ? 'pub fn value() -> u8 { 1 }\n'
        : 'pub fn value() -> u8 { policy_core::value() }\n',
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add crates');
  const first = repo.run(settings);
  expect(first.ok, first.logs).toBe(true);
  writeFileSync(
    join(repo.cwd, 'crates/core/src/lib.rs'),
    'pub fn value() -> u8 { 2 }\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: update core');
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:policy-core@1.0.0',
    'cargo:policy-app@1.0.0',
    'cargo:policy-core@1.0.1',
    'cargo:policy-app@1.0.1',
  ]);
  expect(service.state().cargo['policy-app']['1.0.1'].metadata.deps).toEqual([
    expect.objectContaining({ name: 'policy-core', version_req: '=1.0.1' }),
  ]);
  const tagged = repo.clone('main', 'tag-check');
  repo.git(tagged, 'checkout', 'workspace-v1.0.1');
  expect(() =>
    execFileSync('cargo', ['check', '--workspace', '--offline'], {
      cwd: tagged,
      env: { ...process.env, ...repo.env, ...service.env },
      stdio: 'pipe',
    }),
  ).not.toThrow();
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
});

test('a partial shared release resumes all members with frozen dependency requirements in a fresh clone', async () => {
  const repo = fixture();
  const service = await registry();
  npmPackages(repo);
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  service.control('reject-second');
  const failed = repo.run(settings);
  expect(failed.ok, failed.logs).toBe(false);
  expect(service.state().uploads).toEqual(['npm:core@1.0.0']);
  service.control('');
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'npm:core@1.0.0',
    'npm:exact-app@1.0.0',
    'npm:external@1.0.0',
    'npm:workspace-app@1.0.0',
    'npm:workspace-star@1.0.0',
  ]);
  expect(
    service.state().npm['exact-app']['1.0.0'].metadata.dependencies,
  ).toEqual({ core: '1.0.0' });
  expect(repo.state().status).toBe('complete');
});

test.each([true, false, 'true'])(
  'rejects the removed synchronizeDependents option (%s)',
  (synchronizeDependents) => {
    const repo = fixture();
    const result = repo.run({ pluginConfig: { synchronizeDependents } });
    expect(result.ok, result.logs).toBe(false);
    expect(result.codes).toContain('EWORKSPACECONFIG');
    expect(result.message).toContain('synchronizeDependents');
  },
);
