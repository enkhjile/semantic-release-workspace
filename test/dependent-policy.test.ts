import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, test, vi } from 'vitest';
import { archiveFile } from '../src/archive.js';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { registry } from './fixtures/registry.js';
import { fixture } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(cleanupFixtures);

test.each(['npm', 'cargo'] as const)(
  '%s preserves explicit requirements through independent releases and manual upgrades',
  async (ecosystem) => {
    const repo = fixture();
    const service = await registry();
    const settings = {
      env: service.env,
      pluginConfig: {
        publish: true,
        npm: { registry: service.url, visibilityTimeout: 0 },
        cargo: { registry: 'fixture' },
      },
    };
    const file = (path: string, value: string) => {
      mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
      writeFileSync(join(repo.cwd, path), value);
    };
    const commit = (message: string) => {
      repo.git(repo.cwd, 'add', '.');
      repo.commit(message);
    };
    const prefix = ecosystem === 'cargo' ? 'manual-' : '';
    const source = (name: string) =>
      ecosystem === 'cargo'
        ? `packages/${name}/src/lib.rs`
        : `packages/${name}/index.js`;
    const manifest = (name: string, requirement = '1.0.0') => {
      file(
        `packages/${name}/${ecosystem === 'cargo' ? 'Cargo.toml' : 'package.json'}`,
        ecosystem === 'cargo'
          ? `[package]\nname="manual-${name}"\nversion="1.0.0"\nedition="2024"\nlicense="MIT"\ndescription="Manual requirements fixture"\n${name === 'app' ? `[dependencies]\nmanual-core={path="../core",version="=${requirement}"}\n` : ''}`
          : JSON.stringify({
              name,
              version: '1.0.0',
              ...(name === 'app'
                ? { dependencies: { core: requirement } }
                : {}),
            }),
      );
    };
    if (ecosystem === 'cargo') {
      file('Cargo.toml', '[workspace]\nmembers=["packages/*"]\nresolver="3"\n');
      file(
        '.cargo/config.toml',
        `[registries.fixture]\nindex="sparse+${service.url}/cargo/index/"\n`,
      );
      file('.gitignore', 'Cargo.lock\ntarget/\n');
    } else
      file(
        'package.json',
        JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      );
    for (const name of ['core', 'app']) {
      manifest(name);
      file(
        source(name),
        ecosystem === 'cargo'
          ? 'pub fn value() -> u8 { 1 }\n'
          : 'export const value = 1;\n',
      );
    }
    commit('chore: introduce workspace');
    file(
      source('core'),
      ecosystem === 'cargo'
        ? 'pub fn value() -> u8 { 2 }\n'
        : 'export const value = 2;\n',
    );
    commit('fix: repair core');
    const refs = repo.refs();
    const dry = repo.run({ ...settings, dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().uploads).toEqual([]);
    const first = repo.run(settings);
    expect(first.ok, first.logs).toBe(true);
    expect(service.state().uploads).toEqual([
      `${ecosystem}:${prefix}core@1.0.1`,
    ]);
    expect(repo.tags()).not.toContain(`${ecosystem}/${prefix}app@1.0.1`);

    // The user chooses which released version the app requires.
    manifest('app', '1.0.1');
    commit('fix: upgrade app dependency to core 1.0.1');
    const app = repo.run(settings);
    expect(app.ok, app.logs).toBe(true);
    expect(service.state().uploads.slice(1)).toEqual([
      `${ecosystem}:${prefix}app@1.0.1`,
    ]);
    const requirement = (version: string) =>
      ecosystem === 'cargo'
        ? service
            .state()
            .cargo['manual-app'][version].metadata.deps.find(
              (dep: { name: string }) => dep.name === 'manual-core',
            ).version_req
        : service.state().npm.app[version].metadata.dependencies.core;
    expect(requirement('1.0.1')).toBe(
      ecosystem === 'cargo' ? '=1.0.1' : '1.0.1',
    );

    // Both packages change, but app deliberately stays on the older registry version.
    for (const name of ['core', 'app'])
      file(
        source(name),
        ecosystem === 'cargo'
          ? 'pub fn value() -> u8 { 3 }\n'
          : 'export const value = 3;\n',
      );
    commit('fix: repair both packages without upgrading requirements');
    service.control('unreadable');
    const failed = repo.run(settings);
    expect(failed.ok, failed.logs).toBe(false);
    expect(service.state().uploads.slice(2)).toEqual([
      `${ecosystem}:${prefix}app@1.0.2`,
    ]);
    const frozen = repo.state().planning.plan;
    if (ecosystem === 'npm') {
      const original = repo.state();
      const legacy = structuredClone(original);
      legacy.planning.plan.packages.find(
        (pkg: { name: string }) => pkg.name === 'app',
      ).dependencyUpdates = [
        {
          dependency: 'npm:core',
          manifestPath: 'packages/app/package.json',
          field: ['dependencies', 'core'],
          from: '1.0.1',
          to: '1.0.2',
          publishedRange: '1.0.2',
        },
      ];
      const writeJournal = (journal: unknown) =>
        repo.git(
          repo.remote,
          'notes',
          '--ref=refs/notes/semantic-release-workspace',
          'add',
          '-f',
          '-m',
          JSON.stringify(journal),
          repo.anchor,
        );
      writeJournal(legacy);
      const oldRefs = repo.refs();
      const oldUploads = service.state().uploads;
      const rejected = repo.run(settings, repo.clone('main', 'old-policy'));
      expect(rejected.ok, rejected.logs).toBe(false);
      expect(rejected.codes, rejected.logs).toContain('EWORKSPACEPLAN');
      expect(repo.refs()).toBe(oldRefs);
      expect(service.state().uploads).toEqual(oldUploads);
      writeJournal(original);
    }
    service.control('');
    const clone = repo.clone();
    const retry = repo.run(settings, clone);
    expect(retry.ok, retry.logs).toBe(true);
    expect(repo.state().planning.plan).toEqual(frozen);
    expect(service.state().uploads.slice(2)).toEqual([
      `${ecosystem}:${prefix}app@1.0.2`,
      `${ecosystem}:${prefix}core@1.0.2`,
    ]);
    expect(requirement('1.0.2')).toBe(
      ecosystem === 'cargo' ? '=1.0.1' : '1.0.1',
    );
    const record =
      ecosystem === 'cargo'
        ? service.state().cargo['manual-app']['1.0.2']
        : service.state().npm.app['1.0.2'];
    const packed = await archiveFile(
      Buffer.from(record.artifact, 'base64'),
      ecosystem === 'cargo'
        ? 'manual-app-1.0.2/Cargo.toml'
        : 'package/package.json',
    );
    if (ecosystem === 'cargo') {
      const data = parse(packed) as {
        dependencies: { 'manual-core': { version: string; path?: string } };
      };
      expect(data.dependencies['manual-core'].version).toBe('=1.0.1');
      expect(data.dependencies['manual-core'].path).toBeUndefined();
    } else expect(JSON.parse(packed).dependencies.core).toBe('1.0.1');
    const sourceManifest = readFileSync(
      join(
        clone,
        `packages/app/${ecosystem === 'cargo' ? 'Cargo.toml' : 'package.json'}`,
      ),
      'utf8',
    );
    expect(sourceManifest).toContain('1.0.1');
    const noop = repo.run(settings, clone);
    expect(noop.ok, noop.logs).toBe(true);
    expect(noop.result).toBe(false);
  },
);

test.each([true, false, 'true'])(
  'removed synchronizeDependents option %s fails before mutation',
  (synchronizeDependents) => {
    const repo = fixture();
    const refs = repo.refs();
    const result = repo.run({ pluginConfig: { synchronizeDependents } });
    expect(result.ok, result.logs).toBe(false);
    expect(result.codes).toContain('EWORKSPACECONFIG');
    expect(result.message).toContain('synchronizeDependents was removed');
    expect(repo.refs()).toBe(refs);
  },
);

test('explicit workspace requirements remain unchanged while shorthand resolves the released local version', async () => {
  const repo = fixture();
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const [name, requirement] of [
    ['core', null],
    ['explicit', 'workspace:^1.0.0'],
    ['shorthand', 'workspace:^'],
    ['future', 'workspace:^2.0.0'],
  ] as const) {
    mkdirSync(join(repo.cwd, 'packages', name), { recursive: true });
    writeFileSync(
      join(repo.cwd, 'packages', name, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(requirement ? { dependencies: { core: requirement } } : {}),
      }),
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: introduce new APIs\n\nBREAKING CHANGE: replace the API');
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npm.explicit['2.0.0'].metadata.dependencies.core).toBe(
    '^1.0.0',
  );
  expect(service.state().npm.future['2.0.0'].metadata.dependencies.core).toBe(
    '^2.0.0',
  );
  expect(
    service.state().npm.shorthand['2.0.0'].metadata.dependencies.core,
  ).toBe('^2.0.0');
});

test('Cargo release ordering ignores cycles between already published explicit versions', async () => {
  const repo = fixture();
  const service = await registry();
  const file = (path: string, value: string) => {
    mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
    writeFileSync(join(repo.cwd, path), value);
  };
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  };
  file('Cargo.toml', '[workspace]\nmembers=["crates/*"]\nresolver="3"\n');
  file(
    '.cargo/config.toml',
    `[registries.fixture]\nindex="sparse+${service.url}/cargo/index/"\n`,
  );
  file('.gitignore', 'Cargo.lock\ntarget/\n');
  const manifest = (name: string, dependency?: string) =>
    `[package]\nname="cycle-${name}"\nversion="1.0.0"\nedition="2024"\nlicense="MIT"\ndescription="Manual requirements fixture"\n${dependency ? `[dependencies]\ncycle-${dependency}={path="../${dependency}",version="=1.1.0"}\n` : ''}`;
  for (const name of ['a', 'b']) {
    file(`crates/${name}/Cargo.toml`, manifest(name));
    file(`crates/${name}/src/lib.rs`, 'pub fn value() -> u8 { 1 }\n');
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: publish independent crates');
  const initial = repo.run(settings);
  expect(initial.ok, initial.logs).toBe(true);
  file('crates/a/Cargo.toml', manifest('a', 'b'));
  file('crates/b/Cargo.toml', manifest('b', 'a'));
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: consume already published dependencies');
  const result = repo.run(settings, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:cycle-a@1.1.0',
    'cargo:cycle-b@1.1.0',
    'cargo:cycle-a@1.1.1',
    'cargo:cycle-b@1.1.1',
  ]);
  expect(repo.state().planning.plan.groups).toEqual([
    ['cargo:cycle-a'],
    ['cargo:cycle-b'],
  ]);
});
