import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, test } from 'vitest';
import { archiveFile } from '../src/archive.js';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { registry } from './fixtures/registry.js';
import { fixture } from './fixtures/repository.js';

afterEach(cleanupFixtures);

test.each(['npm', 'cargo'] as const)(
  '%s migrates shared tags to package baselines without replaying released commits',
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
    const file = (path: string, contents: string) => {
      mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
      writeFileSync(join(repo.cwd, path), contents);
    };
    const names =
      ecosystem === 'npm'
        ? { core: '@acme/core', app: '@acme/app' }
        : { core: 'migration-core', app: 'migration-app' };
    const manifest = (name: string) =>
      `packages/${name}/${ecosystem === 'npm' ? 'package.json' : 'Cargo.toml'}`;
    const source = (name: string) =>
      `packages/${name}/${ecosystem === 'npm' ? 'index.js' : 'src/lib.rs'}`;
    if (ecosystem === 'npm') {
      file(
        'package.json',
        JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      );
    } else {
      file('Cargo.toml', '[workspace]\nmembers=["packages/*"]\nresolver="3"\n');
      file(
        '.cargo/config.toml',
        `[registries.fixture]\nindex="sparse+${service.url}/cargo/index/"\n`,
      );
      file('.gitignore', 'Cargo.lock\ntarget/\n');
    }
    for (const name of ['core', 'app'] as const) {
      file(
        manifest(name),
        ecosystem === 'npm'
          ? JSON.stringify({
              name: names[name],
              version: '2.4.0',
              ...(name === 'app'
                ? { dependencies: { [names.core]: '^2.4.0' } }
                : {}),
            })
          : `[package]\nname="${names[name]}"\nversion="2.4.0"\nedition="2024"\nlicense="MIT"\ndescription="Migration fixture"\n${name === 'app' ? '[dependencies]\nmigration-core={path="../core",version="2.4.0"}\n' : ''}`,
      );
      file(
        source(name),
        ecosystem === 'npm'
          ? 'export const value = 1;\n'
          : 'pub fn value() -> u8 { 1 }\n',
      );
    }
    repo.git(repo.cwd, 'add', '.');
    const oldRelease = repo.commit(
      'feat: historical shared release\n\nBREAKING CHANGE: replace the old API',
    );
    repo.git(repo.cwd, 'tag', '-a', 'v2.4.0', '-m', 'Previous shared release');
    repo.git(repo.cwd, 'push', 'origin', 'refs/tags/v2.4.0');
    const sharedTagObject = repo.git(
      repo.remote,
      'rev-parse',
      'refs/tags/v2.4.0',
    );

    // A declared version plus a shared tag does not mark each package's commits released.
    const oldRefs = repo.refs();
    const unseeded = repo.run({ ...settings, dryRun: true });
    expect(unseeded.ok, unseeded.logs).toBe(true);
    if (!unseeded.result)
      throw new Error('Expected historical commits to be selected');
    const plan = JSON.parse(
      unseeded.result.nextRelease.notes.match(
        /```json\n([\s\S]*?)\n```/,
      )?.[1] ?? '{}',
    );
    expect(plan.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${ecosystem}:${names.core}`,
          nextVersion: '3.0.0',
        }),
        expect.objectContaining({
          id: `${ecosystem}:${names.app}`,
          nextVersion: '3.0.0',
        }),
      ]),
    );
    expect(repo.refs()).toBe(oldRefs);
    expect(service.state().uploads).toEqual([]);

    // Seed aliases at the actual old release commit, not the migration commit.
    file('README.md', 'Use semantic-release-workspace for future releases.\n');
    repo.git(repo.cwd, 'add', '.');
    repo.commit('chore: configure workspace releases');
    const baselineTags = Object.values(names).map(
      (name) => `${ecosystem}/${name}@2.4.0`,
    );
    for (const tag of baselineTags)
      repo.git(repo.cwd, 'tag', tag, 'v2.4.0^{commit}');
    repo.git(
      repo.cwd,
      'push',
      'origin',
      ...baselineTags.map((tag) => `refs/tags/${tag}`),
    );
    const seededRefs = repo.refs();
    for (const dryRun of [true, false]) {
      const unchanged = repo.run({ ...settings, dryRun });
      expect(unchanged.ok, unchanged.logs).toBe(true);
      expect(unchanged.result).toBe(false);
      expect(repo.refs()).toBe(seededRefs);
      expect(service.state().uploads).toEqual([]);
    }

    file(
      source('core'),
      ecosystem === 'npm'
        ? 'export const value = 2;\n'
        : 'pub fn value() -> u8 { 2 }\n',
    );
    repo.git(repo.cwd, 'add', '.');
    repo.commit('fix(core): repair the new API');
    const clone = repo.clone();
    const appBefore = readFileSync(join(clone, manifest('app')), 'utf8');
    const coreBefore = readFileSync(join(clone, manifest('core')), 'utf8');
    const beforeDryRun = repo.refs();
    const dry = repo.run({ ...settings, dryRun: true }, clone);
    expect(dry.ok, dry.logs).toBe(true);
    expect(repo.refs()).toBe(beforeDryRun);
    expect(service.state().uploads).toEqual([]);

    const released = repo.run(settings, clone);
    expect(released.ok, released.logs).toBe(true);
    if (!released.result) throw new Error('Expected a core release');
    expect(released.result.nextRelease.gitTag).toBe('workspace-v1.0.0');
    expect(service.state().uploads).toEqual([
      `${ecosystem}:${names.core}@2.4.1`,
    ]);
    expect(repo.tags().sort()).toEqual(
      [
        'v2.4.0',
        ...baselineTags,
        `${ecosystem}/${names.core}@2.4.1`,
        'workspace-v1.0.0',
      ].sort(),
    );
    expect(repo.git(repo.remote, 'rev-parse', 'refs/tags/v2.4.0')).toBe(
      sharedTagObject,
    );
    for (const tag of baselineTags)
      expect(
        repo.git(repo.remote, 'rev-parse', `refs/tags/${tag}^{commit}`),
      ).toBe(oldRelease);
    const record = service.state()[ecosystem][names.core]['2.4.1'];
    const packed = await archiveFile(
      Buffer.from(record.artifact, 'base64'),
      ecosystem === 'npm'
        ? 'package/package.json'
        : `${names.core}-2.4.1/Cargo.toml`,
    );
    expect(
      ecosystem === 'npm'
        ? JSON.parse(packed).version
        : (parse(packed).package as { version: string }).version,
    ).toBe('2.4.1');
    expect(readFileSync(join(clone, manifest('app')), 'utf8')).toBe(appBefore);
    expect(readFileSync(join(clone, manifest('core')), 'utf8')).toBe(
      coreBefore,
    );
    expect(repo.git(clone, 'status', '--porcelain')).toBe('');
    const completeRefs = repo.refs();
    const rerun = repo.run(settings, repo.clone('main', 'completed-retry'));
    expect(rerun.ok, rerun.logs).toBe(true);
    expect(rerun.result).toBe(false);
    expect(repo.refs()).toBe(completeRefs);
    expect(service.state().uploads).toEqual([
      `${ecosystem}:${names.core}@2.4.1`,
    ]);
  },
  120_000,
);
