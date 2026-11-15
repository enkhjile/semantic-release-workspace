import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { registry } from './fixtures/registry.js';
import { fixture } from './fixtures/repository.js';

afterEach(cleanupFixtures);

test('project releases publish rc and release through OIDC while main stays development-only', async () => {
  const repo = fixture();
  repo.git(repo.cwd, 'branch', '-m', 'main', 'release');
  repo.git(repo.cwd, 'push', 'origin', 'release');
  const service = await registry();
  service.trusted();
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({
      name: 'project-release-fixture',
      version: '0.0.0-development',
      publishConfig: { registry: service.url, access: 'public' },
    }),
  );
  writeFileSync(join(repo.cwd, 'index.js'), 'export const value = 1;');
  writeFileSync(join(repo.cwd, '.gitignore'), 'node_modules/\n');
  repo.git(repo.cwd, 'checkout', '-b', 'alpha');
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: release fixture');
  repo.git(repo.cwd, 'tag', 'v1.0.0-alpha.11');
  repo.git(
    repo.cwd,
    'notes',
    '--ref=semantic-release',
    'add',
    '-m',
    '{"channels":["alpha"]}',
    'v1.0.0-alpha.11',
  );
  repo.git(repo.cwd, 'push', 'origin', '--tags', 'refs/notes/semantic-release');
  repo.git(repo.cwd, 'checkout', '-b', 'rc');
  repo.commit('chore: start release candidates');
  symlinkSync(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(repo.cwd, 'node_modules'),
    'dir',
  );
  const hostBin = join(service.root, 'host-bin');
  mkdirSync(hostBin);
  writeFileSync(
    join(hostBin, 'npm'),
    '#!/bin/sh\necho "Host npm must not be used for releases" >&2\nexit 86\n',
    { mode: 0o755 },
  );
  const jwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify({ aud: 'npm:127.0.0.1', repository_visibility: 'private' }),
  ).toString('base64url')}.fixture-signature`;
  const run = (dryRun: boolean) => {
    const stdout = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('./fixtures/run-project-release.mjs', import.meta.url),
        ),
        repo.cwd,
        pathToFileURL(repo.remote).href,
        String(dryRun),
      ],
      {
        cwd: repo.cwd,
        env: {
          ...repo.env,
          ...service.env,
          PATH: `${hostBin}:${repo.env.PATH}`,
          GITHUB_ACTIONS: 'true',
          GITHUB_REF: `refs/heads/${repo.git(repo.cwd, 'branch', '--show-current')}`,
          GITHUB_EVENT_NAME: 'push',
          NPM_ID_TOKEN: jwt,
          // The plugin verifies custom-registry credentials before the CLI
          // exchanges its OIDC identity. The registry rejects this static token
          // on publication, so only the exchanged credential can succeed.
          NPM_TOKEN: 'fixture-token',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const line = stdout
      .split('\n')
      .find((entry) => entry.startsWith('RESULT:'));
    return JSON.parse(line?.slice('RESULT:'.length) ?? '{}');
  };
  const refs = repo.refs();
  const preview = run(true);
  expect(preview.ok, preview.logs ?? preview.message).toBe(true);
  expect(preview.result, preview.logs).toBeTruthy();
  expect(preview.result.nextRelease.version).toBe('1.0.0-rc.1');
  expect(repo.refs()).toBe(refs);
  expect(service.state().uploads).toEqual([]);
  expect(service.state().exchanges).toBeUndefined();
  const result = run(false);
  expect(result.ok, result.logs ?? result.message).toBe(true);
  expect(result.result.nextRelease.version).toBe('1.0.0-rc.1');
  expect(service.state().exchanges).toHaveLength(1);
  expect(service.state().uploads).toEqual([
    'npm:project-release-fixture@1.0.0-rc.1',
  ]);
  expect(service.state().npmTags['project-release-fixture']).toEqual({
    rc: '1.0.0-rc.1',
  });
  expect(run(false).result).toBe(false);
  repo.git(repo.cwd, 'checkout', 'alpha');
  const retired = run(false);
  expect(retired.ok, retired.logs ?? retired.message).toBe(true);
  expect(retired.result).toBe(false);
  expect(service.state().uploads).toHaveLength(1);
  repo.git(repo.cwd, 'checkout', '-b', 'main', 'rc');
  repo.commit('fix: development changes must not publish');
  const development = run(false);
  expect(development.ok, development.logs ?? development.message).toBe(true);
  expect(development.result).toBe(false);
  expect(service.state().uploads).toHaveLength(1);
  expect(service.state().exchanges).toHaveLength(1);
  repo.git(repo.cwd, 'checkout', 'rc');
  writeFileSync(join(repo.cwd, 'index.js'), 'export const value = 2;');
  repo.git(repo.cwd, 'add', 'index.js');
  repo.commit('fix: refine release candidate');
  const next = run(false);
  expect(next.ok, next.logs ?? next.message).toBe(true);
  expect(next.result.nextRelease.version).toBe('1.0.0-rc.2');
  expect(service.state().uploads).toEqual([
    'npm:project-release-fixture@1.0.0-rc.1',
    'npm:project-release-fixture@1.0.0-rc.2',
  ]);
  expect(service.state().npmTags['project-release-fixture']).toEqual({
    rc: '1.0.0-rc.2',
  });
  expect(repo.tags()).toContain('v1.0.0-alpha.11');
  // A new CI checkout does not retain the npm plugin's generated version.
  repo.git(repo.cwd, 'restore', 'package.json');
  repo.git(repo.cwd, 'checkout', 'release');
  repo.git(
    repo.cwd,
    'merge',
    '--no-ff',
    'rc',
    '-m',
    'chore: promote release candidate',
  );
  repo.git(repo.cwd, 'push', 'origin', 'release');
  const stable = run(false);
  expect(stable.ok, stable.logs ?? stable.message).toBe(true);
  expect(stable.result.nextRelease.version).toBe('1.0.0');
  expect(service.state().npmTags['project-release-fixture']).toEqual({
    rc: '1.0.0-rc.2',
    latest: '1.0.0',
  });
}, 60_000);
