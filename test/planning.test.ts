import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { PlanningState } from '../src/plan-types.js';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { fixture } from './fixtures/repository.js';

afterEach(cleanupFixtures);
function setup() {
  const f = fixture();
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
  test('npm runtime, peer, dev and workspace references do not release unchanged dependents', () => {
    const f = setup();
    f.npm('core', '1.0.0', { private: true });
    for (const section of [
      'dependencies',
      'optionalDependencies',
      'devDependencies',
      'peerDependencies',
    ])
      f.npm(section, '1.0.0', { [section]: { core: '1.0.0' } });
    f.npm('local', '1.0.0', { dependencies: { core: 'workspace:*' } });
    f.change('chore: setup');
    f.file('packages/core/index.js', 'feature');
    f.change('feat: enhance core');
    const result = plan(f);
    expect(
      result.packages.filter(
        (pkg: { nextVersion: string | null }) => pkg.nextVersion,
      ),
    ).toMatchObject([{ id: 'npm:core', nextVersion: '1.1.0', private: true }]);
    expect(
      result.packages.every(
        (pkg: { dependencyUpdates: unknown[] }) =>
          !pkg.dependencyUpdates.length,
      ),
    ).toBe(true);
  });

  test('explicit dependency cycles do not propagate release signals', () => {
    const f = setup();
    f.npm('a', '1.0.0', { dependencies: { b: '1.0.0' } });
    f.npm('b', '1.0.0', { dependencies: { a: '1.0.0' } });
    f.change('chore: setup');
    f.file('packages/a/index.js', 'feature');
    f.change('feat: enhance a');
    const result = plan(f);
    expect(result.packages).toMatchObject([
      {
        id: 'npm:a',
        nextVersion: '1.1.0',
        type: 'minor',
        dependencyUpdates: [],
      },
      { id: 'npm:b', nextVersion: null, type: null, dependencyUpdates: [] },
    ]);
    expect(result.groups).toEqual([['npm:a']]);
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
    ).toEqual(['1.1.0']);
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
    projection.planning.dependencyRanges.push({
      dependency: 'npm:a',
      manifestPath: 'packages/peer/package.json',
      field: ['peerDependencies', 'a'],
      from: '^1.0.0',
      to: '^99.0.0',
      publishedRange: '^99.0.0',
    });
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
