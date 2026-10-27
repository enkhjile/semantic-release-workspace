import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, test, vi } from 'vitest';
import { archiveFile } from '../src/archive.js';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('Cargo starts a new coordinated prerelease after stable promotion and backmerge', async () => {
  const repo = fixture({ synchronizeDependents: true });
  const service = await registry();
  const manifests: Record<string, string> = {
    '.cargo/config.toml': `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
    '.gitignore': 'Cargo.lock\ntarget/\n',
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
    'crates/core/Cargo.toml':
      '[package]\nname = "cycle-core"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Release cycle core"\n',
    'crates/app/Cargo.toml':
      '[package]\nname = "cycle-app"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Release cycle app"\n\n[dependencies]\ncycle-core = { path = "../core", version = "=1.0.0" }\n',
  };
  for (const [file, contents] of Object.entries(manifests)) {
    mkdirSync(join(repo.cwd, file, '..'), { recursive: true });
    writeFileSync(join(repo.cwd, file), contents);
  }
  for (const name of ['core', 'app']) {
    mkdirSync(join(repo.cwd, `crates/${name}/src`), { recursive: true });
    writeFileSync(
      join(repo.cwd, `crates/${name}/src/lib.rs`),
      name === 'core'
        ? 'pub fn value() -> u8 { 1 }\n'
        : 'pub fn value() -> u8 { cycle_core::value() }\n',
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add crates');
  const settings = {
    branches: ['main', { name: 'alpha', prerelease: true }],
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  };
  const unchanged = () => {
    for (const [file, contents] of Object.entries(manifests))
      expect(readFileSync(join(repo.cwd, file), 'utf8'), file).toBe(contents);
    expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  };
  const release = async (core: string, app: string) => {
    const result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    const published = service.state().cargo;
    expect(published['cycle-core'][core].metadata.vers).toBe(core);
    expect(published['cycle-app'][app].metadata.deps).toEqual([
      expect.objectContaining({ name: 'cycle-core', version_req: `=${core}` }),
    ]);
    for (const [name, version] of [
      ['cycle-core', core],
      ['cycle-app', app],
    ]) {
      const tag = `cargo/${name}@${version}`;
      expect(repo.tags()).toContain(tag);
      const taggedManifest = parse(
        repo.git(
          repo.remote,
          'show',
          `${tag}:crates/${name === 'cycle-core' ? 'core' : 'app'}/Cargo.toml`,
        ),
      );
      expect(taggedManifest.package).toMatchObject({ name, version });
      const response = await fetch(
        `${service.url}/cargo/api/v1/crates/${name}/${version}/download`,
      );
      expect(response.status).toBe(200);
      const manifest = parse(
        await archiveFile(
          Buffer.from(await response.arrayBuffer()),
          `${name}-${version}/Cargo.toml`,
        ),
      );
      expect(manifest.package).toMatchObject({ name, version });
      if (name === 'cycle-app') {
        expect(taggedManifest.dependencies).toMatchObject({
          'cycle-core': { version: `=${core}` },
        });
        expect(manifest.dependencies).toMatchObject({
          'cycle-core': { version: `=${core}` },
        });
      }
    }
    unchanged();
  };
  const changeCore = (value: number, message: string) => {
    writeFileSync(
      join(repo.cwd, 'crates/core/src/lib.rs'),
      `pub fn value() -> u8 { ${value} }\n`,
    );
    repo.git(repo.cwd, 'add', '.');
    repo.commit(message);
  };

  await release('1.1.0', '1.1.0');
  repo.git(repo.cwd, 'checkout', '-b', 'alpha');
  repo.git(repo.cwd, 'push', '-u', 'origin', 'alpha');
  changeCore(2, 'feat: extend core');
  await release('1.2.0-alpha.1', '1.1.1-alpha.1');

  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--no-ff', 'alpha', '-m', 'chore: promote alpha');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  await release('1.2.0', '1.1.1');
  const stableHead = repo.git(repo.cwd, 'rev-parse', 'HEAD');
  repo.git(repo.cwd, 'checkout', 'alpha');
  repo.git(repo.cwd, 'merge', '--ff-only', 'main');
  repo.git(repo.cwd, 'push', 'origin', 'alpha');
  expect(repo.git(repo.cwd, 'rev-parse', 'HEAD')).toBe(stableHead);
  changeCore(3, 'fix: correct core after stable release');

  const refsBeforeDryRun = repo.refs();
  const uploadsBeforeDryRun = service.state().uploads;
  const dry = repo.run({ ...settings, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(JSON.stringify(dry.result)).toContain('1.2.1-alpha.1');
  expect(JSON.stringify(dry.result)).toContain('1.1.2-alpha.1');
  expect(repo.refs()).toBe(refsBeforeDryRun);
  expect(service.state().uploads).toEqual(uploadsBeforeDryRun);
  unchanged();
  await release('1.2.1-alpha.1', '1.1.2-alpha.1');
  changeCore(4, 'fix: refine core after backmerge');
  await release('1.2.1-alpha.2', '1.1.2-alpha.2');
  expect(service.state().uploads).toEqual([
    'cargo:cycle-core@1.1.0',
    'cargo:cycle-app@1.1.0',
    'cargo:cycle-core@1.2.0-alpha.1',
    'cargo:cycle-app@1.1.1-alpha.1',
    'cargo:cycle-core@1.2.0',
    'cargo:cycle-app@1.1.1',
    'cargo:cycle-core@1.2.1-alpha.1',
    'cargo:cycle-app@1.1.2-alpha.1',
    'cargo:cycle-core@1.2.1-alpha.2',
    'cargo:cycle-app@1.1.2-alpha.2',
  ]);
  const refs = repo.refs();
  const uploads = service.state().uploads;
  const noop = repo.run(settings);
  expect(noop.ok, noop.logs).toBe(true);
  expect(noop.result).toBe(false);
  expect(repo.refs()).toBe(refs);
  expect(service.state().uploads).toEqual(uploads);
  unchanged();
});
