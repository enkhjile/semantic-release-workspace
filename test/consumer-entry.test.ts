import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { fixture, roots } from './fixtures/repository.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const npm = join(
  dirname(createRequire(import.meta.url).resolve('npm/package.json')),
  'bin/npm-cli.js',
);

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('a packed plugin loads by its documented name through real semantic-release', () => {
  const repo = fixture();
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  writeFileSync(join(repo.cwd, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(repo.cwd, 'packages/lib'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'packages/lib/package.json'),
    JSON.stringify({ name: 'consumer-lib', version: '1.0.0' }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add consumer package');

  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        npm,
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        repo.remote,
      ],
      { cwd: project, env: repo.env, encoding: 'utf8' },
    ),
  )[0];
  const installed = join(repo.cwd, 'node_modules/semantic-release-workspace');
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', [
    '-xf',
    join(repo.remote, packed.filename),
    '-C',
    installed,
    '--strip-components',
    '1',
  ]);
  symlinkSync(
    join(project, 'node_modules'),
    join(installed, 'node_modules'),
    'dir',
  );
  expect(
    JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).name,
  ).toBe('semantic-release-workspace');

  const run = (dryRun = false) => {
    const output = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/run-release.mjs', import.meta.url)),
        repo.cwd,
        repo.remote,
        'semantic-release-workspace',
        JSON.stringify({ dryRun }),
      ],
      { cwd: repo.cwd, env: repo.env, encoding: 'utf8', timeout: 60_000 },
    );
    const line = output
      .split('\n')
      .find((entry) => entry.startsWith('RESULT:'));
    if (!line) throw new Error(`Missing release result: ${output}`);
    return JSON.parse(line.slice('RESULT:'.length));
  };
  const before = repo.refs();
  const preview = run(true);
  expect(preview.ok, preview.logs).toBe(true);
  expect(preview.result.nextRelease.version).toBe('1.0.0');
  expect(repo.refs()).toBe(before);

  const released = run();
  expect(released.ok, released.logs).toBe(true);
  expect(released.result.nextRelease.notes).toContain('consumer-lib');
  expect(released.result.nextRelease.notes).toContain('1.1.0');
  expect(repo.tags()).toEqual(['workspace-v1.0.0']);
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  const completed = repo.refs();
  const unchanged = run();
  expect(unchanged.ok, unchanged.logs).toBe(true);
  expect(unchanged.result).toBe(false);
  expect(repo.refs()).toBe(completed);
}, 120_000);
