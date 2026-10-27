import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

async function workspace(mode: string, consumer = false) {
  const repo = fixture();
  const service = await registry();
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  mkdirSync(join(repo.cwd, 'packages/core'), { recursive: true });
  const original = JSON.stringify({
    name: '@fixture/native-core',
    version: '1.0.0',
    files: ['index.js', 'built.txt'],
    scripts: {
      prepack:
        "node -e \"require('fs').writeFileSync('built.txt', 'native prepack bytes')\"",
    },
  });
  writeFileSync(join(repo.cwd, 'packages/core/package.json'), original);
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'export const value = 42;\n',
  );
  if (consumer) {
    mkdirSync(join(repo.cwd, 'packages/app'));
    writeFileSync(
      join(repo.cwd, 'packages/app/package.json'),
      JSON.stringify({
        name: 'native-app',
        version: '1.0.0',
        dependencies: { '@fixture/native-core': 'workspace:^' },
      }),
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add native packages');

  const bin = join(service.root, 'bin');
  const trace = join(service.root, 'native-pack.jsonl');
  mkdirSync(bin);
  const npm = join(
    dirname(createRequire(import.meta.url).resolve('npm/package.json')),
    'bin/npm-cli.js',
  );
  // Run real native npm for every command. Only successful pack JSON stdout
  // changes; archive bytes and every native metadata field remain untouched.
  writeFileSync(
    join(bin, 'npm'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(npm)}, ...args], {
  cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
if (result.status !== 0 || args[0] !== 'pack') {
  process.stdout.write(result.stdout || '');
  process.exit(result.status ?? 1);
}
const native = JSON.parse(result.stdout);
const entry = Array.isArray(native) ? native[0] : Object.values(native)[0];
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(entry) + '\\n');
let output = { [entry.name]: entry };
switch (process.env.PACK_OUTPUT) {
  case 'array': output = [entry]; break;
  case 'wrong-key': output = { 'wrong-package': entry }; break;
  case 'wrong-name': output = { [entry.name]: { ...entry, name: 'wrong-package' } }; break;
  case 'wrong-version': output = { [entry.name]: { ...entry, version: '99.0.0' } }; break;
  case 'path': output = { [entry.name]: { ...entry, filename: '../' + entry.filename } }; break;
  case 'null': output = null; break;
  case 'extra-key': output = { [entry.name]: entry, unexpected: entry }; break;
  case 'extra-array-entry': output = [entry, entry]; break;
  case 'invalid-json': process.stdout.write('{'); process.exit(0);
}
process.stdout.write(JSON.stringify(output));
`,
    { mode: 0o755 },
  );
  return {
    repo,
    service,
    original,
    packs: () => {
      try {
        return readFileSync(trace, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    settings: {
      env: {
        ...service.env,
        PATH: `${bin}:${process.env.PATH}`,
        PACK_OUTPUT: mode,
      },
      pluginConfig: {
        publish: true,
        npm: { registry: service.url, access: 'public' },
      },
    },
  };
}

test.each(['array', 'keyed'])(
  'native npm %s pack output publishes dependency-first native archives and skips dry/no-change packs',
  async (mode) => {
    const { repo, service, original, packs, settings } = await workspace(
      mode,
      true,
    );
    const refs = repo.refs();
    const dry = repo.run({ ...settings, dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().requests).toEqual([]);
    expect(packs()).toEqual([]);

    const released = repo.run(settings);
    expect(released.ok, released.logs).toBe(true);
    expect(service.state().uploads).toEqual([
      'npm:@fixture/native-core@1.1.0',
      'npm:native-app@1.1.0',
    ]);
    expect(packs()).toHaveLength(2);
    const core = Buffer.from(
      service.state().npm['@fixture/native-core']['1.1.0'].artifact,
      'base64',
    );
    expect(await archiveFile(core, 'package/built.txt')).toBe(
      'native prepack bytes',
    );
    expect(
      JSON.parse(await archiveFile(core, 'package/package.json')),
    ).toMatchObject({
      name: '@fixture/native-core',
      version: '1.1.0',
      publishConfig: { registry: service.url, tag: 'latest', access: 'public' },
    });
    const native = packs().find(
      (entry) => entry.name === '@fixture/native-core',
    );
    expect(native.integrity).toBe(
      `sha512-${createHash('sha512').update(core).digest('base64')}`,
    );
    const app = Buffer.from(
      service.state().npm['native-app']['1.1.0'].artifact,
      'base64',
    );
    expect(
      JSON.parse(await archiveFile(app, 'package/package.json')).dependencies,
    ).toEqual({
      '@fixture/native-core': '^1.1.0',
    });
    expect(repo.tags()).toContain('npm/@fixture/native-core@1.1.0');
    expect(repo.state().status).toBe('complete');
    expect(
      readFileSync(join(repo.cwd, 'packages/core/package.json'), 'utf8'),
    ).toBe(original);
    expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');

    const unchanged = repo.run(settings, repo.clone());
    expect(unchanged.ok, unchanged.logs).toBe(true);
    expect(unchanged.result).toBe(false);
    expect(service.state().uploads).toHaveLength(2);
    expect(packs()).toHaveLength(2);
  },
);

test('npm keyed pack output retains native bytes for a fresh-clone retry without repacking', async () => {
  const { repo, service, packs, settings } = await workspace('keyed');
  service.control('reject');
  const first = repo.run(settings);
  expect(first.ok).toBe(false);
  expect(first.codes, first.logs).toContain('EWORKSPACEPUBLISH');
  expect(service.state().uploads).toEqual([]);
  const artifact = repo.state().execution.packages[0].artifact;
  expect(artifact).toBeDefined();
  expect(repo.state().execution.packages[0].intent).toBe(true);
  service.control('');
  const retried = repo.run(settings, repo.clone());
  expect(retried.ok, retried.logs).toBe(true);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(service.state().uploads).toEqual(['npm:@fixture/native-core@1.1.0']);
  expect(packs()).toHaveLength(1);
  expect(repo.state().status).toBe('complete');
});

test.each([
  'wrong-key',
  'wrong-name',
  'wrong-version',
  'path',
  'null',
  'extra-key',
  'extra-array-entry',
  'invalid-json',
])(
  'npm rejects %s pack output before retaining or uploading an artifact',
  async (mode) => {
    const { repo, service, packs, settings } = await workspace(mode);
    const result = repo.run(settings);
    expect(result.ok).toBe(false);
    expect(result.codes, result.logs).toContain('EWORKSPACEPUBLISH');
    expect(packs()).toHaveLength(1);
    expect(service.state().uploads).toEqual([]);
    expect(repo.tags().filter((tag) => tag.startsWith('npm/'))).toEqual([]);
    expect(repo.state().status).toBe('pending');
    expect(repo.state().execution.packages[0].artifact).toBeUndefined();
    expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  },
);
