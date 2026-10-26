import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { archiveFile } from '../src/archive.js';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('npm resumes alpha releases after stable promotion and backmerge, coordinating exact dependencies', async () => {
  const repo = fixture();
  const service = await registry();
  const settings = {
    branches: ['main', { name: 'alpha', prerelease: true }],
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const name of ['lib', 'app']) {
    mkdirSync(join(repo.cwd, `packages/${name}`), { recursive: true });
    writeFileSync(
      join(repo.cwd, `packages/${name}/package.json`),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(name === 'app' ? { dependencies: { lib: '1.0.0' } } : {}),
      }),
    );
    writeFileSync(
      join(repo.cwd, `packages/${name}/index.js`),
      'export const value = 1;',
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add packages');
  const manifests = ['lib', 'app'].map((name) =>
    readFileSync(join(repo.cwd, `packages/${name}/package.json`), 'utf8'),
  );
  const release = async (branch: string, lib: string, app: string) => {
    const result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    expect(
      repo
        .state(branch)
        .planning.versions.map((pkg: { id: string; version: string }) => [
          pkg.id,
          pkg.version,
        ]),
    ).toEqual([
      ['npm:app', app],
      ['npm:lib', lib],
    ]);
    const state = service.state();
    expect(state.npm.lib[lib].metadata.version).toBe(lib);
    expect(state.npm.app[app].metadata).toMatchObject({
      version: app,
      dependencies: { lib },
    });
    expect(
      JSON.parse(
        await archiveFile(
          Buffer.from(state.npm.app[app].artifact, 'base64'),
          'package/package.json',
        ),
      ),
    ).toMatchObject({ name: 'app', version: app, dependencies: { lib } });
    expect(repo.tags()).toEqual(
      expect.arrayContaining([`npm/lib@${lib}`, `npm/app@${app}`]),
    );
    expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
    expect(
      ['lib', 'app'].map((name) =>
        readFileSync(join(repo.cwd, `packages/${name}/package.json`), 'utf8'),
      ),
    ).toEqual(manifests);
  };
  const change = (value: number, message: string) => {
    writeFileSync(
      join(repo.cwd, 'packages/lib/index.js'),
      `export const value = ${value};`,
    );
    repo.git(repo.cwd, 'add', '.');
    repo.commit(message);
  };

  await release('main', '1.1.0', '1.1.0');
  repo.git(repo.cwd, 'checkout', '-b', 'alpha');
  repo.git(repo.cwd, 'push', '-u', 'origin', 'alpha');
  change(2, 'feat: improve library');
  await release('alpha', '1.2.0-alpha.1', '1.1.1-alpha.1');
  expect(service.state().npmTags).toEqual({
    lib: { latest: '1.1.0', alpha: '1.2.0-alpha.1' },
    app: { latest: '1.1.0', alpha: '1.1.1-alpha.1' },
  });

  const alphaHead = repo.git(repo.cwd, 'rev-parse', 'HEAD');
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--no-ff', 'alpha', '-m', 'chore: merge alpha');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  expect(repo.git(repo.cwd, 'rev-parse', 'HEAD^2')).toBe(alphaHead);
  await release('main', '1.2.0', '1.1.1');
  expect(service.state().npmTags).toEqual({
    lib: { latest: '1.2.0', alpha: '1.2.0-alpha.1' },
    app: { latest: '1.1.1', alpha: '1.1.1-alpha.1' },
  });

  const stableHead = repo.git(repo.cwd, 'rev-parse', 'HEAD');
  repo.git(repo.cwd, 'checkout', 'alpha');
  repo.git(repo.cwd, 'merge', '--ff-only', 'main');
  repo.git(repo.cwd, 'push', 'origin', 'alpha');
  expect(repo.git(repo.cwd, 'rev-parse', 'HEAD')).toBe(stableHead);
  change(3, 'fix: correct library after stable release');
  const refs = repo.refs();
  const beforeDryRun = service.state();
  const dry = repo.run({ ...settings, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(JSON.stringify(dry.result)).toContain('1.2.1-alpha.1');
  expect(JSON.stringify(dry.result)).toContain('1.1.2-alpha.1');
  expect(repo.refs()).toBe(refs);
  expect(service.state().uploads).toEqual(beforeDryRun.uploads);
  expect(service.state().npmTags).toEqual(beforeDryRun.npmTags);
  expect(service.state().npm).toEqual(beforeDryRun.npm);
  expect(
    service
      .state()
      .requests.filter((request: { method: string }) =>
        ['PUT', 'POST', 'DELETE'].includes(request.method),
      ),
  ).toEqual(
    beforeDryRun.requests.filter((request: { method: string }) =>
      ['PUT', 'POST', 'DELETE'].includes(request.method),
    ),
  );

  await release('alpha', '1.2.1-alpha.1', '1.1.2-alpha.1');
  change(4, 'fix: correct another library issue');
  await release('alpha', '1.2.1-alpha.2', '1.1.2-alpha.2');
  expect(service.state().npmTags).toEqual({
    lib: { latest: '1.2.0', alpha: '1.2.1-alpha.2' },
    app: { latest: '1.1.1', alpha: '1.1.2-alpha.2' },
  });
  expect(service.state().uploads).toEqual([
    'npm:lib@1.1.0',
    'npm:app@1.1.0',
    'npm:lib@1.2.0-alpha.1',
    'npm:app@1.1.1-alpha.1',
    'npm:lib@1.2.0',
    'npm:app@1.1.1',
    'npm:lib@1.2.1-alpha.1',
    'npm:app@1.1.2-alpha.1',
    'npm:lib@1.2.1-alpha.2',
    'npm:app@1.1.2-alpha.2',
  ]);
  const completeRefs = repo.refs();
  const completeRegistry = service.state();
  const noop = repo.run(settings);
  expect(noop.ok, noop.logs).toBe(true);
  expect(noop.result).toBe(false);
  expect(repo.refs()).toBe(completeRefs);
  expect(service.state()).toEqual(completeRegistry);
}, 120_000);
