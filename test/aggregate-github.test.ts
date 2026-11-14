import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { registry } from './fixtures/registry.js';
import { fixture } from './fixtures/repository.js';

afterEach(cleanupFixtures);

async function workspace() {
  const service = await registry();
  const repo = fixture();
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  mkdirSync(join(repo.cwd, 'packages/core'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'packages/core/package.json'),
    JSON.stringify({
      name: 'core',
      version: '2.0.0',
      publishConfig: { registry: service.url },
    }),
  );
  mkdirSync(join(repo.cwd, 'crates/adapter/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/adapter"]\nresolver = "3"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/adapter/Cargo.toml'),
    '[package]\nname = "adapter"\nversion = "3.0.0"\nedition = "2024"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/adapter/src/lib.rs'),
    'pub fn value() -> u8 { 1 }',
  );
  mkdirSync(join(repo.cwd, '.cargo'));
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  writeFileSync(join(repo.cwd, '.gitignore'), 'Cargo.lock\ntarget/\n');
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: add workspace members');
  repo.git(repo.cwd, 'checkout', '-b', 'alpha');
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const feature = true;',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add JavaScript feature');
  writeFileSync(
    join(repo.cwd, 'crates/adapter/src/lib.rs'),
    'pub fn value() -> u8 { 2 }',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: correct Rust adapter');
  return Object.assign(repo, { service });
}

function run(
  repo: Awaited<ReturnType<typeof workspace>>,
  settings = {},
  cwd = repo.cwd,
) {
  const stdout = execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./fixtures/run-github-release.mjs', import.meta.url),
      ),
      cwd,
      repo.remote,
      JSON.stringify({
        ...settings,
        env: repo.service.env,
        pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
      }),
    ],
    { cwd, env: repo.env, encoding: 'utf8', timeout: 120_000 },
  );
  const line = stdout.split('\n').find((value) => value.startsWith('RESULT:'));
  if (!line) throw new Error(stdout);
  return JSON.parse(line.slice('RESULT:'.length));
}

test('official GitHub plugin publishes one aggregate alpha release and leaves dry-runs and retries read-only', async () => {
  const repo = await workspace();
  const refs = repo.refs();
  const preview = run(repo, { dryRun: true });
  expect(preview.ok, preview.logs).toBe(true);
  expect(
    preview.requests.every(
      (request: { method: string }) => request.method === 'GET',
    ),
  ).toBe(true);
  expect(repo.refs()).toBe(refs);
  expect(repo.service.state().uploads).toEqual([]);

  const released = run(repo);
  expect(released.ok, released.logs).toBe(true);
  const writes = released.requests.filter(
    (request: { method: string }) => request.method !== 'GET',
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    method: 'POST',
    path: '/repos/fixture/workspace/releases',
    body: {
      tag_name: 'workspace-v1.0.0-alpha.1',
      prerelease: true,
      target_commitish: 'alpha',
    },
  });
  expect(writes[0].body.body).toContain('## npm:core@2.1.0-alpha.1');
  expect(writes[0].body.body).toContain('add JavaScript feature');
  expect(writes[0].body.body).toContain('## cargo:adapter@3.0.1-alpha.1');
  expect(writes[0].body.body).toContain('correct Rust adapter');
  expect(repo.service.state().uploads).toEqual([
    'cargo:adapter@3.0.1-alpha.1',
    'npm:core@2.1.0-alpha.1',
  ]);
  const publishedRefs = repo.refs();
  const retry = run(repo, {}, repo.clone('alpha'));
  expect(retry.ok, retry.logs).toBe(true);
  expect(retry.result).toBe(false);
  expect(
    retry.requests.every(
      (request: { method: string }) => request.method === 'GET',
    ),
  ).toBe(true);
  expect(repo.refs()).toBe(publishedRefs);
}, 120_000);

test('a downstream GitHub rejection retries frozen package notes on a new coordinator tag without uploading packages again', async () => {
  const repo = await workspace();
  const failed = run(repo, { failGithub: true });
  expect(failed.ok).toBe(false);
  expect(failed.logs).toContain('Injected release rejection');
  expect(
    failed.requests.filter(
      (request: { method: string }) => request.method === 'POST',
    ),
  ).toHaveLength(1);
  expect(repo.tags()).toContain('workspace-v1.0.0-alpha.1');
  const uploads = repo.service.state().uploads;
  expect(uploads).toEqual([
    'cargo:adapter@3.0.1-alpha.1',
    'npm:core@2.1.0-alpha.1',
  ]);
  const packageRefs = repo
    .git(repo.remote, 'show-ref', '--tags')
    .split('\n')
    .filter((line) => !line.includes('workspace-v'));
  const clone = repo.clone('alpha');
  const retry = run(repo, {}, clone);
  expect(retry.ok, retry.logs).toBe(true);
  const writes = retry.requests.filter(
    (request: { method: string }) => request.method !== 'GET',
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].body.tag_name).toBe('workspace-v1.0.0-alpha.2');
  const rejected = failed.requests.find(
    (request: { method: string }) => request.method === 'POST',
  );
  expect(writes[0].body.body).toBe(rejected.body.body);
  expect(repo.service.state().uploads).toEqual(uploads);
  expect(
    repo
      .git(repo.remote, 'show-ref', '--tags')
      .split('\n')
      .filter((line) => !line.includes('workspace-v')),
  ).toEqual(packageRefs);
  const refs = repo.refs();
  const noChange = run(repo, {}, clone);
  expect(noChange.ok, noChange.logs).toBe(true);
  expect(noChange.result).toBe(false);
  expect(
    noChange.requests.every(
      (request: { method: string }) => request.method === 'GET',
    ),
  ).toBe(true);
  expect(repo.refs()).toBe(refs);
  expect(repo.service.state().uploads).toEqual(uploads);
}, 120_000);
