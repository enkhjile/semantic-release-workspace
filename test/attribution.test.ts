import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { attributeCommits } from '../src/attribution.js';
import { discoverWorkspaces } from '../src/discovery.js';
import { fixture, roots } from './fixtures/repository.js';

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function repo() {
  const f = fixture();
  function file(path: string, content: string) {
    mkdirSync(join(f.cwd, path, '..'), { recursive: true });
    writeFileSync(join(f.cwd, path), content);
  }
  file('package.json', '{"name":"root","workspaces":["packages/**"]}');
  for (const name of ['a', 'b'])
    file(`packages/${name}/package.json`, JSON.stringify({ name }));
  f.git(f.cwd, 'add', '.');
  f.commit('chore: setup');
  return { ...f, file };
}

test('first-parent merge attribution excludes changes already on the main branch', async () => {
  const f = repo();
  f.git(f.cwd, 'checkout', '-b', 'topic');
  f.file('packages/a/topic.js', 'topic');
  f.git(f.cwd, 'add', '.');
  f.git(f.cwd, 'commit', '-m', 'feat: topic');
  f.git(f.cwd, 'checkout', 'main');
  f.file('packages/b/main.js', 'main');
  f.git(f.cwd, 'add', '.');
  f.commit('fix: main');
  f.git(f.cwd, 'merge', '--no-ff', 'topic', '-m', 'feat: merge topic');
  const hash = f.git(f.cwd, 'rev-parse', 'HEAD');
  const inventory = await discoverWorkspaces(f.cwd);
  const owners = await attributeCommits(
    { cwd: f.cwd, env: process.env },
    inventory.packages,
    [{ hash, message: 'feat: merge topic' }],
    [],
  );
  expect(owners.get('npm:a')).toEqual([{ hash, message: 'feat: merge topic' }]);
  expect(owners.get('npm:b')).toEqual([]);
});

test('NUL-delimited file names retain whitespace and both co-located ecosystems own files', async () => {
  const f = repo();
  f.file('Cargo.toml', '[workspace]\nmembers=["packages/a"]');
  f.file('packages/a/Cargo.toml', '[package]\nname="a"');
  f.file('packages/a/ space\nname ', 'value');
  f.git(f.cwd, 'add', '.');
  const hash = f.commit('fix: unusual file');
  const inventory = await discoverWorkspaces(f.cwd);
  const owners = await attributeCommits(
    { cwd: f.cwd, env: process.env },
    inventory.packages,
    [{ hash, message: 'fix: unusual file' }],
    [],
  );
  expect(owners.get('npm:a')?.[0]?.hash).toBe(hash);
  expect(owners.get('cargo:a')?.[0]?.hash).toBe(hash);
  expect(owners.get('npm:b')).toEqual([]);
});

test('initial root commits and shared glob overrides retain their owners', async () => {
  const f = repo();
  f.file('Cargo.toml', '[package]\nname="root-crate"');
  const inventory = await discoverWorkspaces(f.cwd);
  const root = await attributeCommits(
    { cwd: f.cwd, env: process.env },
    inventory.packages,
    [{ hash: f.anchor, message: 'chore: initialize fixture' }],
    [],
  );
  expect(root.get('cargo:root-crate')?.[0]?.hash).toBe(f.anchor);
  const all = await attributeCommits(
    { cwd: f.cwd, env: process.env },
    inventory.packages,
    [{ hash: f.anchor, message: 'chore: initialize fixture' }],
    ['package.json'],
  );
  expect([...all.values()].every((commits) => commits.length === 1)).toBe(true);
});
