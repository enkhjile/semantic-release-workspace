import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('project releases use local npm for alpha OIDC publication instead of host npm', async () => {
  const repo = fixture();
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
          GITHUB_REF: 'refs/heads/alpha',
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
  expect(preview.result.nextRelease.version).toBe('1.0.0-alpha.1');
  expect(repo.refs()).toBe(refs);
  expect(service.state().uploads).toEqual([]);
  expect(service.state().exchanges).toBeUndefined();
  const result = run(false);
  expect(result.ok, result.logs ?? result.message).toBe(true);
  expect(result.result.nextRelease.version).toBe('1.0.0-alpha.1');
  expect(service.state().exchanges).toHaveLength(1);
  expect(service.state().uploads).toEqual([
    'npm:project-release-fixture@1.0.0-alpha.1',
  ]);
  expect(service.state().npmTags['project-release-fixture']).toEqual({
    alpha: '1.0.0-alpha.1',
  });
}, 60_000);
