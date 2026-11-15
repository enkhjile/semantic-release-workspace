import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { registry } from './fixtures/registry.js';
import { fixture } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(cleanupFixtures);

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

test('real semantic-release trusts accepted uploads despite hidden metadata and skips no-change runs', async () => {
  const { repo, service, settings } = await setup();
  service.control('hide-npm');
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmVisibilityReads?.['visibility-core'] ?? 0).toBe(0);
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok, retry.logs).toBe(true);
  expect(retry.result).toBe(false);
  expect(service.state().uploads).toEqual(['npm:visibility-core@1.1.0']);
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT'),
  ).toHaveLength(1);
  expect(repo.state().status).toBe('complete');
  expect(repo.tags()).toContain('npm/visibility-core@1.1.0');
});

test('npm packages a manual dependency upgrade without waiting for registry visibility', async () => {
  const { repo, service, settings } = await setup();
  mkdirSync(join(repo.cwd, 'packages/app'));
  writeFileSync(
    join(repo.cwd, 'packages/app/package.json'),
    JSON.stringify({
      name: 'visibility-app',
      version: '1.0.0',
      dependencies: { 'visibility-core': '=1.1.0' },
    }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add app with a manual core upgrade');
  service.control('hide-npm');
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'npm:visibility-core@1.1.0',
    'npm:visibility-app@1.1.0',
  ]);
  expect(service.state().npmVisibilityReads).toBeUndefined();
  expect(
    service.state().npm['visibility-app']['1.1.0'].metadata.dependencies,
  ).toEqual({ 'visibility-core': '=1.1.0' });
});

test.each([false, true])(
  'real semantic-release repairs hidden upload tags in a fresh clone (legacy receipt: %s)',
  async (legacy) => {
    const { repo, service, settings, packs } = await setup();
    const refs = repo.refs();
    expect(repo.run({ ...settings, dryRun: true }).ok).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().uploads).toEqual([]);
    const hook = join(repo.remote, 'hooks/update');
    writeFileSync(
      hook,
      '#!/bin/sh\ncase "$1" in refs/tags/npm/*) exit 1;; esac\n',
    );
    chmodSync(hook, 0o755);
    service.control('hide-npm');
    expect(repo.run(settings).ok).toBe(false);
    const entry = repo.state().execution.packages[0];
    expect(entry).toMatchObject({
      intent: true,
      published: true,
      tagged: false,
    });
    if (legacy) {
      const pending = repo.state();
      pending.execution.packages[0].published = false;
      pending.execution.packages[0].acknowledged = true;
      repo.git(
        repo.remote,
        'notes',
        '--ref=refs/notes/semantic-release-workspace',
        'add',
        '-f',
        '-m',
        JSON.stringify(pending),
        repo.git(repo.cwd, 'rev-list', '--max-parents=0', 'HEAD'),
      );
      expect(repo.state().execution.packages[0]).toMatchObject({
        published: false,
        acknowledged: true,
      });
    }
    unlinkSync(hook);
    const retry = repo.run(settings, repo.clone());
    expect(retry.ok, retry.logs).toBe(true);
    expect(repo.state().status).toBe('complete');
    expect(repo.state().execution.packages[0].artifact).toEqual(entry.artifact);
    expect(service.state().uploads).toEqual(['npm:visibility-core@1.1.0']);
    expect(service.state().npmVisibilityReads?.['visibility-core'] ?? 0).toBe(
      0,
    );
    expect(packs()).toBe('pack\n');
  },
);

test('real semantic-release rejects a conflicting registry integrity after a hidden upload', async () => {
  const { repo, service, settings, packs } = await setup();
  settings.pluginConfig.npm.visibilityTimeout = 0;
  service.control('once-drop-unreadable');
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
