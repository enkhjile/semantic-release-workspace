import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { registry } from './fixtures/registry.js';
import { fixture } from './fixtures/repository.js';

afterEach(cleanupFixtures);

test.each(['npm', 'cargo', 'cargo-root'] as const)(
  '%s publication rejects manifest symlinks in dry-runs and real releases without side effects',
  async (kind) => {
    const repo = fixture();
    const service = await registry();
    const cargo = kind !== 'npm';
    const directory = kind === 'cargo-root' ? '.' : 'packages/lib';
    const manifest = join(directory, cargo ? 'Cargo.toml' : 'package.json');
    const target = join(directory, 'manifest-source');
    const source = cargo
      ? '[package]\nname="manifest-fixture"\nversion="1.0.0"\nedition="2024"\nlicense="MIT"\ndescription="Manifest preflight fixture"\n'
      : JSON.stringify({ name: 'manifest-fixture', version: '1.0.0' });
    const file = (path: string, value: string) => {
      mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
      writeFileSync(join(repo.cwd, path), value);
    };
    if (cargo) {
      if (kind !== 'cargo-root')
        file(
          'Cargo.toml',
          '[workspace]\nmembers=["packages/lib"]\nresolver="3"\n',
        );
      file(
        '.cargo/config.toml',
        `[registries.fixture]\nindex="sparse+${service.url}/cargo/index/"\n`,
      );
      file('.gitignore', 'Cargo.lock\ntarget/\n');
      file(join(directory, 'src/lib.rs'), 'pub fn value() -> u8 { 1 }\n');
    } else {
      file(
        'package.json',
        JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      );
      file(join(directory, 'index.js'), 'export const value = 1;\n');
    }
    file(target, source);
    symlinkSync('manifest-source', join(repo.cwd, manifest));
    repo.git(repo.cwd, 'add', '.');
    repo.commit('feat: introduce package');
    const settings = {
      env: service.env,
      pluginConfig: {
        publish: true,
        npm: { registry: service.url },
        cargo: { registry: 'fixture' },
      },
    };
    const refs = repo.refs();
    for (const dryRun of [true, false]) {
      const result = repo.run({ ...settings, dryRun });
      expect(result.ok, result.logs).toBe(false);
      expect(result.codes, result.logs).toContain('EWORKSPACEDIRTY');
      expect(repo.refs()).toBe(refs);
      expect(service.state().uploads).toEqual([]);
      expect(lstatSync(join(repo.cwd, manifest)).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(repo.cwd, target), 'utf8')).toBe(source);
      expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
    }
    // No pending batch prevents fixing the unsupported source layout.
    unlinkSync(join(repo.cwd, manifest));
    file(manifest, source);
    repo.git(repo.cwd, 'add', '.');
    repo.commit('fix: use a regular package manifest');
    const clone = repo.clone();
    const published = repo.run(settings, clone);
    expect(published.ok, published.logs).toBe(true);
    expect(service.state().uploads).toEqual([
      `${cargo ? 'cargo' : 'npm'}:manifest-fixture@1.1.0`,
    ]);
    const noop = repo.run(settings, clone);
    expect(noop.ok, noop.logs).toBe(true);
    expect(noop.result).toBe(false);
  },
  120_000,
);
