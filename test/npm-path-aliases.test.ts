import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { archiveFile } from '../src/archive.js';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test.each(
  ['file:', 'link:', 'workspace:'].flatMap((protocol) =>
    [false, true].map((changed) => ({ protocol, changed })),
  ),
)(
  'publishes $protocol aliases with the target identity (target changed: $changed)',
  async ({ protocol, changed }) => {
    const repo = fixture();
    const service = await registry();
    const file = (path: string, value: string) => {
      mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
      writeFileSync(join(repo.cwd, path), value);
    };
    file(
      'package.json',
      JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    );
    file(
      'packages/lib/package.json',
      JSON.stringify({ name: '@fixture/library', version: '1.0.0' }),
    );
    file('packages/lib/index.js', 'export const value = 1;');
    const sections = {
      dependencies: 'local',
      optionalDependencies: 'optional-local',
      peerDependencies: 'peer-local',
      devDependencies: 'dev-local',
    };
    const source = JSON.stringify({
      name: 'alias-app',
      version: '1.0.0',
      ...Object.fromEntries(
        Object.entries(sections).map(([section, name]) => [
          section,
          { [name]: `${protocol}../lib` },
        ]),
      ),
    });
    file('packages/app/package.json', source);
    file('packages/app/index.js', 'export const value = 1;');
    repo.git(repo.cwd, 'add', '.');
    repo.commit('chore: add packages');
    file(
      `packages/${changed ? 'lib' : 'app'}/index.js`,
      'export const value = 2;',
    );
    repo.git(repo.cwd, 'add', '.');
    repo.commit(changed ? 'feat: enhance library' : 'fix: repair application');
    const settings = {
      env: service.env,
      pluginConfig: { publish: true, npm: { registry: service.url } },
    };
    const refs = repo.refs();
    const preview = repo.run({ ...settings, dryRun: true });
    expect(preview.ok, preview.logs).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().requests).toEqual([]);
    const expected = `npm:@fixture/library@${changed ? '1.1.0' : '1.0.0'}`;
    if (changed) {
      if (!preview.result) throw new Error('Expected a release plan');
      const block = preview.result.nextRelease.notes.match(
        /```json\n([\s\S]*?)\n```/,
      );
      const plan = JSON.parse(block?.[1] ?? '{}');
      const app = plan.packages.find(
        (entry: { id: string }) => entry.id === 'npm:alias-app',
      );
      expect(app.dependencyUpdates).toHaveLength(4);
      expect(
        app.dependencyUpdates.map(
          (update: { publishedRange: string }) => update.publishedRange,
        ),
      ).toEqual(Array(4).fill(expected));
    }
    const result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    const version = changed ? '2.0.0' : '1.0.1';
    const artifact = Buffer.from(
      service.state().npm['alias-app'][version].artifact,
      'base64',
    );
    const manifest = JSON.parse(
      await archiveFile(artifact, 'package/package.json'),
    );
    for (const [section, name] of Object.entries(sections))
      expect(manifest[section][name]).toBe(expected);
    expect(
      readFileSync(join(repo.cwd, 'packages/app/package.json'), 'utf8'),
    ).toBe(source);
    expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');

    if (protocol === 'file:' && changed) {
      const consumer = join(service.root, 'consumer');
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, 'package.json'),
        '{"name":"consumer","private":true}',
      );
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../node_modules/npm/bin/npm-cli.js', import.meta.url),
          ),
          'install',
          `alias-app@${version}`,
          '--ignore-scripts',
          '--package-lock=false',
          '--audit=false',
          '--fund=false',
          '--registry',
          service.url,
        ],
        {
          cwd: consumer,
          env: { ...repo.env, ...service.env },
          stdio: 'pipe',
          timeout: 30_000,
        },
      );
      const installed = createRequire(
        join(consumer, 'node_modules/alias-app/package.json'),
      );
      expect(
        JSON.parse(
          readFileSync(installed.resolve('local/package.json'), 'utf8'),
        ).name,
      ).toBe('@fixture/library');
      expect(
        service
          .state()
          .requests.some((request: { path: string }) =>
            /^\/(local|optional-local|peer-local)(?:\?|$)/.test(request.path),
          ),
      ).toBe(false);
    }
  },
  120_000,
);
