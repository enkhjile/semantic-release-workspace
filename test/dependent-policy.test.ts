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

test.each([false, true])(
  'npm core-only changes %s dependent synchronization',
  async (synchronizeDependents) => {
    const repo = fixture();
    const service = await registry();
    const settings = {
      branches: ['main', { name: 'alpha', prerelease: true }],
      env: service.env,
      pluginConfig: {
        publish: true,
        npm: { registry: service.url },
        ...(synchronizeDependents ? { synchronizeDependents: true } : {}),
      },
    };
    writeFileSync(
      join(repo.cwd, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    );
    for (const [name, dependency] of [
      ['core', undefined],
      ['exact-app', '1.0.0'],
      ['workspace-app', 'workspace:^'],
      ['workspace-star', 'workspace:*'],
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
    const first = repo.run(settings);
    expect(first.ok, first.logs).toBe(true);
    expect(service.state().uploads).toEqual([
      'npm:core@1.1.0',
      'npm:exact-app@1.1.0',
      'npm:workspace-app@1.1.0',
      'npm:workspace-star@1.1.0',
    ]);
    const projectionsBefore = repo.state().planning.dependencyRanges;
    const sourceBefore = readFileSync(
      join(repo.cwd, 'packages/exact-app/package.json'),
      'utf8',
    );
    writeFileSync(
      join(repo.cwd, 'packages/core/index.js'),
      'export const value = 2;\n',
    );
    repo.git(repo.cwd, 'add', '.');
    repo.commit('fix: update core');
    const refs = repo.refs();
    const uploads = service.state().uploads;
    const dry = repo.run({ ...settings, dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().uploads).toEqual(uploads);
    if (!synchronizeDependents) {
      service.control('reject');
      const failed = repo.run(settings);
      expect(failed.ok, failed.logs).toBe(false);
      service.control('');
    }
    const result = repo.run(
      settings,
      synchronizeDependents ? repo.cwd : repo.clone(),
    );
    expect(result.ok, result.logs).toBe(true);
    expect(service.state().uploads.slice(4)).toEqual(
      synchronizeDependents
        ? [
            'npm:core@1.1.1',
            'npm:exact-app@1.1.1',
            'npm:workspace-app@1.1.1',
            'npm:workspace-star@1.1.1',
          ]
        : ['npm:core@1.1.1'],
    );
    if (!synchronizeDependents)
      expect(repo.state().planning.dependencyRanges).toEqual(projectionsBefore);
    const tags = repo.tags();
    expect(tags).toContain('npm/core@1.1.1');
    expect(tags.includes('npm/exact-app@1.1.1')).toBe(synchronizeDependents);
    expect(tags.includes('npm/workspace-app@1.1.1')).toBe(
      synchronizeDependents,
    );
    expect(tags.includes('npm/workspace-star@1.1.1')).toBe(
      synchronizeDependents,
    );
    if (synchronizeDependents) {
      expect(
        service.state().npm['exact-app']['1.1.1'].metadata.dependencies,
      ).toEqual({ core: '1.1.1' });
      expect(
        service.state().npm['workspace-app']['1.1.1'].metadata.dependencies,
      ).toEqual({ core: '^1.1.1' });
      expect(
        service.state().npm['workspace-star']['1.1.1'].metadata.dependencies,
      ).toEqual({ core: '1.1.1' });
    }
    expect(
      readFileSync(join(repo.cwd, 'packages/exact-app/package.json'), 'utf8'),
    ).toBe(sourceBefore);
    const noop = repo.run(settings);
    expect(noop.ok, noop.logs).toBe(true);
    expect(noop.result).toBe(false);
    if (!synchronizeDependents) {
      for (const name of ['exact-app', 'workspace-app', 'workspace-star'])
        writeFileSync(
          join(repo.cwd, `packages/${name}/index.js`),
          'export const value = 2;\n',
        );
      repo.git(repo.cwd, 'add', '.');
      repo.commit('fix: update apps');
      const apps = repo.run(settings);
      expect(apps.ok, apps.logs).toBe(true);
      expect(service.state().uploads.slice(5)).toEqual([
        'npm:exact-app@1.1.1',
        'npm:workspace-app@1.1.1',
        'npm:workspace-star@1.1.1',
      ]);
      expect(
        service.state().npm['exact-app']['1.1.1'].metadata.dependencies,
      ).toEqual({ core: '1.1.0' });
      expect(
        service.state().npm['workspace-app']['1.1.1'].metadata.dependencies,
      ).toEqual({ core: '^1.1.1' });
      expect(
        service.state().npm['workspace-star']['1.1.1'].metadata.dependencies,
      ).toEqual({ core: '1.1.1' });
      repo.git(repo.cwd, 'checkout', '-b', 'alpha');
      repo.git(repo.cwd, 'push', '-u', 'origin', 'alpha');
      writeFileSync(
        join(repo.cwd, 'packages/core/index.js'),
        'export const value = 3;\n',
      );
      repo.git(repo.cwd, 'add', '.');
      repo.commit('feat: update core on alpha');
      const beforeAlpha = service.state().uploads;
      const alpha = repo.run(settings);
      expect(alpha.ok, alpha.logs).toBe(true);
      expect(service.state().uploads.slice(beforeAlpha.length)).toEqual([
        'npm:core@1.2.0-alpha.1',
      ]);
    }
  },
);

test.each([false, true])(
  'Cargo core-only changes %s dependent synchronization',
  async (synchronizeDependents) => {
    const repo = fixture();
    const service = await registry();
    const settings = {
      env: service.env,
      pluginConfig: {
        publish: true,
        cargo: { registry: 'fixture' },
        ...(synchronizeDependents ? { synchronizeDependents: true } : {}),
      },
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
    for (const name of ['core', 'app']) {
      const dir = join(repo.cwd, 'crates', name);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'Cargo.toml'),
        `[package]\nname = "policy-${name}"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Policy fixture"\n${name === 'app' ? '\n[dependencies]\npolicy-core = { path = "../core", version = "=1.0.0" }\n' : ''}`,
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
    expect(service.state().uploads).toEqual([
      'cargo:policy-core@1.1.0',
      'cargo:policy-app@1.1.0',
    ]);
    const projectionsBefore = repo.state().planning.dependencyRanges;
    const sourceBefore = readFileSync(
      join(repo.cwd, 'crates/app/Cargo.toml'),
      'utf8',
    );
    writeFileSync(
      join(repo.cwd, 'crates/core/src/lib.rs'),
      'pub fn value() -> u8 { 2 }\n',
    );
    repo.git(repo.cwd, 'add', '.');
    repo.commit('fix: update core');
    const refs = repo.refs();
    const uploads = service.state().uploads;
    const dry = repo.run({ ...settings, dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().uploads).toEqual(uploads);
    const result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    expect(service.state().uploads.slice(2)).toEqual(
      synchronizeDependents
        ? ['cargo:policy-core@1.1.1', 'cargo:policy-app@1.1.1']
        : ['cargo:policy-core@1.1.1'],
    );
    if (!synchronizeDependents)
      expect(repo.state().planning.dependencyRanges).toEqual(projectionsBefore);
    expect(repo.tags().includes('cargo/policy-app@1.1.1')).toBe(
      synchronizeDependents,
    );
    if (!synchronizeDependents) {
      const tagged = repo.clone('main', 'tag-check');
      repo.git(tagged, 'checkout', 'cargo/policy-core@1.1.1');
      expect(() =>
        execFileSync('cargo', ['check', '--workspace', '--offline'], {
          cwd: tagged,
          env: { ...process.env, ...repo.env, ...service.env },
          stdio: 'pipe',
        }),
      ).not.toThrow();
    }
    if (synchronizeDependents)
      expect(
        service.state().cargo['policy-app']['1.1.1'].metadata.deps,
      ).toEqual([
        expect.objectContaining({ name: 'policy-core', version_req: '=1.1.1' }),
      ]);
    expect(readFileSync(join(repo.cwd, 'crates/app/Cargo.toml'), 'utf8')).toBe(
      sourceBefore,
    );
    const noop = repo.run(settings);
    expect(noop.ok, noop.logs).toBe(true);
    expect(noop.result).toBe(false);
    if (!synchronizeDependents) {
      writeFileSync(
        join(repo.cwd, 'crates/app/src/lib.rs'),
        'pub fn value() -> u8 { policy_core::value() + 1 }\n',
      );
      repo.git(repo.cwd, 'add', '.');
      repo.commit('fix: update app');
      const app = repo.run(settings, repo.clone('main', 'app-only'));
      expect(app.ok, app.logs).toBe(true);
      expect(service.state().uploads).toEqual([
        'cargo:policy-core@1.1.0',
        'cargo:policy-app@1.1.0',
        'cargo:policy-core@1.1.1',
        'cargo:policy-app@1.1.1',
      ]);
      expect(
        service.state().cargo['policy-app']['1.1.1'].metadata.deps,
      ).toEqual([
        expect.objectContaining({ name: 'policy-core', version_req: '=1.1.0' }),
      ]);
    }
  },
);

test('real semantic-release rejects a non-boolean dependent synchronization option', () => {
  const repo = fixture();
  const result = repo.run({
    pluginConfig: { synchronizeDependents: 'true' },
  });
  expect(result.ok, result.logs).toBe(false);
  expect(result.codes).toContain('EWORKSPACECONFIG');
  expect(result.message).toContain('synchronizeDependents must be a boolean');
});

test('a core major release does not break later unrelated runs with an unchanged explicit workspace range', async () => {
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
  for (const name of ['core', 'app', 'other']) {
    const dir = join(repo.cwd, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(name === 'app'
          ? { dependencies: { core: 'workspace:^1.0.0' } }
          : {}),
      }),
    );
    writeFileSync(join(dir, 'index.js'), 'export const value = 1;\n');
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add packages');
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const value = 2;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: change core\n\nBREAKING CHANGE: remove old core API');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads.slice(3)).toEqual(['npm:core@2.0.0']);
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(result.result).toBe(false);
  writeFileSync(
    join(repo.cwd, 'packages/other/index.js'),
    'export const value = 2;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: update other');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads.slice(4)).toEqual(['npm:other@1.1.1']);
});

test('a pending synchronized release rejects a policy change and resumes in a fresh clone', async () => {
  const repo = fixture();
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: {
      publish: true,
      npm: { registry: service.url },
      synchronizeDependents: true,
    },
  };
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const name of ['core', 'app']) {
    const dir = join(repo.cwd, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(name === 'app' ? { dependencies: { core: '1.0.0' } } : {}),
      }),
    );
    writeFileSync(join(dir, 'index.js'), 'export const value = 1;\n');
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: add packages');
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const value = 2;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: update core');
  service.control('reject-second');
  const failed = repo.run(settings);
  expect(failed.ok, failed.logs).toBe(false);
  expect(service.state().uploads).toEqual(['npm:core@1.1.0']);
  service.control('');
  const changed = repo.run(
    {
      ...settings,
      pluginConfig: { publish: true, npm: { registry: service.url } },
    },
    repo.clone('main', 'wrong-policy'),
  );
  expect(changed.ok, changed.logs).toBe(false);
  expect(changed.codes).toContain('EWORKSPACEPLAN');
  expect(service.state().uploads).toEqual(['npm:core@1.1.0']);
  const retry = repo.run(settings, repo.clone('main', 'correct-policy'));
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toEqual(['npm:core@1.1.0', 'npm:app@1.0.1']);
  expect(service.state().npm.app['1.0.1'].metadata.dependencies).toEqual({
    core: '1.1.0',
  });
});

test('enabling synchronization catches a pinned dependent up after a changed-only release', async () => {
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
  for (const name of ['core', 'app']) {
    const dir = join(repo.cwd, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(name === 'app' ? { dependencies: { core: '1.0.0' } } : {}),
      }),
    );
    writeFileSync(join(dir, 'index.js'), 'export const value = 1;\n');
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add packages');
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const value = 2;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: update core independently');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'npm:core@1.1.0',
    'npm:app@1.1.0',
    'npm:core@1.1.1',
  ]);
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const value = 3;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: update core with synchronization');
  result = repo.run({
    ...settings,
    pluginConfig: { ...settings.pluginConfig, synchronizeDependents: true },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'npm:core@1.1.0',
    'npm:app@1.1.0',
    'npm:core@1.1.1',
    'npm:core@1.1.2',
    'npm:app@1.1.1',
  ]);
  expect(service.state().npm.app['1.1.1'].metadata.dependencies).toEqual({
    core: '1.1.2',
  });
});

test('a legacy pending core-only plan replays without selecting an external npm dependency', async () => {
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
  for (const name of ['core', 'app']) {
    const dir = join(repo.cwd, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(name === 'app' ? { dependencies: { core: '^2.0.0' } } : {}),
      }),
    );
    writeFileSync(join(dir, 'index.js'), 'export const value = 1;\n');
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: add packages');
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const value = 2;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: update core');
  service.control('reject');
  const first = repo.run(settings);
  expect(first.ok, first.logs).toBe(false);
  expect(service.state().uploads).toEqual([]);
  const journal = repo.state();
  expect(journal.status).toBe('pending');
  expect(
    journal.planning.plan.packages
      .filter((pkg: { nextVersion: string | null }) => pkg.nextVersion)
      .map((pkg: { id: string }) => pkg.id),
  ).toEqual(['npm:core']);
  delete journal.planning.plan.dependencyPolicy;
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
  service.control('');
  const retry = repo.run(
    {
      ...settings,
      pluginConfig: { ...settings.pluginConfig, synchronizeDependents: true },
    },
    repo.clone(),
  );
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toEqual(['npm:core@1.1.0']);
  expect(repo.tags()).not.toContain('npm/app@1.0.1');
});

test('synchronization recognizes a previously published internal version without capturing an external range', async () => {
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
  for (const [name, dependency] of [
    ['core', undefined],
    ['app', '^1.0.0'],
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
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'npm:core@1.1.0',
    'npm:app@1.1.0',
    'npm:external@1.1.0',
  ]);
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const value = 2;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: update core independently');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads.slice(3)).toEqual(['npm:core@1.2.0']);
  writeFileSync(
    join(repo.cwd, 'packages/app/package.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      dependencies: { core: '1.1.0' },
    }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: pin app to earlier core');
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const value = 3;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: update core with synchronization');
  result = repo.run({
    ...settings,
    pluginConfig: { ...settings.pluginConfig, synchronizeDependents: true },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads.slice(4)).toEqual([
    'npm:core@1.2.1',
    'npm:app@1.1.1',
  ]);
  expect(service.state().npm.app['1.1.1'].metadata.dependencies).toEqual({
    core: '1.2.1',
  });
  expect(repo.tags()).not.toContain('npm/external@1.1.1');
});
