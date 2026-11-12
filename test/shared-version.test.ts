import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fixture, roots } from './fixtures/repository.js';

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function workspace() {
  const f = fixture();
  writeFileSync(
    join(f.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const name of ['a', 'b', 'internal']) {
    mkdirSync(join(f.cwd, 'packages', name), { recursive: true });
    writeFileSync(
      join(f.cwd, 'packages', name, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', private: name === 'internal' }),
    );
  }
  f.git(f.cwd, 'add', '.');
  f.commit('chore: initialize members');
  return f;
}
test('repository-wide strongest signal gives every public member the core version', {
  timeout: 60000,
}, () => {
  const f = workspace();
  f.commit('feat: repository tooling');
  let result = f.run();
  expect(result.ok, result.logs).toBe(true);
  expect(result.result).toMatchObject({
    nextRelease: { type: 'minor', version: '1.0.0' },
  });
  expect(f.state().planning.plan).toMatchObject({
    versioning: 'shared',
    version: '1.0.0',
    packages: [
      { id: 'npm:a', nextVersion: '1.0.0' },
      { id: 'npm:b', nextVersion: '1.0.0' },
      { id: 'npm:internal', nextVersion: null },
    ],
  });
  f.commit('fix: minor repair');
  f.commit('feat: replace repository tooling\n\nBREAKING CHANGE: tooling API');
  result = f.run();
  expect(result.ok, result.logs).toBe(true);
  expect(result.result).toMatchObject({
    nextRelease: { type: 'major', version: '2.0.0' },
  });
  expect(
    f
      .state()
      .planning.plan.packages.filter((p: { private: boolean }) => !p.private)
      .map((p: { nextVersion: string }) => p.nextVersion),
  ).toEqual(['2.0.0', '2.0.0']);
  f.commit('docs: update guidance');
  const noop = f.run();
  expect(noop.ok, noop.logs).toBe(true);
  expect(noop.result).toBe(false);
});
test('tagged pending batches recover the same shared version from a fresh clone', {
  timeout: 60000,
}, () => {
  const f = workspace();
  writeFileSync(join(f.cwd, 'packages/a/index.js'), 'feature');
  f.git(f.cwd, 'add', '.');
  f.commit('feat: first release');
  const failed = f.run({ failure: 'publish' });
  expect(failed.ok).toBe(false);
  const frozen = f.state().planning.plan;
  const clone = f.clone();
  const refs = f.refs();
  const preview = f.run({ dryRun: true }, clone);
  expect(preview.ok, preview.logs).toBe(true);
  expect(preview.logs).toContain('1.0.0');
  expect(f.refs()).toBe(refs);
  const retry = f.run({}, clone);
  expect(retry.ok, retry.logs).toBe(true);
  expect(f.state().planning.plan).toEqual(frozen);
  expect(f.state().batchTag).toBe('workspace-v1.0.0');
  expect(f.tags()).toEqual(['workspace-v1.0.0']);
  expect(f.run({}, clone).result).toBe(false);
});

test('legacy independent pending batches are rejected before any retry writes', {
  timeout: 60000,
}, () => {
  const f = workspace();
  f.commit('feat: pending release');
  expect(f.run({ failure: 'after-prepare' }).ok).toBe(false);
  const state = f.state();
  delete state.planning.plan.versioning;
  delete state.planning.plan.version;
  delete state.planning.plan.releaseType;
  state.planning.plan.packages.find(
    (p: { id: string }) => p.id === 'npm:b',
  ).nextVersion = '1.1.0';
  state.planning.releaseNotes.packages.find(
    (p: { id: string }) => p.id === 'npm:b',
  ).version = '1.1.0';
  f.git(
    f.remote,
    'notes',
    '--ref=refs/notes/semantic-release-workspace',
    'add',
    '-f',
    '-m',
    JSON.stringify(state),
    f.anchor,
  );
  const before = f.refs();
  const result = f.run({}, f.clone());
  expect(result.codes, result.logs).toContain('EWORKSPACEMIGRATION');
  expect(f.refs()).toBe(before);
});
test('frozen shared version and release rules cannot drift on retry', {
  timeout: 60000,
}, () => {
  const f = workspace();
  f.commit('feat: pending shared release');
  expect(f.run({ failure: 'publish' }).ok).toBe(false);
  const before = f.refs();
  const clone = f.clone();
  const result = f.run(
    {
      dryRun: true,
      pluginConfig: { releaseRules: [{ type: 'feat', release: 'patch' }] },
    },
    clone,
  );
  expect(result.codes, result.logs).toContain('EWORKSPACEPLAN');
  expect(f.refs()).toBe(before);
  const state = f.state();
  state.planning.plan.version = '1.0.1';
  for (const pkg of state.planning.plan.packages)
    if (!pkg.private) pkg.nextVersion = '1.0.1';
  for (const note of state.planning.releaseNotes.packages)
    note.version = '1.0.1';
  f.git(
    f.remote,
    'notes',
    '--ref=refs/notes/semantic-release-workspace',
    'add',
    '-f',
    '-m',
    JSON.stringify(state),
    f.anchor,
  );
  const altered = f.refs();
  const corrupt = f.run({}, clone);
  expect(corrupt.codes, corrupt.logs).toContain('EWORKSPACEJOURNAL');
  expect(f.refs()).toBe(altered);
});

test('skipped stronger commits do not override the repository release signal during verification', {
  timeout: 60000,
}, () => {
  const f = workspace();
  f.commit('feat: first shared version');
  const initial = f.run();
  expect(initial.ok, initial.logs).toBe(true);
  f.commit('feat: skipped feature [skip release]');
  f.commit('fix: actual release');
  const release = f.run();
  expect(release.ok, release.logs).toBe(true);
  expect(release.result).toMatchObject({
    nextRelease: { type: 'patch', version: '1.0.1' },
  });
});
