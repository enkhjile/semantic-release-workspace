import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
  const archives = Object.entries(service.state().files).filter(([name]) =>
    name.startsWith('fixture_app-'),
  );
  expect(archives).toHaveLength(2);
  for (const [name, file] of archives) {
    const metadata = execFileSync(
      'python3',
      [
        '-I',
        '-c',
        `
import io, sys, tarfile, zipfile
stream = io.BytesIO(sys.stdin.buffer.read())
if sys.argv[1].endswith('.whl'):
    with zipfile.ZipFile(stream) as z:
        [name] = [n for n in z.namelist() if n.endswith('/METADATA')]
        print(z.read(name).decode())
else:
    with tarfile.open(fileobj=stream, mode='r:gz') as t:
        [entry] = [n for n in t if n.name.endswith('/PKG-INFO')]
        print(t.extractfile(entry).read().decode())
`,
        name,
      ],
      { input: Buffer.from(file.bytes, 'base64'), encoding: 'utf8' },
    );
    expect(metadata).toContain('Name: fixture-app');
    expect(metadata).toContain('Version: 1.0.1');
    expect(metadata).toContain('Requires-Dist: fixture-core>=1.1.0');
  }
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

test('mixed npm, Cargo and Python releases retain independent versions and artifacts', async () => {
  const { repo, service, file, settings } = await setup();
  const npm = await registry();
  file('package.json', JSON.stringify({ private: true, workspaces: ['js/*'] }));
  file(
    'js/lib/package.json',
    JSON.stringify({ name: 'mixed-python-js', version: '2.0.0' }),
  );
  file('js/lib/index.js', 'export const value = 1;\n');
  file('Cargo.toml', '[workspace]\nmembers=["rust"]\nresolver="3"\n');
  file(
    'rust/Cargo.toml',
    '[package]\nname="mixed-python-rs"\nversion="3.0.0"\nedition="2024"\npublish=["fixture"]\n',
  );
  file('rust/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  file(
    '.cargo/config.toml',
    `[registries.fixture]\nindex="sparse+${npm.url}/cargo/index/"\n`,
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: add JavaScript wrapper');
  const result = repo.run({
    ...settings,
    env: { ...settings.env, ...npm.env },
    pluginConfig: {
      ...settings.pluginConfig,
      npm: { registry: npm.url, trustedPublishing: false },
      cargo: { registry: 'fixture', trustedPublishing: false },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(npm.state().uploads.sort()).toEqual([
    'cargo:mixed-python-rs@3.0.1',
    'npm:mixed-python-js@2.0.1',
  ]);
  expect(repo.tags()).toContain('cargo/mixed-python-rs@3.0.1');
  expect(service.state().uploads).toHaveLength(2);
  expect(repo.tags()).toContain('npm/mixed-python-js@2.0.1');
  expect(repo.tags()).toContain('python/fixture-core@1.1.0');
  assertRestored(repo);
});

test('Python rejects preexisting PEP 440 equivalent filenames before exchanging credentials', async () => {
  const { repo, service, settings } = await setup();
  service.control({ extraFilename: 'fixture_core-1.1.0.0-py3-none-any.whl' });
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACECONFLICT');
  expect(service.state().exchanges).toBe(0);
  expect(service.state().uploads).toEqual([]);
});

test('Python refuses a replacement pyproject symlink while recovering', async () => {
  const { repo, service, settings } = await setup();
  service.control({ partial: true });
  expect(repo.run(settings).ok).toBe(false);
  const manifest = join(repo.cwd, 'packages/core/pyproject.toml');
  const target = join(service.root, 'outside.toml');
  const original = readFileSync(manifest, 'utf8');
  writeFileSync(target, original);
  unlinkSync(manifest);
  symlinkSync(target, manifest);
  const retry = repo.run(settings);
  expect(retry.ok).toBe(false);
  expect(retry.codes).toContain('EWORKSPACEPATH');
  expect(readFileSync(target, 'utf8')).toBe(original);
  expect(service.state().uploads).toHaveLength(1);
});

test('Python promotes a published next release to main after a fresh-clone retry', async () => {
  const { repo, file, service, settings } = await setup();
  const config = { ...settings, branches: ['main', 'next'] };
  const stable = repo.run(config);
  expect(stable.ok, stable.logs).toBe(true);
  repo.git(repo.cwd, 'checkout', '-b', 'next');
  file('packages/core/src/fixture_core/__init__.py', 'VALUE = 3\n');
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: change core API\n\nBREAKING CHANGE: new API');
  const next = repo.run({
    ...config,
    env: { ...config.env, GITHUB_REF: 'refs/heads/next' },
  });
  expect(next.ok, next.logs).toBe(true);
  expect(repo.tags()).toContain('python/fixture-core@2.0.0');
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--no-edit', 'next');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  const before = service.state().uploads;
  const failed = repo.run({ ...config, failure: 'generate-notes' });
  expect(failed.ok).toBe(false);
  const promotionRef = `refs/notes/workspace-release-channels/${createHash('sha256').update('main').digest('hex')}`;
  const promotion = () =>
    JSON.parse(
      repo.git(
        repo.remote,
        'notes',
        `--ref=${promotionRef}`,
        'show',
        repo.anchor,
      ),
    );
  expect(promotion()).toMatchObject({
    status: 'pending',
    versions: [{ id: 'python:fixture-core', version: '2.0.0' }],
  });
  const result = repo.run(config, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(promotion().status).toBe('complete');
  expect(service.state().uploads).toEqual(before);
  expect(service.state().exchanges).toBe(2);
});

test('Python requires CI identity before building a fresh release', async () => {
  const { repo, service, settings } = await setup();
  const before = repo.refs();
  const result = repo.run({
    ...settings,
    env: { ...settings.env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
  });
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(before);
});

test.each(['default home', 'explicit home'])(
  'Python Rust builds use the configured toolchain from %s',
  async (mode) => {
    const { repo, service, file, settings } = await setup();
    const rustupHome = execFileSync('rustup', ['show', 'home'], {
      encoding: 'utf8',
    }).trim();
    const home = join(service.root, 'build-home');
    mkdirSync(home);
    const configured = join(
      home,
      mode === 'default home' ? '.rustup' : 'custom-rustup',
    );
    symlinkSync(rustupHome, configured, 'dir');
    file(
      'packages/core/pyproject.toml',
      `[project]
name = "fixture-core"
version = "1.0.0"
[build-system]
requires = ["maturin==1.16.0"]
build-backend = "maturin"
[tool.maturin]
bindings = "bin"
`,
    );
    file(
      'packages/core/Cargo.toml',
      `[package]
name = "fixture-core"
version = "1.0.0"
edition = "2024"
`,
    );
    file('packages/core/src/main.rs', 'fn main() { println!("fixture"); }\n');
    repo.git(repo.cwd, 'add', '.');
    repo.commit('fix: build a Rust-backed Python package');
    const result = repo.run({
      ...settings,
      env: {
        ...settings.env,
        HOME: home,
        RUSTUP_HOME: mode === 'explicit home' ? configured : '',
      },
    });
    expect(result.ok, result.logs).toBe(true);
    expect(service.state().uploads).toHaveLength(2);
    expect(service.state().uploads).toContain('fixture_core-1.1.0.tar.gz');
    expect(service.state().uploads.some((name) => name.endsWith('.whl'))).toBe(
      true,
    );
    expect(service.state().exchanges).toBe(1);
    expect(service.state().revocations).toBe(1);
    expect(repo.tags()).toContain('python/fixture-core@1.1.0');
    assertRestored(repo);
  },
);
