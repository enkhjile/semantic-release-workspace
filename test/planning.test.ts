import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { archiveFile } from '../src/archive.js';
import type { PlanningState } from '../src/plan-types.js';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const f = fixture({ synchronizeDependents: true });
  function file(path: string, content: string) {
    mkdirSync(join(f.cwd, path, '..'), { recursive: true });
    writeFileSync(join(f.cwd, path), content);
  }
  file(
    'package.json',
    JSON.stringify({
      name: 'root',
      private: true,
      workspaces: ['packages/**'],
    }),
  );
  return {
    ...f,
    file,
    npm(
      name: string,
      version = '1.0.0',
      extra: Record<string, unknown> = {},
      path = `packages/${name}`,
    ) {
      file(`${path}/package.json`, JSON.stringify({ name, version, ...extra }));
      file(`${path}/index.js`, 'initial');
    },
    change(message: string) {
      f.git(f.cwd, 'add', '.');
      return f.commit(message);
    },
  };
}
function plan(
  f: ReturnType<typeof setup>,
  pluginConfig: Record<string, unknown> = {},
  directory = f.cwd,
) {
  const result = f.run({ dryRun: true, pluginConfig }, directory);
  expect(result.ok, result.logs).toBe(true);
  if (!result.result) throw new Error('Expected a release preview');
  const block = result.result.nextRelease.notes.match(
    /```json\n([\s\S]*?)\n```/,
  );
  expect(block, result.result.nextRelease.notes).not.toBeNull();
  return JSON.parse(block?.[1] ?? '{}');
}

describe('package planning with real semantic-release', {
  timeout: 60_000,
}, () => {
  test('only packages owning changed files receive independent versions', () => {
    const f = setup();
    f.npm('a', '1.2.3');
    f.npm('b', '5.0.0');
    const setupHead = f.change('chore: set up packages');
    f.file('packages/a/index.js', 'feature');
    const hash = f.change('feat(b): add behavior in a');
    const result = plan(f);
    expect(result.packages).toMatchObject([
      {
        id: 'npm:a',
        currentVersion: '1.2.3',
        nextVersion: '1.3.0',
        type: 'minor',
        commits: [{ hash }, { hash: setupHead }],
      },
      {
        id: 'npm:b',
        currentVersion: '5.0.0',
        nextVersion: null,
        type: null,
        commits: [{ hash: setupHead }],
      },
    ]);
    expect(f.tags()).toEqual([]);
    expect(f.git(f.cwd, 'status', '--porcelain')).toBe('');
  });

  test('nested packages own their files and shared roots are opt-in', () => {
    const f = setup();
    f.npm('parent');
    f.npm('child', '1.0.0', {}, 'packages/parent/child');
    f.change('chore: setup');
    f.file('packages/parent/child/index.js', 'feature');
    f.change('feat(parent): child only');
    expect(plan(f).packages).toMatchObject([
      { id: 'npm:parent', nextVersion: null },
      { id: 'npm:child', nextVersion: '1.1.0' },
    ]);
    f.file('shared.config', 'changed');
    f.change('fix: shared tooling');
    expect(
      plan(f, { sharedFiles: ['./shared.config'] }).packages,
    ).toMatchObject([
      { id: 'npm:parent', nextVersion: '1.0.1' },
      { id: 'npm:child', nextVersion: '1.1.0' },
    ]);
  });

  test('renames attribute both the removed and added paths', () => {
    const f = setup();
    f.npm('a');
    f.npm('b');
    f.change('chore: setup');
    renameSync(
      join(f.cwd, 'packages/a/index.js'),
      join(f.cwd, 'packages/b/moved.js'),
    );
    f.change('fix: move implementation');
    expect(plan(f).packages).toMatchObject([
      { id: 'npm:a', nextVersion: '1.0.1' },
      { id: 'npm:b', nextVersion: '1.0.1' },
    ]);
  });
  test('npm dependency chains coordinate runtime, peer, workspace and private packages without releasing dev-only dependents', () => {
    const f = setup();
    f.npm('a', '1.0.0', { private: true });
    f.npm('b', '1.0.0', { dependencies: { a: '1.0.0' } });
    f.npm('c', '1.0.0', { optionalDependencies: { b: '1.0.0' } });
    f.npm('dev', '1.0.0', { devDependencies: { a: '1.0.0' } });
    f.npm('peer', '1.0.0', { peerDependencies: { a: '1.0.0' } });
    f.npm('workspace', '1.0.0', { dependencies: { alias: 'workspace:a@*' } });
    f.change('chore: setup');
    f.file('packages/a/index.js', 'feature');
    f.change('feat: enhance a');
    const result = plan(f);
    expect(result.packages).toMatchObject([
      { id: 'npm:a', nextVersion: '1.1.0', private: true },
      {
        id: 'npm:b',
        nextVersion: '1.0.1',
        dependencyUpdates: [
          { dependency: 'npm:a', from: '1.0.0', to: '1.1.0' },
        ],
      },
      { id: 'npm:c', nextVersion: '1.0.1' },
      {
        id: 'npm:dev',
        nextVersion: null,
        dependencyUpdates: [{ dependency: 'npm:a', to: '1.1.0' }],
      },
      { id: 'npm:peer', nextVersion: '2.0.0', type: 'major' },
      {
        id: 'npm:workspace',
        nextVersion: '1.0.1',
        dependencyUpdates: [
          { to: 'workspace:a@*', publishedRange: 'npm:a@1.1.0' },
        ],
      },
    ]);
    expect(
      result.groups.indexOf(
        result.groups.find((group: string[]) => group.includes('npm:a')),
      ),
    ).toBeLessThan(
      result.groups.indexOf(
        result.groups.find((group: string[]) => group.includes('npm:b')),
      ),
    );
  });

  test('dependency cycles settle once without replacing direct minor signals', () => {
    const f = setup();
    f.npm('a', '1.0.0', { dependencies: { b: '1.0.0' } });
    f.npm('b', '1.0.0', { dependencies: { a: '1.0.0' } });
    f.change('chore: setup');
    f.file('packages/a/index.js', 'feature');
    f.change('feat: enhance a');
    const result = plan(f);
    expect(result.packages).toMatchObject([
      { id: 'npm:a', nextVersion: '1.1.0', type: 'minor' },
      { id: 'npm:b', nextVersion: '1.0.1', type: 'patch' },
    ]);
    expect(result.groups).toEqual([['npm:a', 'npm:b']]);
  });

  test('Cargo bare versions use caret compatibility and renamed inherited path dependencies coordinate across target tables', () => {
    const f = setup();
    f.file(
      'Cargo.toml',
      '[workspace]\nmembers=["crates/*"]\n[workspace.package]\nversion="0.2.3"\n[workspace.dependencies]\nrenamed={package="core",path="crates/core",version="0.2.3"}\n',
    );
    f.file(
      'crates/core/Cargo.toml',
      '[package]\nname="core"\nversion.workspace=true\npublish=false\n',
    );
    f.file(
      'crates/app/Cargo.toml',
      `[package]\nname="app"\nversion="1.0.0"\n[target.'cfg(unix)'.build-dependencies]\nrenamed.workspace=true\n`,
    );
    f.file(
      'crates/compatible/Cargo.toml',
      '[package]\nname="compatible"\nversion="1.0.0"\n[dependencies]\napp={path="../app",version="1.0.0"}\n',
    );
    f.npm('core');
    f.change('chore: setup');
    f.file('crates/core/src/lib.rs', 'feature');
    f.change('feat: enhance core');
    const result = plan(f);
    expect(result.packages).toMatchObject([
      {
        id: 'cargo:app',
        nextVersion: '1.0.1',
        dependencyUpdates: [
          {
            dependency: 'cargo:core',
            manifestPath: 'Cargo.toml',
            field: ['workspace', 'dependencies', 'renamed', 'version'],
            from: '0.2.3',
            to: '0.3.0',
          },
        ],
      },
      { id: 'cargo:compatible', nextVersion: null },
      {
        id: 'cargo:core',
        currentVersion: '0.2.3',
        nextVersion: '0.3.0',
        private: true,
      },
      { id: 'npm:core', nextVersion: null },
    ]);
  });

  test('reachable namespaced tags set package-specific baselines and exclude covered commits', () => {
    const f = setup();
    f.npm('a', '0.1.0');
    f.npm('b', '1.0.0');
    f.change('feat: historical code');
    f.git(f.cwd, 'tag', 'npm/a@2.3.4');
    f.git(f.cwd, 'push', 'origin', '--tags');
    f.file('packages/a/index.js', 'repair');
    const hash = f.change('fix: repair a');
    expect(plan(f).packages).toMatchObject([
      {
        id: 'npm:a',
        currentVersion: '2.3.4',
        nextVersion: '2.3.5',
        commits: [{ hash }],
      },
      { id: 'npm:b', nextVersion: '1.1.0' },
    ]);
  });

  test('unowned and skipped commits do not create a package batch', () => {
    const f = setup();
    f.npm('a');
    f.change('chore: setup');
    f.file('README.md', 'root');
    f.change('feat: unowned root');
    expect(f.run({ dryRun: true }).result).toBe(false);
    f.file('packages/a/index.js', 'skip');
    f.change('fix: ignored [skip release]');
    expect(f.run({ dryRun: true }).result).toBe(false);
  });
  test('completed batches retain package versions and projected dependency ranges without rewriting manifests', () => {
    const f = setup();
    f.npm('a');
    f.npm('b', '1.0.0', { dependencies: { a: '1.0.0' } });
    f.npm('peer', '1.0.0', { peerDependencies: { a: '^1.0.0' } });
    f.change('chore: setup');
    f.file('packages/a/index.js', 'breaking');
    f.change('feat: new API\n\nBREAKING CHANGE: removed old API');
    const manifest = readFileSync(
      join(f.cwd, 'packages/b/package.json'),
      'utf8',
    );
    const first = f.run();
    expect(first.ok, first.logs).toBe(true);
    expect(f.state().schemaVersion).toBe(2);
    expect(f.state().planning.versions).toEqual(
      expect.arrayContaining([
        {
          id: 'npm:a',
          version: '2.0.0',
          head: f.git(f.cwd, 'rev-parse', 'HEAD'),
        },
      ]),
    );
    expect(f.run().result).toBe(false);
    f.file('packages/a/index.js', 'fixed');
    f.change('fix: repair new API');
    expect(plan(f).packages).toMatchObject([
      { id: 'npm:a', currentVersion: '2.0.0', nextVersion: '2.0.1' },
      {
        id: 'npm:b',
        currentVersion: '1.0.1',
        nextVersion: '1.0.2',
        dependencyUpdates: [{ from: '1.0.0', to: '2.0.1' }],
      },
      { id: 'npm:peer', currentVersion: '2.0.0', nextVersion: null },
    ]);
    expect(readFileSync(join(f.cwd, 'packages/b/package.json'), 'utf8')).toBe(
      manifest,
    );
  });

  test('published dependency projections survive a newer imported local version', async () => {
    const f = setup();
    const service = await registry();
    const settings = {
      env: service.env,
      pluginConfig: { publish: true, npm: { registry: service.url } },
    };
    const publishedManifest = async (version: string) =>
      JSON.parse(
        await archiveFile(
          Buffer.from(service.state().npm.app[version].artifact, 'base64'),
          'package/package.json',
        ),
      );
    f.npm('lib');
    f.npm('app', '1.0.0', { dependencies: { lib: '1.0.0' } });
    f.change('chore: set up packages');
    f.file('packages/lib/index.js', 'new API');
    f.change('feat: new library API\n\nBREAKING CHANGE: replace API');
    const first = f.run(settings);
    expect(first.ok, first.logs).toBe(true);
    expect((await publishedManifest('1.0.1')).dependencies.lib).toBe('2.0.0');

    f.file('packages/lib/index.js', 'imported API');
    f.change('chore: import newer library release');
    f.git(f.cwd, 'tag', 'npm/lib@3.0.0');
    f.git(f.cwd, 'push', 'origin', 'npm/lib@3.0.0');
    f.file('packages/app/index.js', 'repair');
    f.change('fix: repair application');
    const clone = f.clone();
    const second = f.run(settings, clone);
    expect(second.ok, second.logs).toBe(true);
    expect((await publishedManifest('1.0.2')).dependencies.lib).toBe('2.0.0');
    expect(
      JSON.parse(readFileSync(join(clone, 'packages/app/package.json'), 'utf8'))
        .dependencies.lib,
    ).toBe('1.0.0');

    f.npm('app', '1.0.0', { dependencies: { lib: '^1.0.0' } });
    f.change('fix: select an explicit registry requirement');
    const edited = f.run(settings, f.clone('main', 'edited'));
    expect(edited.ok, edited.logs).toBe(true);
    expect((await publishedManifest('1.0.3')).dependencies.lib).toBe('^1.0.0');
  });

  test('fresh-clone retries preserve exact package plans while changed plans are rejected', () => {
    const f = setup();
    f.npm('a');
    f.npm('b', '1.0.0', { dependencies: { a: 'workspace:*' } });
    f.change('chore: setup');
    f.file('packages/a/index.js', 'feature');
    f.change('feat: enhance a');
    const preview = plan(f);
    const before = f.refs();
    expect(f.refs()).toBe(before);
    const failed = f.run({ failure: 'publish' });
    expect(failed.ok).toBe(false);
    expect(f.state().planning.plan).toEqual(preview);
    const clone = f.clone();
    const rejected = f.run(
      { dryRun: true, pluginConfig: { sharedFiles: ['**'] } },
      clone,
    );
    expect(rejected.codes, rejected.logs).toContain('EWORKSPACEPLAN');
    expect(plan(f, {}, clone)).toEqual(preview);
    const retry = f.run({}, clone);
    expect(retry.ok, retry.logs).toBe(true);
    expect(f.state().planning.plan).toEqual(preview);
    expect(
      f
        .state()
        .planning.versions.map((entry: { version: string }) => entry.version),
    ).toEqual(['1.1.0', '1.0.1']);
    expect(f.run({}, clone).result).toBe(false);
  });

  test('corrupt persisted plans fail before another batch is tagged', () => {
    const f = setup();
    f.npm('a');
    f.change('feat: introduce a');
    expect(f.run().ok).toBe(true);
    const state = f.state();
    state.planning.plan.packages[0].nextVersion = 'invalid';
    f.git(
      f.cwd,
      'notes',
      '--ref=refs/notes/semantic-release-workspace',
      'add',
      '-f',
      '-m',
      JSON.stringify(state),
      f.anchor,
    );
    f.git(f.cwd, 'push', 'origin', 'refs/notes/semantic-release-workspace');
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEJOURNAL');
    expect(f.refs()).toBe(before);
    state.planning.plan.packages[0].nextVersion = '99.0.0';
    f.git(
      f.cwd,
      'notes',
      '--ref=refs/notes/semantic-release-workspace',
      'add',
      '-f',
      '-m',
      JSON.stringify(state),
      f.anchor,
    );
    f.git(f.cwd, 'push', 'origin', 'refs/notes/semantic-release-workspace');
    expect(f.run().codes).toContain('EWORKSPACEJOURNAL');
  });

  test('schema 1 lifecycle journals migrate when package planning begins', () => {
    const f = setup();
    f.file('README.md', 'initial');
    f.change('feat: lifecycle proof');
    expect(f.run().ok).toBe(true);
    expect(f.state().schemaVersion).toBe(1);
    f.npm('a');
    f.change('feat: add first package');
    const outcome = f.run();
    expect(outcome.ok, outcome.logs).toBe(true);
    expect(f.state().schemaVersion).toBe(2);
    expect(f.state().planning.plan.packages[0].nextVersion).toBe('1.1.0');
  });
  test('missing versions start at 1.0.0 while invalid baselines fail before tagging', () => {
    const f = setup();
    f.file('packages/a/package.json', '{"name":"a"}');
    f.change('feat: first package');
    expect(plan(f).packages).toMatchObject([
      { id: 'npm:a', currentVersion: null, nextVersion: '1.0.0' },
    ]);
    f.file('packages/a/package.json', '{"name":"a","version":"invalid"}');
    f.change('fix: invalid manifest');
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEVERSION');
    expect(f.refs()).toBe(before);
  });

  test('plugin analyzer options affect package signals and unsafe shared patterns are rejected', () => {
    const f = setup();
    f.npm('a');
    f.change('chore: setup');
    f.file('packages/a/index.js', 'docs');
    f.change('docs: document code');
    expect(f.run({ dryRun: true }).result).toBe(false);
    expect(
      plan(f, { releaseRules: [{ type: 'docs', release: 'patch' }] }).packages,
    ).toMatchObject([{ id: 'npm:a', nextVersion: '1.0.1' }]);
    const outcome = f.run({ pluginConfig: { sharedFiles: ['../escape'] } });
    expect(outcome.codes).toContain('EWORKSPACECONFIG');
  });
  test('completed journals reject corrupted retained versions and dependency projections', () => {
    const f = setup();
    f.npm('a');
    f.npm('b');
    f.npm('peer', '1.0.0', { peerDependencies: { a: '^1.0.0' } });
    f.change('feat: initial API\n\nBREAKING CHANGE: API replacement');
    expect(f.run().ok).toBe(true);
    f.file('packages/a/index.js', 'repair');
    f.change('fix: repair a');
    const second = f.run();
    expect(second.ok, second.logs).toBe(true);
    const original = f.state() as {
      schemaVersion: number;
      planning: PlanningState;
    };
    const broken = structuredClone(original);
    const retained = broken.planning.versions.find(
      (entry) => entry.id === 'npm:b',
    );
    if (!retained) throw new Error('Missing baseline');
    retained.version = '99.0.0';
    const projection = structuredClone(original);
    const range = projection.planning.dependencyRanges[0];
    if (!range) throw new Error('Missing projection');
    range.to = '^99.0.0';
    const downgrade = structuredClone(original);
    downgrade.schemaVersion = 1;
    for (const state of [broken, projection, downgrade]) {
      f.git(
        f.cwd,
        'notes',
        '--ref=refs/notes/semantic-release-workspace',
        'add',
        '-f',
        '-m',
        JSON.stringify(state),
        f.anchor,
      );
      f.git(f.cwd, 'push', 'origin', 'refs/notes/semantic-release-workspace');
      const outcome = f.run();
      expect(outcome.ok).toBe(false);
      expect(outcome.codes, outcome.logs).toContain('EWORKSPACEJOURNAL');
    }
    f.git(
      f.cwd,
      'notes',
      '--ref=refs/notes/semantic-release-workspace',
      'add',
      '-f',
      '-m',
      JSON.stringify(original),
      f.anchor,
    );
    f.git(f.cwd, 'push', 'origin', 'refs/notes/semantic-release-workspace');
    expect(f.run().result).toBe(false);
  });
  test('package history retains unreleased commits across other packages completed batches', () => {
    const f = setup();
    f.npm('a');
    f.npm('b');
    f.change('feat: initial packages');
    expect(f.run().ok).toBe(true);
    f.file('packages/b/README.md', 'documentation');
    const docs = f.change('docs: document b');
    f.file('packages/a/index.js', 'feature');
    f.change('feat: enhance a');
    const second = f.run();
    expect(second.ok, second.logs).toBe(true);
    f.file('packages/b/index.js', 'repair');
    const fix = f.change('fix: repair b');
    expect(plan(f).packages).toMatchObject([
      { id: 'npm:a', currentVersion: '1.2.0', nextVersion: null, commits: [] },
      {
        id: 'npm:b',
        currentVersion: '1.1.0',
        nextVersion: '1.1.1',
        commits: [{ hash: fix }, { hash: docs }],
      },
    ]);
  });
});
