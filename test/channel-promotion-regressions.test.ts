import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const branches = ['main', 'next'];
function workspace(names = ['a', 'b']) {
  const repo = fixture();
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const name of names) {
    mkdirSync(join(repo.cwd, `packages/${name}`), { recursive: true });
    writeFileSync(
      join(repo.cwd, `packages/${name}/package.json`),
      JSON.stringify({ name, version: '1.0.0' }),
    );
    writeFileSync(
      join(repo.cwd, `packages/${name}/index.js`),
      'export const v = 1;',
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add packages');
  return repo;
}
function checkout(repo: ReturnType<typeof fixture>, branch: string) {
  repo.git(repo.cwd, 'checkout', '-b', branch);
  repo.git(repo.cwd, 'push', '-u', 'origin', branch);
}
function change(
  repo: ReturnType<typeof fixture>,
  name: string,
  message: string,
) {
  writeFileSync(
    join(repo.cwd, `packages/${name}/index.js`),
    `export const v = ${Date.now()};`,
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit(message);
}
function merge(repo: ReturnType<typeof fixture>) {
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--no-edit', 'next');
  repo.git(repo.cwd, 'push', 'origin', 'main');
}

test('publishing rejects a planning-only promotion before recording its channel', () => {
  const repo = workspace(['lib']);
  expect(repo.run({ branches }).ok).toBe(true);
  checkout(repo, 'next');
  change(repo, 'lib', 'feat: next library\n\nBREAKING CHANGE: new API');
  let result = repo.run({ branches });
  expect(result.ok, result.logs).toBe(true);
  merge(repo);
  const refs = repo.refs();
  for (const dryRun of [true, false]) {
    result = repo.run({
      branches,
      dryRun,
      pluginConfig: { publish: true, npm: { registry: 'http://127.0.0.1:1' } },
    });
    expect(result.ok, result.logs).toBe(false);
    expect(result.codes).toContain('EWORKSPACEJOURNAL');
    expect(repo.refs()).toBe(refs);
  }
  result = repo.run({ branches });
  expect(result.ok, result.logs).toBe(true);
  expect(result.logs).toContain('Add default channel to tag workspace-v2.0.0');
});

test.each(['channel-write', 'generate-notes'] as const)(
  'promotion freezes newer package artifacts across fresh-clone retries after %s failure',
  async (failure) => {
    const repo = workspace();
    const service = await registry();
    const settings = {
      branches,
      env: service.env,
      pluginConfig: { publish: true, npm: { registry: service.url } },
    };
    let result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    checkout(repo, 'next');
    change(repo, 'b', 'feat: next b\n\nBREAKING CHANGE: new b API');
    result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    repo.git(repo.cwd, 'checkout', 'main');
    change(repo, 'a', 'feat: improve a');
    result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    const newer = repo
      .state()
      .planning.versions.find((entry: { id: string }) => entry.id === 'npm:a');
    expect(newer.version).toBe('1.2.0');
    let futureBase: string | undefined;
    if (failure === 'generate-notes') {
      change(repo, 'a', 'chore: prepare future a behavior');
      futureBase = repo.git(repo.cwd, 'rev-parse', 'HEAD');
    }
    merge(repo);
    const refs = repo.refs();
    const before = service.state();
    result = repo.run({ ...settings, dryRun: true });
    expect(result.ok, result.logs).toBe(true);
    expect(JSON.stringify(result.result)).toContain('## npm:a@1.2.0');
    expect(JSON.stringify(result.result)).not.toContain('## npm:a@1.1.0');
    expect(repo.refs()).toBe(refs);
    expect(service.state().uploads).toEqual(before.uploads);
    expect(service.state().npmTags).toEqual(before.npmTags);
    expect(
      service
        .state()
        .requests.slice(before.requests.length)
        .every((entry: { method: string }) => entry.method === 'GET'),
    ).toBe(true);

    if (failure === 'channel-write') service.control('reject');
    result = repo.run({
      ...settings,
      ...(failure === 'generate-notes' ? { failure } : {}),
    });
    expect(result.ok, result.logs).toBe(false);
    expect(service.state().npmTags.a.latest).toBe('1.2.0');
    const promotionRef = `refs/notes/workspace-release-channels/${createHash('sha256').update('main').digest('hex')}`;
    const pending = JSON.parse(
      repo.git(
        repo.remote,
        'notes',
        `--ref=${promotionRef}`,
        'show',
        repo.anchor,
      ),
    );
    expect(pending.status).toBe('pending');
    expect(pending.versions).toEqual([
      newer,
      { id: 'npm:b', version: '2.0.0', head: repo.state('next').head },
    ]);

    // Later releases at the merge or an ancestor must not replace frozen versions.
    service.control('');
    if (futureBase) repo.git(repo.cwd, 'checkout', futureBase);
    checkout(repo, failure === 'generate-notes' ? '1.x' : 'future');
    result = repo.run({
      ...settings,
      branches:
        failure === 'generate-notes'
          ? [{ name: '1.x', channel: 'future' }, 'main', 'next']
          : ['main', 'next', 'future'],
      pluginConfig: {
        ...settings.pluginConfig,
        releaseRules: [{ release: 'patch' }],
      },
    });
    expect(result.ok, result.logs).toBe(true);
    if (failure === 'generate-notes')
      expect(service.state().npmTags.a.future).toBe('1.2.1');
    else expect(service.state().npmTags.b.future).toBe('2.0.1');
    const uploads = service.state().uploads;
    result = repo.run(settings, repo.clone('main'));
    expect(result.ok, result.logs).toBe(true);
    expect(service.state().npmTags.a.latest).toBe('1.2.0');
    expect(service.state().npmTags.b.latest).toBe('2.0.0');
    expect(service.state().uploads).toEqual(uploads);
    if (failure === 'generate-notes') {
      expect(JSON.stringify(result.result)).toContain('## npm:b@2.0.0');
      expect(JSON.stringify(result.result)).toContain('## npm:a@1.2.0');
      expect(JSON.stringify(result.result)).not.toContain('## npm:a@1.2.1');
    }
    expect(
      JSON.parse(
        repo.git(
          repo.remote,
          'notes',
          `--ref=${promotionRef}`,
          'show',
          repo.anchor,
        ),
      ),
    ).toMatchObject({ status: 'complete', versions: pending.versions });
  },
);

test('network-style clones fetch retained promotion artifacts before checking their parent commits', async () => {
  const repo = workspace(['lib']);
  const service = await registry();
  const settings = {
    branches,
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, 'next');
  change(repo, 'lib', 'feat: next library\n\nBREAKING CHANGE: new API');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  merge(repo);
  service.control('reject');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(false);
  service.control('');
  const clone = join(dirname(repo.cwd), 'network-clone');
  repo.git(
    repo.cwd,
    'clone',
    '--no-local',
    '--branch',
    'main',
    repo.remote,
    clone,
  );
  repo.git(clone, 'config', 'user.name', 'Lifecycle Test');
  repo.git(clone, 'config', 'user.email', 'lifecycle@example.invalid');
  const uploads = service.state().uploads;
  result = repo.run(settings, clone);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmTags.lib.latest).toBe('2.0.0');
  expect(service.state().uploads).toEqual(uploads);
});

test('empty workspaces can promote repository lifecycle batches with publication enabled', () => {
  const repo = fixture();
  repo.commit('feat: lifecycle batch');
  let result = repo.run({ branches, pluginConfig: { publish: true } });
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, 'next');
  repo.commit('feat: next lifecycle\n\nBREAKING CHANGE: next lifecycle');
  result = repo.run({ branches, pluginConfig: { publish: true } });
  expect(result.ok, result.logs).toBe(true);
  merge(repo);
  result = repo.run({ branches, pluginConfig: { publish: true } });
  expect(result.ok, result.logs).toBe(true);
  expect(result.logs).toContain('Add default channel to tag workspace-v1.0.1');
});
