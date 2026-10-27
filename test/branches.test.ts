import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';
import { sigstore } from './fixtures/sigstore.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const branches = ['main', { name: 'beta', prerelease: true }];
function workspace() {
  const repo = fixture({ synchronizeDependents: true });
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const name of ['lib', 'app']) {
    mkdirSync(join(repo.cwd, `packages/${name}`), { recursive: true });
    writeFileSync(
      join(repo.cwd, `packages/${name}/package.json`),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(name === 'app' ? { dependencies: { lib: '1.0.0' } } : {}),
      }),
    );
    writeFileSync(
      join(repo.cwd, `packages/${name}/index.js`),
      'export const value = 1;',
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add packages');
  return repo;
}
function change(
  repo: ReturnType<typeof workspace>,
  message = 'fix: improve library',
) {
  writeFileSync(
    join(repo.cwd, 'packages/lib/index.js'),
    `export const value = ${Date.now()};`,
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit(message);
}
function checkout(repo: ReturnType<typeof workspace>, name: string) {
  repo.git(repo.cwd, 'checkout', '-b', name);
  repo.git(repo.cwd, 'push', '-u', 'origin', name);
}
test('real lifecycle plans prereleases, coordinates dependents, increments counters and promotes to stable', () => {
  const repo = workspace();
  expect(repo.run().ok).toBe(true);
  checkout(repo, 'beta');
  change(repo, 'feat: improve library');
  const dry = repo.run({ branches, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  const refs = repo.refs();
  expect(JSON.stringify(dry.result)).toContain('1.2.0-beta.1');
  expect(repo.refs()).toBe(refs);
  const first = repo.run({ branches });
  expect(first.ok, first.logs).toBe(true);
  expect(
    repo
      .state('beta')
      .planning.versions.map((p: { version: string }) => p.version),
  ).toEqual(['1.1.1-beta.1', '1.2.0-beta.1']);
  change(repo);
  const second = repo.run({ branches });
  expect(second.ok, second.logs).toBe(true);
  expect(
    repo
      .state('beta')
      .planning.versions.map((p: { version: string }) => p.version),
  ).toEqual(['1.1.1-beta.2', '1.2.0-beta.2']);
  const noop = repo.run({ branches });
  expect(noop.ok, noop.logs).toBe(true);
  expect(noop.result).toBe(false);
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'beta');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  const stable = repo.run({ branches });
  expect(stable.ok, stable.logs).toBe(true);
  expect(
    repo.state().planning.versions.map((p: { version: string }) => p.version),
  ).toEqual(['1.1.1', '1.2.0']);
});
test('fresh clone resumes a pending prerelease without reallocating versions', () => {
  const repo = workspace();
  expect(repo.run().ok).toBe(true);
  checkout(repo, 'beta');
  change(repo, 'feat: beta library');
  expect(repo.run({ branches, failure: 'publish' }).ok).toBe(false);
  const frozen = repo.state('beta').planning.plan;
  const retry = repo.run({ branches }, repo.clone('beta'));
  expect(retry.ok, retry.logs).toBe(true);
  expect(repo.state('beta').planning.plan).toEqual(frozen);
  expect(repo.state('beta').status).toBe('complete');
});
test('npm channels preserve latest while publishing prereleases and stable promotion', async () => {
  const repo = workspace();
  const service = await registry();
  const settings = {
    branches,
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, 'beta');
  change(repo, 'feat: beta library');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmTags.lib).toEqual({
    latest: '1.1.0',
    beta: '1.2.0-beta.1',
  });
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'beta');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmTags.lib).toEqual({
    latest: '1.2.0',
    beta: '1.2.0-beta.1',
  });
});

test('stable branch promotion adds npm channels for all package versions without republishing', async () => {
  const repo = workspace();
  const service = await registry();
  const settings = {
    branches: ['main', 'next'],
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, 'next');
  change(repo, 'feat: next library\n\nBREAKING CHANGE: new API');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  writeFileSync(
    join(repo.cwd, 'packages/app/index.js'),
    'export const value = 3;',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: next application');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const uploads = service.state().uploads;
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'next');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  const refs = repo.refs();
  const registryBefore = service.state();
  result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  expect(repo.refs()).toBe(refs);
  expect(service.state().uploads).toEqual(registryBefore.uploads);
  expect(service.state().npmTags).toEqual(registryBefore.npmTags);
  service.control('reject');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(false);
  expect(service.state().uploads).toEqual(uploads);
  service.control('');
  result = repo.run(settings, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmTags.lib).toEqual({
    latest: '2.0.0',
    next: '2.0.0',
  });
  expect(service.state().npmTags.app).toEqual({
    latest: '1.1.2',
    next: '1.1.2',
  });
  expect(service.state().uploads).toEqual(uploads);
  change(repo);
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmTags.lib.latest).toBe('2.0.1');
});

test('Cargo publishes coordinated prereleases and stable promotion with native packaging', async () => {
  const repo = workspace();
  const service = await registry();
  mkdirSync(join(repo.cwd, '.cargo'));
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  writeFileSync(join(repo.cwd, '.gitignore'), 'target/\nCargo.lock\n');
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
  );
  for (const name of ['core', 'app']) {
    mkdirSync(join(repo.cwd, `crates/${name}/src`), { recursive: true });
    writeFileSync(
      join(repo.cwd, `crates/${name}/src/lib.rs`),
      'pub fn value() -> u8 { 1 }',
    );
    writeFileSync(
      join(repo.cwd, `crates/${name}/Cargo.toml`),
      `[package]\nname = "branch-${name}"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Branch fixture"\n${name === 'app' ? '[dependencies]\nbranch-core = { path = "../core", version = "=1.0.0" }\n' : ''}`,
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add crates');
  const settings = {
    branches,
    env: service.env,
    pluginConfig: {
      publish: true,
      npm: { registry: service.url },
      cargo: { registry: 'fixture' },
    },
  };
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, 'beta');
  writeFileSync(
    join(repo.cwd, 'crates/core/src/lib.rs'),
    'pub fn value() -> u8 { 2 }',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: improve crate');
  const refs = repo.refs();
  result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  expect(repo.refs()).toBe(refs);
  service.control('reject');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(false);
  const frozen = repo.state('beta').planning.plan;
  service.control('');
  result = repo.run(settings, repo.clone('beta'));
  expect(result.ok, result.logs).toBe(true);
  expect(repo.state('beta').planning.plan).toEqual(frozen);
  expect(service.state().cargo['branch-core']['1.2.0-beta.1']).toBeDefined();
  expect(
    service.state().cargo['branch-app']['1.1.1-beta.1'].metadata.deps[0]
      .version_req,
  ).toBe('=1.2.0-beta.1');
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'beta');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargo['branch-core']['1.2.0']).toBeDefined();
  expect(
    service.state().cargo['branch-app']['1.1.1'].metadata.deps[0].version_req,
  ).toBe('=1.2.0');
});

test('maintenance branches publish npm channels and reject package range overflow in dry-run', async () => {
  const repo = workspace();
  const service = await registry();
  const settings = {
    branches: ['1.x', 'main'],
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  expect(repo.run(settings).ok).toBe(true);
  const base = repo.git(repo.cwd, 'rev-parse', 'HEAD');
  checkout(repo, '1.x');
  repo.git(repo.cwd, 'checkout', 'main');
  writeFileSync(
    join(repo.cwd, 'packages/app/index.js'),
    'export const value = 2;',
  );
  change(repo, 'feat: new stable API\n\nBREAKING CHANGE: new API');
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  repo.git(repo.cwd, 'checkout', '1.x');
  change(repo);
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(
    repo
      .state('1.x')
      .planning.versions.find((pkg: { id: string }) => pkg.id === 'npm:lib')
      .version,
  ).toBe('1.1.1');
  expect(service.state().npmTags.lib).toEqual({
    latest: '2.0.0',
    'release-1.x': '1.1.1',
  });
  expect(repo.git(repo.cwd, 'merge-base', 'HEAD', base)).toBe(base);
  change(repo, 'feat: incompatible backport\n\nBREAKING CHANGE: incompatible');
  const refs = repo.refs();
  result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(false);
  expect(repo.refs()).toBe(refs);
});

test('parallel prerelease branches coordinate independently at the same source head', async () => {
  const repo = workspace();
  const service = await registry();
  const settings = {
    branches: [
      'main',
      { name: 'alpha', prerelease: true },
      { name: 'beta', prerelease: true },
    ],
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  expect(repo.run(settings).ok).toBe(true);
  checkout(repo, 'alpha');
  change(repo, 'feat: future library');
  checkout(repo, 'beta');
  repo.git(repo.cwd, 'checkout', 'alpha');
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  repo.git(repo.cwd, 'checkout', 'beta');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmTags.lib).toEqual({
    latest: '1.1.0',
    alpha: '1.2.0-alpha.1',
    beta: '1.2.0-beta.1',
  });
  expect(repo.state('alpha').execution.prepared).not.toBe(
    repo.state('beta').execution.prepared,
  );
  for (const counter of [2, 3]) {
    change(repo);
    result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    expect(result.result).toMatchObject({
      nextRelease: { version: `1.1.0-beta.${counter}` },
    });
    expect(service.state().npmTags.lib.beta).toBe(`1.2.0-beta.${counter}`);
  }
  repo.git(repo.cwd, 'checkout', 'alpha');
  change(repo);
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(result.result).toMatchObject({
    nextRelease: { version: '1.1.0-alpha.2' },
  });
});

test('hyphenated prerelease identifiers retain counters and reject channel drift on a pending batch', () => {
  const repo = workspace();
  expect(repo.run().ok).toBe(true);
  checkout(repo, 'preview');
  change(repo, 'feat: preview library');
  const configuration = [
    'main',
    { name: 'preview', prerelease: 'beta-test', channel: 'preview' },
  ];
  let result = repo.run({ branches: configuration });
  expect(result.ok, result.logs).toBe(true);
  change(repo);
  result = repo.run({ branches: configuration, failure: 'publish' });
  expect(result.ok).toBe(false);
  const pending = repo.state('preview').planning.plan;
  expect(
    pending.packages.find((pkg: { id: string }) => pkg.id === 'npm:lib')
      .nextVersion,
  ).toBe('1.2.0-beta-test.2');
  result = repo.run({
    branches: [
      'main',
      { name: 'preview', prerelease: 'beta-test', channel: 'changed' },
    ],
  });
  expect(result.ok).toBe(false);
  expect(repo.state('preview').planning.plan).toEqual(pending);
  result = repo.run({ branches: configuration }, repo.clone('preview'));
  expect(result.ok, result.logs).toBe(true);
});

test('per-package higher-branch bounds reject a dependency bump even when the coordinator patch fits', () => {
  const repo = workspace();
  expect(repo.run().ok).toBe(true);
  checkout(repo, 'next');
  change(repo, 'feat: next library');
  let result = repo.run({ branches: ['main', 'next'] });
  expect(result.ok, result.logs).toBe(true);
  repo.git(repo.cwd, 'checkout', 'main');
  change(repo);
  const refs = repo.refs();
  result = repo.run({ branches: ['main', 'next'], dryRun: true });
  expect(result.ok, result.logs).toBe(false);
  expect(result.codes).toContain('EWORKSPACEBRANCH');
  expect(repo.refs()).toBe(refs);
});

test('OIDC promotion preserves signed artifacts and resumes uncertain dist-tags without CI credentials', async () => {
  const repo = workspace();
  const service = await registry();
  const signing = await sigstore();
  writeFileSync(
    join(repo.cwd, 'packages/app/package.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      private: true,
      dependencies: { lib: '1.0.0' },
    }),
  );
  writeFileSync(
    join(repo.cwd, 'packages/lib/package.json'),
    JSON.stringify({
      name: 'lib',
      version: '1.0.0',
      repository: 'https://github.com/fixture/repo',
    }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: configure provenance');
  const env = {
    ...service.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'fixture/repo',
    GITHUB_REPOSITORY_ID: '123',
    GITHUB_REPOSITORY_OWNER_ID: '456',
    GITHUB_WORKFLOW_REF:
      'fixture/repo/.github/workflows/release.yml@refs/heads/main',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: repo.git(repo.cwd, 'rev-parse', 'HEAD'),
    GITHUB_EVENT_NAME: 'push',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY_VISIBILITY: 'public',
    ACTIONS_ID_TOKEN_REQUEST_URL: `${service.url}/oidc`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ci-request-secret',
  };
  const settings = {
    branches: ['main', 'next'],
    env,
    pluginConfig: {
      publish: true,
      npm: {
        registry: service.url,
        access: 'public',
        trustedPublishing: true,
        provenance: true,
        sigstore: signing.config,
      },
    },
  };
  service.trusted({ head: env.GITHUB_SHA });
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, 'next');
  change(repo, 'feat: future library');
  env.GITHUB_SHA = repo.git(repo.cwd, 'rev-parse', 'HEAD');
  env.GITHUB_REF = 'refs/heads/next';
  env.GITHUB_WORKFLOW_REF = env.GITHUB_WORKFLOW_REF.replace('/main', '/next');
  service.trusted({
    head: env.GITHUB_SHA,
    claims: {
      workflow_identity:
        'https://github.com/fixture/repo/.github/workflows/release.yml@refs/heads/next',
    },
  });
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const retained = service.state().npm.lib['1.2.0'];
  const uploads = service.state().uploads;
  const signingCalls = () =>
    signing.events().filter((path) => path.startsWith('/api/'));
  const signed = signingCalls();
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'next');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  env.GITHUB_REF = 'refs/heads/main';
  env.GITHUB_WORKFLOW_REF = env.GITHUB_WORKFLOW_REF.replace('/next', '/main');
  service.control('reject');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(false);
  const exchanges = service.state().exchanges.length;
  const refs = repo.refs();
  result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  expect(repo.refs()).toBe(refs);
  expect(service.state().exchanges).toHaveLength(exchanges);
  expect(service.state().npmTags.lib.latest).toBe('1.1.0');
  service.control('once-drop-unreadable');
  result = repo.run(settings, repo.clone('main', 'retry-first'));
  expect(result.ok).toBe(false);
  expect(service.state().npmTags.lib.latest).toBe('1.2.0');
  const acceptedExchanges = service.state().exchanges.length;
  service.control('');
  result = repo.run(
    { ...settings, env: { ...service.env } },
    repo.clone('main', 'retry-confirmed'),
  );
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().exchanges).toHaveLength(acceptedExchanges);
  expect(service.state().npm.lib['1.2.0']).toEqual(retained);
  expect(service.state().uploads).toEqual(uploads);
  expect(signingCalls()).toEqual(signed);
  expect(result.logs).not.toContain('secret');
});

test.each(['beta.test', '123'])(
  'rejects prerelease identifiers unsupported by semantic-release before writing state: %s',
  (preid) => {
    const repo = workspace();
    checkout(repo, 'preview');
    const refs = repo.refs();
    const result = repo.run({
      branches: ['main', { name: 'preview', prerelease: preid }],
    });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain('EWORKSPACECONFIG');
    expect(repo.refs()).toBe(refs);
  },
);

test('dry-run rejects a package version already tagged on an unmerged branch', () => {
  const repo = workspace();
  expect(repo.run().ok).toBe(true);
  checkout(repo, 'other');
  change(repo, 'fix: other branch library');
  repo.git(repo.cwd, 'tag', 'npm/lib@1.1.1');
  repo.git(repo.cwd, 'push', 'origin', 'npm/lib@1.1.1');
  repo.git(repo.cwd, 'checkout', 'main');
  change(repo);
  const refs = repo.refs();
  const result = repo.run({ dryRun: true });
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACETAG');
  expect(repo.refs()).toBe(refs);
});

test('Cargo maintenance releases coordinate dependencies on the older release line', async () => {
  const repo = fixture({ synchronizeDependents: true });
  const service = await registry();
  mkdirSync(join(repo.cwd, '.cargo'));
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  writeFileSync(join(repo.cwd, '.gitignore'), 'target/\nCargo.lock\n');
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
  );
  for (const name of ['core', 'app']) {
    mkdirSync(join(repo.cwd, `crates/${name}/src`), { recursive: true });
    writeFileSync(
      join(repo.cwd, `crates/${name}/src/lib.rs`),
      'pub fn value() -> u8 { 1 }',
    );
    writeFileSync(
      join(repo.cwd, `crates/${name}/Cargo.toml`),
      `[package]\nname = "line-${name}"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Line fixture"\n${name === 'app' ? '[dependencies]\nline-core = { path = "../core", version = "=1.0.0" }\n' : ''}`,
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add crates');
  const settings = {
    branches: ['1.x', 'main'],
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  };
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, '1.x');
  repo.git(repo.cwd, 'checkout', 'main');
  for (const name of ['core', 'app'])
    writeFileSync(
      join(repo.cwd, `crates/${name}/src/lib.rs`),
      'pub fn value() -> u8 { 2 }',
    );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: new API\n\nBREAKING CHANGE: new API');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  repo.git(repo.cwd, 'checkout', '1.x');
  writeFileSync(
    join(repo.cwd, 'crates/core/src/lib.rs'),
    'pub fn value() -> u8 { 3 }',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: backport crate');
  const refs = repo.refs();
  const uploads = service.state().uploads;
  result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  expect(repo.refs()).toBe(refs);
  expect(service.state().uploads).toEqual(uploads);
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargo['line-core']['1.1.1']).toBeDefined();
  expect(
    service.state().cargo['line-app']['1.1.1'].metadata.deps[0].version_req,
  ).toBe('=1.1.1');
  expect(repo.state('1.x').planning.plan.release.channel).toBe('1.x');
  expect(service.state().channelUpdates).toBeUndefined();
});

test('channel promotion forbids credential-bearing redirects and recovers in a fresh clone', async () => {
  const repo = workspace();
  const service = await registry();
  const receiver = await registry();
  const settings = {
    branches: ['main', 'next'],
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, 'next');
  change(repo, 'feat: future library');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'next');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  const uploads = service.state().uploads;
  service.control(`redirect-put:${receiver.url}`);
  result = repo.run(settings);
  expect(result.ok).toBe(false);
  expect(receiver.state().requests).toEqual([]);
  expect(result.logs).not.toContain('fixture-token');
  service.control('');
  result = repo.run(settings, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmTags.lib.latest).toBe('1.2.0');
  expect(service.state().uploads).toEqual(uploads);
});

test('changing the primary release branch cannot hide a pending first batch', () => {
  const repo = workspace();
  expect(repo.run({ failure: 'after-prepare' }).ok).toBe(false);
  checkout(repo, 'other');
  repo.git(repo.cwd, 'checkout', 'main');
  const refs = repo.refs();
  const result = repo.run({ branches: ['other', 'main'] });
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACEPLAN');
  expect(repo.refs()).toBe(refs);
});

test('merging an unfinished higher branch cannot promote its batch tag or record fake completion', () => {
  const repo = workspace();
  expect(repo.run().ok).toBe(true);
  checkout(repo, 'next');
  change(repo, 'feat: unfinished next release');
  expect(repo.run({ branches: ['main', 'next'], failure: 'publish' }).ok).toBe(
    false,
  );
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'next');
  change(repo, 'feat: stronger main signal\n\nBREAKING CHANGE: new API');
  const refs = repo.refs();
  const complete = repo.state();
  const result = repo.run({ branches: ['main', 'next'] });
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACEJOURNAL');
  expect(repo.refs()).toBe(refs);
  expect(repo.state()).toEqual(complete);
});

test('another stable branch cannot invalidate a pending coordinator reservation, even for unrelated packages', () => {
  const repo = workspace();
  writeFileSync(
    join(repo.cwd, 'packages/app/package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0' }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: independent application');
  expect(repo.run().ok).toBe(true);
  checkout(repo, 'next');
  change(repo, 'feat: next library');
  expect(
    repo.run({ branches: ['main', 'next'], failure: 'after-prepare' }).ok,
  ).toBe(false);
  const frozen = repo.state('next').planning.plan;
  repo.git(repo.cwd, 'checkout', 'main');
  writeFileSync(
    join(repo.cwd, 'packages/app/index.js'),
    'export const value = 3;',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: major application\n\nBREAKING CHANGE: application API');
  const refs = repo.refs();
  const result = repo.run({ branches: ['main', 'next'], dryRun: true });
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACEPENDING');
  expect(repo.refs()).toBe(refs);
  const retry = repo.run({ branches: ['main', 'next'] }, repo.clone('next'));
  expect(retry.ok, retry.logs).toBe(true);
  expect(repo.state('next').planning.plan).toEqual(frozen);
});

test('a pending prerelease does not consume another prerelease branch counter', () => {
  const repo = workspace();
  expect(repo.run().ok).toBe(true);
  const configuration = [
    'main',
    { name: 'alpha', prerelease: true },
    { name: 'beta', prerelease: true },
  ];
  checkout(repo, 'alpha');
  change(repo, 'feat: prerelease library');
  checkout(repo, 'beta');
  repo.git(repo.cwd, 'checkout', 'alpha');
  expect(
    repo.run({ branches: configuration, failure: 'after-prepare' }).ok,
  ).toBe(false);
  const frozen = repo.state('alpha').planning.plan;
  repo.git(repo.cwd, 'checkout', 'beta');
  let result = repo.run({ branches: configuration });
  expect(result.ok, result.logs).toBe(true);
  result = repo.run({ branches: configuration }, repo.clone('alpha'));
  expect(result.ok, result.logs).toBe(true);
  expect(repo.state('alpha').planning.plan).toEqual(frozen);
  expect(
    repo
      .state('beta')
      .planning.versions.find((pkg: { id: string }) => pkg.id === 'npm:lib')
      .version,
  ).toBe('1.2.0-beta.1');
});

test('completed legacy journals retain dependency projections without archived release plans', () => {
  const repo = workspace();
  expect(repo.run().ok).toBe(true);
  mkdirSync(join(repo.cwd, 'packages/tool'));
  writeFileSync(
    join(repo.cwd, 'packages/tool/package.json'),
    JSON.stringify({ name: 'tool', version: '1.0.0' }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: unrelated tool');
  expect(repo.run().ok).toBe(true);
  for (const directory of [repo.cwd, repo.remote]) {
    const refs = repo
      .git(
        directory,
        'for-each-ref',
        '--format=%(refname)',
        'refs/notes/workspace-release-history',
      )
      .split('\n')
      .filter(Boolean);
    for (const ref of refs) repo.git(directory, 'update-ref', '-d', ref);
  }
  change(repo, 'feat: next library');
  const result = repo.run({}, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(
    repo
      .state()
      .planning.plan.packages.find(
        (pkg: { id: string }) => pkg.id === 'npm:app',
      ).nextVersion,
  ).toBe('1.1.1');
});

test('stable plans do not inherit dev dependency projections from prerelease carriers', () => {
  const repo = workspace();
  writeFileSync(
    join(repo.cwd, 'packages/app/package.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      devDependencies: { lib: '1.0.0' },
    }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: dev dependency');
  expect(repo.run().ok).toBe(true);
  checkout(repo, 'beta');
  change(repo, 'feat: prerelease library');
  let result = repo.run({ branches });
  expect(result.ok, result.logs).toBe(true);
  expect(
    repo
      .state('beta')
      .planning.plan.packages.find(
        (pkg: { id: string }) => pkg.id === 'npm:app',
      ).nextVersion,
  ).toBe(null);
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'beta');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  result = repo.run({ branches });
  expect(result.ok, result.logs).toBe(true);
  const updates = repo
    .state()
    .planning.plan.packages.find(
      (pkg: { id: string }) => pkg.id === 'npm:app',
    ).dependencyUpdates;
  expect(updates).toEqual([
    expect.objectContaining({ field: ['devDependencies', 'lib'], to: '1.2.0' }),
  ]);
  writeFileSync(
    join(repo.cwd, 'packages/app/index.js'),
    'export const value = 3;',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: application');
  result = repo.run({ branches });
  expect(result.ok, result.logs).toBe(true);
  expect(
    repo
      .state()
      .planning.plan.packages.find(
        (pkg: { id: string }) => pkg.id === 'npm:app',
      ).dependencyUpdates,
  ).toEqual(updates);
});

test('a release from the feature root commit does not shadow semantic-release channel metadata', () => {
  const repo = workspace();
  const root = repo.git(
    repo.cwd,
    'commit-tree',
    'HEAD^{tree}',
    '-m',
    'feat: first packages',
  );
  repo.git(repo.cwd, 'reset', '--hard', root);
  repo.git(repo.cwd, 'push', '--force', 'origin', 'main');
  let result = repo.run();
  expect(result.ok, result.logs).toBe(true);
  change(repo);
  result = repo.run({}, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(result.result).toMatchObject({ nextRelease: { version: '1.0.1' } });
});

test('legacy root pending releases repair channel notes without republishing or changing the frozen plan', async () => {
  const repo = workspace();
  const service = await registry();
  const root = repo.git(
    repo.cwd,
    'commit-tree',
    'HEAD^{tree}',
    '-m',
    'feat: first packages',
  );
  repo.git(repo.cwd, 'reset', '--hard', root);
  repo.git(repo.cwd, 'push', '--force', 'origin', 'main');
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  expect(repo.run({ ...settings, failure: 'publish' }).ok).toBe(false);
  const raw = () =>
    repo.git(
      repo.remote,
      'notes',
      '--ref=refs/notes/semantic-release-workspace',
      'show',
      root,
    );
  const frozen = raw();
  const uploads = service.state().uploads;
  for (const directory of [repo.cwd, repo.remote]) {
    repo.git(
      directory,
      'update-ref',
      '-d',
      'refs/notes/semantic-release-0-workspace',
    );
    repo.git(
      directory,
      'update-ref',
      '-d',
      `refs/notes/semantic-release-${JSON.parse(frozen).batchTag}`,
    );
  }
  const before = repo.refs();
  const clone = repo.clone();
  let result = repo.run({ ...settings, dryRun: true }, clone);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACECHANNELRETRY');
  expect(repo.refs()).toBe(before);
  expect(raw()).toBe(frozen);
  result = repo.run(settings, clone);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACECHANNELRETRY');
  expect(raw()).toBe(frozen);
  expect(service.state().uploads).toEqual(uploads);
  result = repo.run(settings, clone);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual(uploads);
  expect(JSON.parse(raw()).planning.plan).toEqual(
    JSON.parse(frozen).planning.plan,
  );
  expect(JSON.parse(raw()).status).toBe('complete');
});

test('legacy channel repair does not preempt maintenance promotion of a different branch release', async () => {
  const repo = workspace();
  const service = await registry();
  const root = repo.git(
    repo.cwd,
    'commit-tree',
    'HEAD^{tree}',
    '-m',
    'feat: first packages',
  );
  repo.git(repo.cwd, 'reset', '--hard', root);
  repo.git(repo.cwd, 'push', '--force', 'origin', 'main');
  const settings = {
    branches: ['1.x', 'main'],
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  checkout(repo, '1.x');
  repo.git(repo.cwd, 'checkout', 'main');
  change(repo, 'feat: new API\n\nBREAKING CHANGE: new API');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const uploads = service.state().uploads;
  for (const directory of [repo.cwd, repo.remote])
    repo.git(
      directory,
      'update-ref',
      '-d',
      'refs/notes/semantic-release-0-workspace',
    );
  const clone = repo.clone('1.x');
  result = repo.run(settings, clone);
  expect(result.codes, result.logs).toContain('EWORKSPACECHANNELRETRY');
  const channels = () =>
    JSON.parse(
      repo.git(
        repo.remote,
        'notes',
        '--ref=refs/notes/semantic-release-0-workspace',
        'show',
        root,
      ),
    ).channels;
  expect(channels()).toEqual([null]);
  expect(service.state().npmTags.lib['release-1.x']).toBeUndefined();
  result = repo.run(settings, clone);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npmTags.lib).toEqual({
    latest: '2.0.0',
    'release-1.x': '1.1.0',
  });
  expect(channels()).toEqual([null, '1.x']);
  expect(service.state().uploads).toEqual(uploads);
});
