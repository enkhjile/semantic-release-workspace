import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { pythonRegistry } from './fixtures/python-registry.js';
import { registry } from './fixtures/registry.js';
import { fixture } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(cleanupFixtures);
async function setup() {
  const repo = fixture();
  const service = await pythonRegistry();
  const file = (path: string, content: string) => {
    mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
    writeFileSync(join(repo.cwd, path), content);
  };
  file('pyproject.toml', '[tool.uv.workspace]\nmembers = ["packages/*"]\n');
  for (const name of ['core', 'app']) {
    file(
      `packages/${name}/pyproject.toml`,
      `[project]\nname = "fixture-${name}"\nversion = "1.0.0"\n${name === 'app' ? 'dependencies = ["fixture-core>=1.0.0"]\n[tool.uv.sources]\nfixture-core = { workspace = true }\n' : ''}\n[build-system]\nrequires = ["uv_build>=0.13.9,<0.14.0"]\nbuild-backend = "uv_build"\n`,
    );
    file(`packages/${name}/src/fixture_${name}/__init__.py`, 'VALUE = 1\n');
  }
  file('uv.lock', '# untouched source lock\n');
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: create workspace');
  file('packages/core/src/fixture_core/__init__.py', 'VALUE = 2\n');
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add core API');
  const settings = {
    env: {
      ...service.env,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REPOSITORY: 'fixture/repo',
      GITHUB_SHA: repo.git(repo.cwd, 'rev-parse', 'HEAD'),
    },
    pluginConfig: { publish: true, python: service.config, changelog: true },
  };
  return { repo, service, file, settings };
}
function withoutBuilds(root: string) {
  const executable = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
  const bin = join(root, 'no-build-bin');
  mkdirSync(bin);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const script = join(bin, 'uv');
  writeFileSync(
    script,
    `#!/bin/sh\ncase " $* " in *" build "*) exit 97;; esac\nexec ${quote(executable)} "$@"\n`,
  );
  chmodSync(script, 0o755);
  return `${bin}:${process.env.PATH}`;
}
function assertRestored(
  repo: ReturnType<typeof fixture>,
  directory = repo.cwd,
) {
  expect(repo.git(directory, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(directory, 'uv.lock'), 'utf8')).toBe(
    '# untouched source lock\n',
  );
  expect(
    parse(readFileSync(join(directory, 'packages/core/pyproject.toml'), 'utf8'))
      .project,
  ).toMatchObject({ version: '1.0.0' });
}

test('Python native builds publish only changed packages and preserve manual dependency upgrades', async () => {
  const { repo, service, file, settings } = await setup();
  const first = repo.run(settings);
  expect(first.ok, first.logs).toBe(true);
  expect(service.state().uploads.sort()).toEqual([
    'fixture_core-1.1.0-py3-none-any.whl',
    'fixture_core-1.1.0.tar.gz',
  ]);
  expect(service.state().exchanges).toBe(1);
  expect(service.state().revocations).toBe(1);
  expect(repo.tags()).toContain('python/fixture-core@1.1.0');
  expect(repo.tags().some((tag) => tag.startsWith('python/fixture-app@'))).toBe(
    false,
  );
  expect(
    repo.git(
      repo.remote,
      'show',
      'python/fixture-core@1.1.0:packages/core/pyproject.toml',
    ),
  ).toContain('version = "1.1.0"');
  expect(
    repo.git(repo.remote, 'show', 'python/fixture-core@1.1.0:CHANGELOG.md'),
  ).toContain('fixture-core');
  assertRestored(repo);
  const before = service.state();
  const unchanged = repo.run(settings);
  expect(unchanged.ok, unchanged.logs).toBe(true);
  expect(unchanged.result).toBe(false);
  expect(service.state()).toEqual(before);
  const manifest = readFileSync(
    join(repo.cwd, 'packages/app/pyproject.toml'),
    'utf8',
  );
  file(
    'packages/app/pyproject.toml',
    manifest.replace('fixture-core>=1.0.0', 'fixture-core>=1.1.0'),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: adopt the new core API');
  const upgraded = repo.run(settings);
  expect(upgraded.ok, upgraded.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(4);
  expect(repo.tags()).toContain('python/fixture-app@1.0.1');
  expect(
    repo.git(
      repo.remote,
      'show',
      'python/fixture-app@1.0.1:packages/app/pyproject.toml',
    ),
  ).toContain('fixture-core>=1.1.0');
  const entry = Object.values(service.state().files).find(
    (entry) => entry.name === 'fixture-app',
  );
  expect(entry?.version).toBe('1.0.1');
  const wheel = Object.entries(service.state().files).find(
    ([name]) => name.startsWith('fixture_app-') && name.endsWith('.whl'),
  )?.[1];
  if (!wheel) throw new Error('Missing app wheel');
  const metadata = execFileSync(
    'python3',
    [
      '-I',
      '-c',
      `
import sys, io, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    [name] = [n for n in z.namelist() if n.endswith('/METADATA')]
    print(z.read(name).decode())
`,
    ],
    { input: Buffer.from(wheel.bytes, 'base64'), encoding: 'utf8' },
  );
  expect(metadata).toContain('Name: fixture-app');
  expect(metadata).toContain('Version: 1.0.1');
  expect(metadata).toContain('Requires-Dist: fixture-core>=1.1.0');

  expect(JSON.stringify(repo.state())).not.toContain('fixture-pypi-secret');
  expect(first.logs).not.toContain('fixture-ci-secret');
  assertRestored(repo);
});

test('Python revocation failure leaves recoverable state and a fresh clone finishes without identity', async () => {
  const { repo, service, settings } = await setup();
  service.control({ rejectRevoke: true });
  const failed = repo.run(settings);
  expect(failed.ok).toBe(false);
  expect(failed.codes).toContain('EWORKSPACEOIDC');
  expect(service.state().uploads).toHaveLength(2);
  expect(repo.state().status).toBe('pending');
  service.control({});
  const retry = repo.run(
    {
      ...settings,
      env: {
        ...settings.env,
        PATH: withoutBuilds(service.root),
        GITHUB_ACTIONS: '',
        ACTIONS_ID_TOKEN_REQUEST_URL: '',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
      },
    },
    repo.clone(),
  );
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(2);
  expect(service.state().exchanges).toBe(1);
  expect(repo.state().status).toBe('complete');
});

test('Python dry-run performs no build, OIDC, uploads, manifest edits or ref writes', async () => {
  const { repo, service, settings } = await setup();
  const refs = repo.refs();
  const result = repo.run({
    ...settings,
    dryRun: true,
    env: { ...settings.env, PATH: withoutBuilds(service.root) },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(refs);
  assertRestored(repo);
});

test('Python fresh-clone retry completes a partial artifact set without rebuilding or republishing accepted bytes', async () => {
  const { repo, service, settings } = await setup();
  service.control({ partial: true });
  const failed = repo.run(settings);
  expect(failed.ok).toBe(false);
  expect(service.state().uploads).toHaveLength(1);
  expect(repo.state().status).toBe('pending');
  expect(repo.tags()).not.toContain('python/fixture-core@1.1.0');
  const accepted = service.state().files;
  assertRestored(repo);
  service.control({});
  const clone = repo.clone();
  const retry = repo.run(
    {
      ...settings,
      env: { ...settings.env, PATH: withoutBuilds(service.root) },
    },
    clone,
  );
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(2);
  expect(new Set(service.state().uploads).size).toBe(2);
  for (const [name, entry] of Object.entries(accepted))
    expect(service.state().files[name]).toEqual(entry);
  expect(repo.state().status).toBe('complete');
  expect(repo.tags()).toContain('python/fixture-core@1.1.0');
  assertRestored(repo, clone);
});

test('Python trusts successful uploads without waiting for registry visibility', async () => {
  const { repo, service, settings } = await setup();
  service.control({ failReadsAfterUpload: true });
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(2);
  expect(repo.state().status).toBe('complete');
});

test('Python recovers lost upload responses using matching registry proofs', async () => {
  const { repo, service, settings } = await setup();
  service.control({ loseResponse: true });
  const result = repo.run(settings);
  if (!result.ok) {
    service.control({});
    const retry = repo.run(
      {
        ...settings,
        env: { ...settings.env, PATH: withoutBuilds(service.root) },
      },
      repo.clone(),
    );
    expect(retry.ok, retry.logs).toBe(true);
  }
  expect(service.state().uploads).toHaveLength(2);
  expect(new Set(service.state().uploads).size).toBe(2);
  expect(repo.state().status).toBe('complete');
});

test('Python retry rejects conflicting partial files before another upload', async () => {
  const { repo, service, settings } = await setup();
  service.control({ partial: true });
  expect(repo.run(settings).ok).toBe(false);
  expect(service.state().uploads).toHaveLength(1);
  service.control({ conflict: true });
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok).toBe(false);
  expect(retry.codes).toContain('EWORKSPACECONFLICT');
  expect(service.state().uploads).toHaveLength(1);
});

test('Python pending publication rejects destination drift', async () => {
  const { repo, service, settings } = await setup();
  service.control({ partial: true });
  expect(repo.run(settings).ok).toBe(false);
  const other = await pythonRegistry();
  const retry = repo.run(
    {
      ...settings,
      pluginConfig: { ...settings.pluginConfig, python: other.config },
    },
    repo.clone(),
  );
  expect(retry.ok).toBe(false);
  expect(retry.codes).toContain('EWORKSPACEPLAN');
  expect(other.state().requests).toEqual([]);
});

test.each(['/oidc', '/_/oidc/mint-token', '/legacy/'])(
  'Python rejects credential-bearing redirects at %s',
  async (path) => {
    const { repo, service, settings } = await setup();
    const foreign = await pythonRegistry();
    service.control({
      redirectPath: path,
      redirectTo: `${foreign.url}/capture`,
    });
    const result = repo.run(settings);
    expect(result.ok).toBe(false);
    expect(foreign.state().requests).toEqual([]);
    expect(service.state().uploads).toEqual([]);
    expect(result.logs).not.toContain('fixture-ci-secret');
    expect(result.logs).not.toContain('fixture-pypi-secret');
  },
);

test('Python OIDC rejection never falls back to an inherited publishing token', async () => {
  const { repo, service, settings } = await setup();
  service.control({ rejectExchange: true });
  const result = repo.run({
    ...settings,
    env: { ...settings.env, UV_PUBLISH_TOKEN: 'inherited-secret' },
  });
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(service.state().uploads).toEqual([]);
  expect(result.logs).not.toContain('inherited-secret');
});

test('mixed npm and Python releases retain independent versions and artifacts', async () => {
  const { repo, service, file, settings } = await setup();
  const npm = await registry();
  file('package.json', JSON.stringify({ private: true, workspaces: ['js/*'] }));
  file(
    'js/lib/package.json',
    JSON.stringify({ name: 'mixed-python-js', version: '2.0.0' }),
  );
  file('js/lib/index.js', 'export const value = 1;\n');
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: add JavaScript wrapper');
  const result = repo.run({
    ...settings,
    env: { ...settings.env, ...npm.env },
    pluginConfig: {
      ...settings.pluginConfig,
      npm: { registry: npm.url, trustedPublishing: false },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(npm.state().uploads).toEqual(['npm:mixed-python-js@2.0.1']);
  expect(service.state().uploads).toHaveLength(2);
  expect(repo.tags()).toContain('npm/mixed-python-js@2.0.1');
  expect(repo.tags()).toContain('python/fixture-core@1.1.0');
  assertRestored(repo);
});
