import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

async function setup() {
  const repo = fixture();
  const service = await registry();
  const trace = join(service.root, 'pack.txt');
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  mkdirSync(join(repo.cwd, 'packages/core'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'packages/core/package.json'),
    JSON.stringify({
      name: 'visibility-core',
      version: '1.0.0',
      scripts: {
        prepack:
          "node -e \"require('node:fs').appendFileSync(process.env.PACK_TRACE, 'pack\\n')\"",
      },
    }),
  );
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'exports.value = 42;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add visibility fixture');
  const settings = {
    env: { ...service.env, PACK_TRACE: trace },
    pluginConfig: {
      publish: true,
      npm: { registry: service.url, visibilityTimeout: 15_000 },
    },
  };
  const packs = () => (existsSync(trace) ? readFileSync(trace, 'utf8') : '');
  return { repo, service, settings, packs };
}

test.each([-1, 0.5, '1000', null])(
  'real semantic-release rejects invalid npm visibility timeout %j before writing release state',
  (visibilityTimeout) => {
    const repo = fixture();
    const refs = repo.refs();
    const result = repo.run({ pluginConfig: { npm: { visibilityTimeout } } });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain('EWORKSPACECONFIG');
    expect(repo.refs()).toBe(refs);
  },
);

test('real semantic-release waits for delayed registry metadata after an accepted upload', async () => {
  const { repo, service, settings } = await setup();
  service.control('hide-npm:5');
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmVisibilityReads['visibility-core']).toBeGreaterThan(
    5,
  );
  expect(service.state().uploads).toEqual(['npm:visibility-core@1.1.0']);
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT'),
  ).toHaveLength(1);
  expect(repo.state().status).toBe('complete');
  expect(repo.tags()).toContain('npm/visibility-core@1.1.0');
});

test('real semantic-release waits across fresh clones without republishing an acknowledged upload', async () => {
  const { repo, service, settings, packs } = await setup();
  settings.pluginConfig.npm.visibilityTimeout = 0;
  service.control('hide-npm');
  const initial = repo.run(settings);
  expect(initial.ok).toBe(false);
  expect(initial.codes).toContain('EWORKSPACEPUBLISH');
  const pending = repo.state();
  expect(pending.status).toBe('pending');
  expect(pending.execution.packages[0]).toMatchObject({
    intent: true,
    acknowledged: true,
    published: false,
    tagged: false,
  });
  const artifact = pending.execution.packages[0].artifact;
  const bytes = service.state().npm['visibility-core']['1.1.0'].artifact;
  expect(packs()).toBe('pack\n');

  const hiddenRetry = repo.run(settings, repo.clone('main', 'hidden-retry'));
  expect(hiddenRetry.ok).toBe(false);
  expect(hiddenRetry.codes).toContain('EWORKSPACEPUBLISH');
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(service.state().uploads).toEqual(['npm:visibility-core@1.1.0']);
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT'),
  ).toHaveLength(1);
  expect(packs()).toBe('pack\n');
  expect(repo.tags()).not.toContain('npm/visibility-core@1.1.0');

  service.control('');
  const recovered = repo.run(settings, repo.clone('main', 'visible-retry'));
  expect(recovered.ok, recovered.logs).toBe(true);
  expect(repo.state().status).toBe('complete');
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(service.state().npm['visibility-core']['1.1.0'].artifact).toBe(bytes);
  expect(service.state().uploads).toEqual(['npm:visibility-core@1.1.0']);
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT'),
  ).toHaveLength(1);
  expect(packs()).toBe('pack\n');
  expect(repo.tags()).toContain('npm/visibility-core@1.1.0');
});

test('real semantic-release rejects a conflicting registry integrity after a hidden upload', async () => {
  const { repo, service, settings, packs } = await setup();
  settings.pluginConfig.npm.visibilityTimeout = 0;
  service.control('hide-npm');
  expect(repo.run(settings).ok).toBe(false);
  const state = service.state();
  state.npm['visibility-core']['1.1.0'].metadata.dist.integrity =
    `sha512-${Buffer.alloc(64, 42).toString('base64')}`;
  writeFileSync(join(service.root, 'registry.json'), JSON.stringify(state));
  service.control('');
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok).toBe(false);
  expect(retry.codes).toContain('EWORKSPACECONFLICT');
  expect(repo.state().status).toBe('pending');
  expect(service.state().uploads).toEqual(['npm:visibility-core@1.1.0']);
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT'),
  ).toHaveLength(1);
  expect(repo.tags()).not.toContain('npm/visibility-core@1.1.0');
  expect(packs()).toBe('pack\n');
});
