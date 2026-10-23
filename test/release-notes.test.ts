import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture, roots } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function workspace() {
  const repo = fixture();
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
  mkdirSync(join(repo.cwd, 'crates/core/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/core"]\nresolver = "3"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/core/Cargo.toml'),
    '[package]\nname = "core"\nversion = "1.0.0"\nedition = "2024"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/core/src/lib.rs'),
    'pub fn value() -> u8 { 1 }',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: add workspaces');
  return repo;
}
function change(
  repo: ReturnType<typeof workspace>,
  path: string,
  message: string,
) {
  writeFileSync(join(repo.cwd, path), `${Date.now()}\n`);
  repo.git(repo.cwd, 'add', '.');
  return repo.commit(message);
}
function notes(result: ReturnType<ReturnType<typeof fixture>['run']>) {
  expect(result.ok, result.logs).toBe(true);
  if (!result.result) throw new Error('Expected a release');
  const release = result.result as {
    nextRelease?: { notes: string };
    releases?: { notes: string }[];
  };
  const text = release.nextRelease?.notes ?? release.releases?.[0]?.notes;
  if (!text) throw new Error('Expected release notes');
  return text;
}
test('real semantic-release emits isolated npm and Cargo notes with breaking and dependency changes', () => {
  const repo = workspace();
  change(repo, 'packages/lib/index.js', 'feat: add library search');
  change(
    repo,
    'crates/core/src/lib.rs',
    'feat: change Rust API\n\nBREAKING CHANGE: replace old Rust API',
  );
  const text = notes(repo.run({ dryRun: true }));
  expect(text).toContain('# Workspace release');
  expect(text).toContain('Branch: `main`');
  expect(text).toContain('npm channel: `latest`');
  expect(text).toContain('Cargo uses SemVer');
  const visible = text.split('```json')[0] ?? '';
  const lib = visible.split('## npm:lib@1.1.0')[1]?.split('\n## ')[0];
  const app = visible.split('## npm:app@1.0.1')[1]?.split('\n## ')[0];
  const cargo = visible.split('## cargo:core@2.0.0')[1]?.split('\n## ')[0];
  expect(lib).toContain('add library search');
  expect(lib).not.toContain('replace old Rust API');
  expect(app).toContain('### Dependencies');
  expect(app).toContain('npm:lib');
  expect(app).not.toContain('add library search');
  expect(cargo).toContain('BREAKING CHANGES');
  expect(cargo).toContain('replace old Rust API');
  expect(text).toContain('```json');
});

test('pending package notes are retained across a fresh clone and no-change runs create no new output', () => {
  const repo = workspace();
  change(repo, 'packages/lib/index.js', 'feat: readable library feature');
  expect(repo.run({ failure: 'publish' }).ok).toBe(false);
  const frozen = repo.state().planning.releaseNotes;
  expect(
    frozen.packages.find((pkg: { id: string }) => pkg.id === 'npm:lib').notes,
  ).toContain('readable library feature');
  const clone = repo.clone();
  const text = notes(repo.run({}, clone));
  expect(text).toContain('readable library feature');
  expect(repo.state().planning.releaseNotes).toEqual(frozen);
  const refs = repo.refs();
  const noChange = repo.run({}, clone);
  expect(noChange.ok, noChange.logs).toBe(true);
  expect(noChange.result).toBe(false);
  expect(repo.refs()).toBe(refs);
});

test('channel promotion summarizes retained notes for unchanged package versions without new release entries', () => {
  const repo = workspace();
  const branches = ['main', 'next'];
  writeFileSync(
    join(repo.cwd, 'packages/app/package.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      dependencies: { lib: '*' },
    }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: support library versions');
  change(repo, 'packages/lib/index.js', 'feat: first library feature');
  notes(repo.run({ branches }));
  repo.git(repo.cwd, 'checkout', '-b', 'next');
  repo.git(repo.cwd, 'push', '-u', 'origin', 'next');
  change(repo, 'packages/app/index.js', 'feat: new application');
  notes(repo.run({ branches }));
  change(
    repo,
    'packages/lib/index.js',
    'feat: next library feature\n\nBREAKING CHANGE: adopt new library API',
  );
  notes(repo.run({ branches }));
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'next');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  const text = notes(repo.run({ branches, dryRun: true }));
  expect(text).toContain('# Workspace channel promotion');
  expect(text).toContain('npm channel: `latest`');
  expect(text).toContain('new application');
  expect(text).toContain('adopt new library API');
  expect(text).toContain('No new changelog entries');
});
