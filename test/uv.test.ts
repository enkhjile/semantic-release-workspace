import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { discoverWorkspaces } from '../src/discovery.js';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { fixture } from './fixtures/repository.js';

afterEach(cleanupFixtures);
function setup() {
  const f = fixture();
  const file = (path: string, content: string) => {
    mkdirSync(join(f.cwd, path, '..'), { recursive: true });
    writeFileSync(join(f.cwd, path), content);
  };
  file(
    'pyproject.toml',
    '[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/ignored*"]\n',
  );
  const member = (name: string, version = '1.2.3', extra = '', path = name) => {
    file(
      `packages/${path}/pyproject.toml`,
      `[project]\nname = "${name}"\nversion = "${version}"\n${extra}\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n`,
    );
    file(`packages/${path}/src.py`, '# initial\n');
  };
  const commit = (message: string) => {
    f.git(f.cwd, 'add', '.');
    return f.commit(message);
  };
  return { ...f, file, member, commit };
}
function preview(
  f: ReturnType<typeof setup>,
  settings: Parameters<typeof f.run>[0] = {},
) {
  const result = f.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  if (!result.result) throw new Error('Expected release preview');
  return JSON.parse(
    result.result.nextRelease.notes.match(/```json\n([\s\S]*?)\n```/)?.[1] ??
      '{}',
  );
}

describe('uv discovery', () => {
  test('includes the root, excludes members, normalizes names and marks applications private', async () => {
    const f = setup();
    f.file(
      'pyproject.toml',
      '[project]\nname = "Root_App"\nversion = "1.0"\n[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/ignored*"]\n',
    );
    f.member('Core.Lib');
    f.member('ignored-bad', 'invalid');
    f.member('app', '1.0.0', '[tool.uv]\npackage = false');
    expect((await discoverWorkspaces(f.cwd)).packages).toMatchObject([
      { ecosystem: 'python', name: 'root-app', path: '.', private: true },
      { ecosystem: 'python', name: 'core-lib', private: false },
      { ecosystem: 'python', name: 'app', private: true },
    ]);
  });
  test('handles empty globs, exclusions, unmanaged projects and generated directories', async () => {
    const f = setup();
    f.file(
      'pyproject.toml',
      '[tool.uv.workspace]\nmembers = ["missing/*", "also-missing", "packages/*", "packages/core"]\nexclude = ["packages/core"]\n',
    );
    f.member('core', 'invalid');
    f.member('app', '1.0.0', '[tool.uv]\nmanaged = false');
    f.file('packages/.venv/pyproject.toml', 'invalid');
    f.file('packages/README.md', 'not a member');
    mkdirSync(join(f.cwd, 'packages/.hidden'));
    expect((await discoverWorkspaces(f.cwd)).packages).toEqual([]);
  });
  test('rejects malformed metadata and nested workspace roots', async () => {
    const f = setup();
    for (const content of [
      '[project]\nname = "core"\nversion = "1.0.0"\n[tool.uv.workspace]\nmembers = []',
      '[project]\nname = "core"\nversion = "1.0.0"\n[tool.uv]\npackage = "false"',
      '[project]\nname = "core"\nversion = "1.0.0"\n[tool.uv]\nmanaged = "false"',
    ]) {
      f.file('packages/core/pyproject.toml', content);
      await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
        code: 'EWORKSPACECONFIG',
      });
    }
    f.file(
      'packages/core/pyproject.toml',
      '[project]\nname = "bad name"\nversion = "1.0.0"',
    );
    await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
      code: 'EWORKSPACEMANIFEST',
    });
    f.file('packages/core/pyproject.toml', '[broken');
    await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
      code: 'EWORKSPACEMANIFEST',
    });
  });
  test('rejects symlink traversal in exclusion prefixes', async () => {
    const f = setup();
    mkdirSync(join(f.cwd, 'outside'));
    symlinkSync(join(f.cwd, 'outside'), join(f.cwd, 'linked'));
    f.file(
      'pyproject.toml',
      '[tool.uv.workspace]\nmembers = []\nexclude = ["linked/*"]\n',
    );
    await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
      code: 'EWORKSPACEPATH',
    });
  });
  test('checks each glob prefix even when another pattern has the repository root as its base', async () => {
    const f = setup();
    const outside = join(f.cwd, '..', 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'note.txt'), 'outside');
    symlinkSync(outside, join(f.cwd, 'linked'));
    for (const configuration of [
      'members = ["no-match-*", "linked/*"]',
      'members = ["no-match-*"]\nexclude = ["linked/*"]',
    ]) {
      f.file('pyproject.toml', `[tool.uv.workspace]\n${configuration}\n`);
      await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
        code: 'EWORKSPACEPATH',
      });
    }
  });
  test.each(['', '[project]\nname = "root"\ndynamic = ["version"]\n'])(
    'ignores the entire unmanaged Python root while retaining JavaScript members: %s',
    { timeout: 60_000 },
    async (project) => {
      const f = setup();
      f.file(
        'pyproject.toml',
        `${project}[tool.uv]\nmanaged = false\n[tool.uv.workspace]\nmembers = ["packages/*"]\n`,
      );
      f.member('core', 'invalid');
      f.file('package.json', '{"private":true,"workspaces":["js/*"]}');
      f.file('js/lib/package.json', '{"name":"lib","version":"1.0.0"}');
      expect(
        (await discoverWorkspaces(f.cwd)).packages.map(
          (pkg) => `${pkg.ecosystem}:${pkg.name}`,
        ),
      ).toEqual(['npm:lib']);
      f.commit('feat: add JavaScript library');
      expect(preview(f).packages).toMatchObject([
        { id: 'npm:lib', nextVersion: '1.1.0' },
      ]);
    },
  );
  test('rejects duplicate normalized names', async () => {
    const f = setup();
    f.member('Core.Lib');
    f.member('core_lib');
    await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
      code: 'EWORKSPACEDUPLICATE',
    });
  });
  test.each(['../outside', '/tmp/outside', 'C:/outside', '!packages/*'])(
    'rejects unsafe patterns: %s',
    async (pattern) => {
      const f = setup();
      f.file(
        'pyproject.toml',
        `[tool.uv.workspace]\nmembers = [${JSON.stringify(pattern)}]\n`,
      );
      await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
        code: 'EWORKSPACEPATH',
      });
    },
  );
  test('rejects explicit symlink members and missing member manifests', async () => {
    const f = setup();
    mkdirSync(join(f.cwd, 'outside'));
    symlinkSync(join(f.cwd, 'outside'), join(f.cwd, 'linked'));
    f.file('pyproject.toml', '[tool.uv.workspace]\nmembers = ["linked"]\n');
    await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
      code: 'EWORKSPACEPATH',
    });
    f.file('pyproject.toml', '[tool.uv.workspace]\nmembers = ["outside"]\n');
    await expect(discoverWorkspaces(f.cwd)).rejects.toMatchObject({
      code: 'EWORKSPACEMANIFEST',
    });
  });
});

describe('uv planning with real semantic-release', { timeout: 90_000 }, () => {
  test('plans a standalone root project without package.json', () => {
    const f = setup();
    rmSync(join(f.cwd, 'package.json'));
    f.file('pyproject.toml', '[project]\nname = "Root_App"\nversion = "1.2"\n');
    f.commit('chore: root application');
    f.file('app.py', '# root feature');
    f.commit('feat: root application feature');
    expect(preview(f).packages).toMatchObject([
      {
        id: 'python:root-app',
        path: '.',
        private: true,
        currentVersion: '1.2',
        nextVersion: '1.3.0',
      },
    ]);
  });
  test('plans changed members only, preserves manual dependencies and dry-run refs', () => {
    const f = setup();
    f.member('core');
    f.member(
      'app',
      '4.0.0',
      'dependencies = ["core>=1.2,<2"]\n[tool.uv.sources]\ncore = { workspace = true }',
    );
    f.file('uv.lock', '# retained lockfile\n');
    f.commit('chore: setup');
    f.file('packages/core/src.py', '# feature\n');
    f.commit('feat: add core feature');
    const before = f.refs();
    const manifest = readFileSync(
      join(f.cwd, 'packages/app/pyproject.toml'),
      'utf8',
    );
    expect(preview(f).packages).toMatchObject([
      { id: 'python:app', nextVersion: null, dependencyUpdates: [] },
      {
        id: 'python:core',
        currentVersion: '1.2.3',
        nextVersion: '1.3.0',
        dependencyUpdates: [],
      },
    ]);
    expect(f.refs()).toBe(before);
    expect(
      readFileSync(join(f.cwd, 'packages/app/pyproject.toml'), 'utf8'),
    ).toBe(manifest);
    expect(readFileSync(join(f.cwd, 'uv.lock'), 'utf8')).toBe(
      '# retained lockfile\n',
    );
    expect(f.run().ok).toBe(true);
    expect(f.run().result).toBe(false);
    f.member(
      'app',
      '4.0.0',
      'dependencies = ["core>=1.3,<2"]\n[tool.uv.sources]\ncore = { workspace = true }',
    );
    f.commit('fix: upgrade app dependency manually');
    expect(preview(f).packages).toMatchObject([
      { id: 'python:app', nextVersion: '4.0.1' },
      { id: 'python:core', nextVersion: null },
    ]);
  });
  test('recovers the frozen plan from a fresh clone and retains PEP 440 prerelease history', () => {
    const f = setup();
    f.member('core', '1.2.0');
    f.commit('chore: setup');
    f.git(f.cwd, 'checkout', '-b', 'alpha');
    f.file('packages/core/src.py', '# feature\n');
    f.commit('feat: alpha feature');
    const branches = ['main', { name: 'alpha', prerelease: true }];
    expect(preview(f, { branches }).packages[0].nextVersion).toBe('1.3.0a1');
    expect(f.run({ branches, failure: 'publish' }).ok).toBe(false);
    expect(f.state('alpha').planning.plan.packages[0].nextVersion).toBe(
      '1.3.0a1',
    );
    const clone = f.clone('alpha');
    const retry = f.run({ branches }, clone);
    expect(retry.ok, retry.logs).toBe(true);
    expect(f.run({ branches }, clone).result).toBe(false);
    f.file('packages/core/src.py', '# fix\n');
    f.commit('fix: alpha fix');
    expect(preview(f, { branches }).packages[0]).toMatchObject({
      currentVersion: '1.3.0a1',
      nextVersion: '1.3.0a2',
    });
  });
  test('promotes alpha to stable and resumes alpha after a backmerge', () => {
    const f = setup();
    f.member('core', '1.0');
    f.commit('chore: setup');
    const branches = ['main', { name: 'alpha', prerelease: true }];
    f.git(f.cwd, 'checkout', '-b', 'alpha');
    f.file('packages/core/src.py', '# feature');
    f.commit('feat: new API');
    const alpha = f.run({ branches });
    expect(alpha.ok, alpha.logs).toBe(true);
    expect(f.state('alpha').planning.plan.packages[0].nextVersion).toBe(
      '1.1.0a1',
    );
    f.git(f.cwd, 'checkout', 'main');
    f.git(f.cwd, 'merge', '--no-ff', 'alpha', '-m', 'Merge alpha');
    f.git(f.cwd, 'push', 'origin', 'main');
    expect(preview(f, { branches }).packages[0].nextVersion).toBe('1.1.0');
    const stable = f.run({ branches });
    expect(stable.ok, stable.logs).toBe(true);
    f.git(f.cwd, 'checkout', 'alpha');
    f.git(f.cwd, 'merge', '--no-ff', 'main', '-m', 'Backmerge main');
    f.git(f.cwd, 'push', 'origin', 'alpha');
    const noChange = f.run({ branches });
    expect(noChange.ok, noChange.logs).toBe(true);
    expect(noChange.result).toBe(false);
    f.file('packages/core/src.py', '# next feature');
    f.commit('feat: next API');
    expect(preview(f, { branches }).packages[0]).toMatchObject({
      currentVersion: '1.1.0',
      nextVersion: '1.2.0a1',
    });
  });
  test('rejects unsupported Python prerelease identifiers before writes', () => {
    const f = setup();
    f.member('core');
    f.commit('chore: setup');
    f.git(f.cwd, 'checkout', '-b', 'preview');
    f.file('packages/core/src.py', '# feature');
    f.commit('feat: preview');
    const refs = f.refs();
    const result = f.run({
      branches: ['main', { name: 'preview', prerelease: true }],
    });
    expect(result.codes).toContain('EWORKSPACECONFIG');
    expect(f.refs()).toBe(refs);
  });
  test('rejects equivalent Python versions already tagged on an unmerged branch', () => {
    const f = setup();
    f.member('core', '1.1.0');
    f.commit('chore: setup');
    f.git(f.cwd, 'checkout', '-b', 'other');
    f.file('note.txt', 'other history');
    f.commit('chore: other branch');
    f.git(f.cwd, 'tag', 'python/core@1.2');
    f.git(f.cwd, 'push', 'origin', '--tags');
    f.git(f.cwd, 'checkout', 'main');
    f.file('packages/core/src.py', '# feature');
    f.commit('feat: new core API');
    const refs = f.refs();
    const result = f.run({ dryRun: true });
    expect(result.codes).toContain('EWORKSPACETAG');
    expect(f.refs()).toBe(refs);
  });
  test.each(['1.2.0b1', '1.2.0rc1'])(
    'rejects a prerelease regression from %s to alpha',
    (version) => {
      const f = setup();
      f.member('core', version);
      f.commit('chore: setup');
      f.git(f.cwd, 'checkout', '-b', 'alpha');
      f.file('packages/core/src.py', '# fix');
      f.commit('fix: core correction');
      const refs = f.refs();
      const result = f.run({
        branches: ['main', { name: 'alpha', prerelease: true }],
      });
      expect(result.codes).toContain('EWORKSPACEVERSION');
      expect(f.refs()).toBe(refs);
    },
  );
  test('uses native Python baseline tags alongside npm and Cargo', () => {
    const f = setup();
    f.member('core', '0.1');
    f.file(
      'package.json',
      '{"name":"root","private":true,"workspaces":["js/*"]}',
    );
    f.file('js/lib/package.json', '{"name":"core","version":"2.0.0"}');
    f.file('Cargo.toml', '[package]\nname = "core"\nversion = "3.0.0"\n');
    f.commit('feat: historical members');
    for (const tag of [
      'python/core@1.4.0',
      'npm/core@2.0.0',
      'cargo/core@3.0.0',
    ])
      f.git(f.cwd, 'tag', tag);
    f.git(f.cwd, 'push', 'origin', '--tags');
    f.file('packages/core/src.py', '# fix\n');
    f.commit('fix: Python only');
    expect(preview(f).packages).toMatchObject([
      { id: 'cargo:core', nextVersion: null },
      { id: 'npm:core', nextVersion: null },
      { id: 'python:core', currentVersion: '1.4.0', nextVersion: '1.4.1' },
    ]);
  });
  test.each([
    '1!2.0',
    '1.0.dev1',
    '1.0.post1',
    '1.0+local',
    '1.2.3.4',
    '1.0.0-alpha.1',
  ])('rejects unsupported static versions before writes: %s', (version) => {
    const f = setup();
    f.member('core', version);
    f.commit('feat: add core');
    const refs = f.refs();
    const result = f.run();
    expect(result.ok).toBe(false);
    expect(result.codes).toContain('EWORKSPACEVERSION');
    expect(f.refs()).toBe(refs);
  });
  test('rejects dynamic versions and publishing without explicit Python trusted publishing before writes', () => {
    const f = setup();
    f.file(
      'packages/core/pyproject.toml',
      '[project]\nname = "core"\ndynamic = ["version"]\n',
    );
    f.commit('feat: dynamic package');
    expect(f.run().codes).toContain('EWORKSPACEVERSION');
    f.member('core');
    f.commit('fix: static version');
    const refs = f.refs();
    for (const dryRun of [true, false]) {
      expect(
        f.run({ dryRun, pluginConfig: { publish: true } }).codes,
      ).toContain('EWORKSPACECONFIG');
    }
    expect(f.refs()).toBe(refs);
  });
});
