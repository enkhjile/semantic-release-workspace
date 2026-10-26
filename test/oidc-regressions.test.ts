import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function setup(names = ['identity-fixture']) {
  const repo = fixture();
  const service = await registry();
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const [i, name] of names.entries()) {
    mkdirSync(join(repo.cwd, `packages/${i}`), { recursive: true });
    writeFileSync(
      join(repo.cwd, `packages/${i}/package.json`),
      JSON.stringify({
        name,
        version: '1.0.0',
        repository: 'https://github.com/fixture/repo',
      }),
    );
    writeFileSync(
      join(repo.cwd, `packages/${i}/index.js`),
      'export const value = 42;\n',
    );
  }
  repo.git(repo.cwd, 'add', '.');
  const head = repo.commit('feat: add identity fixtures');
  service.trusted({ head });
  const settings = {
    env: {
      ...service.env,
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'fixture/repo',
      GITHUB_REPOSITORY_ID: '123',
      GITHUB_REPOSITORY_OWNER_ID: '456',
      GITHUB_WORKFLOW_REF:
        'fixture/repo/.github/workflows/release.yml@refs/heads/main',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: head,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      RUNNER_ENVIRONMENT: 'github-hosted',
      GITHUB_REPOSITORY_VISIBILITY: 'public',
      ACTIONS_ID_TOKEN_REQUEST_URL: `${service.url}/oidc`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ci-request-secret',
    },
    pluginConfig: {
      publish: true,
      npm: {
        registry: service.url,
        access: 'public',
        trustedPublishing: true,
        provenance: false,
      },
    },
  };
  return { repo, service, settings };
}

const identityRequests = (service: Awaited<ReturnType<typeof registry>>) =>
  service
    .state()
    .requests.filter((call: { path: string }) => call.path.startsWith('/oidc'));
const exchangeRequests = (service: Awaited<ReturnType<typeof registry>>) =>
  service
    .state()
    .requests.filter(
      (call: { path: string }) =>
        call.path.includes('/token/exchange/') ||
        call.path.endsWith('/trusted_publishing/tokens'),
    );

test.each([
  ['wrong audience', { claims: { aud: 'npm:registry.npmjs.org' } }],
  ['null audience', { claims: { aud: null } }],
  ['missing audience', { identityValue: 'e30.e30.signature' }],
  ['mixed audience array', { claims: { aud: ['npm:127.0.0.1', 7] } }],
  ['malformed JWT', { identityValue: 'echoed-identity-secret' }],
])(
  'fetched npm identity with %s is rejected before permissive exchange sees it',
  async (_label, response) => {
    const { repo, service, settings } = await setup();
    service.trusted(response);
    const result = repo.run(settings);
    expect(exchangeRequests(service)).toEqual([]);
    expect(result.codes).toContain('EWORKSPACEOIDC');
    expect(service.state().uploads).toEqual([]);
    expect(
      identityRequests(service).map((call: { path: string }) => call.path),
    ).toEqual(['/oidc?audience=npm%3A127.0.0.1']);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(repo.state())).not.toContain('secret');
  },
);

test.each([['npm:127.0.0.1'], [['other', 'npm:127.0.0.1']]])(
  'matching fetched npm audience %j reaches real archive upload',
  async (aud) => {
    const { repo, service, settings } = await setup();
    service.trusted({ claims: { aud } });
    const result = repo.run(settings);
    expect(result.ok, result.logs).toBe(true);
    expect(exchangeRequests(service)).toHaveLength(1);
    expect(service.state().uploads).toEqual(['npm:identity-fixture@1.1.0']);
    expect(
      service.state().npm['identity-fixture']['1.1.0'].metadata.version,
    ).toBe('1.1.0');
  },
);

test('fetched Cargo identity is checked before a permissive registry receives the JWT', async () => {
  const { repo, service, settings } = await setup();
  rmSync(join(repo.cwd, 'packages'), { recursive: true });
  mkdirSync(join(repo.cwd, '.cargo'));
  mkdirSync(join(repo.cwd, 'crate/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crate"]\nresolver = "3"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crate/Cargo.toml'),
    '[package]\nname = "identity-crate"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "identity fixture"\npublish = ["fixture"]\n',
  );
  writeFileSync(
    join(repo.cwd, 'crate/src/lib.rs'),
    'pub fn value() -> u32 {42}\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add Cargo identity fixture');
  service.trusted({ claims: { aud: 'crates.io' } });
  service.cargoTrusted({ permissiveAudience: true });
  const result = repo.run({
    ...settings,
    pluginConfig: {
      publish: true,
      cargo: { registry: 'fixture', trustedPublishing: true },
    },
  });
  expect(exchangeRequests(service)).toEqual([]);
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(service.state().uploads).toEqual([]);
  expect(
    identityRequests(service).map((call: { path: string }) =>
      new URL(call.path, service.url).searchParams.get('audience'),
    ),
  ).toEqual([`${service.url.replace(/^https?:\/\//, '')}/cargo`]);
  expect(JSON.stringify(result)).not.toContain('secret');
});

test('fetched Sigstore identity is checked before any signing service receives it', async () => {
  const { repo, service, settings } = await setup();
  const signing = await sigstore();
  service.trusted({
    head: settings.env.GITHUB_SHA,
    claims: { aud: 'npm:127.0.0.1' },
  });
  const result = repo.run({
    ...settings,
    pluginConfig: {
      ...settings.pluginConfig,
      npm: {
        ...settings.pluginConfig.npm,
        provenance: true,
        sigstore: signing.config,
      },
    },
  });
  expect(signing.events()).toEqual([]);
  expect(result.codes).toContain('EWORKSPACEPROVENANCE');
  expect(exchangeRequests(service)).toEqual([]);
  expect(service.state().uploads).toEqual([]);
  expect(
    identityRequests(service).map((call: { path: string }) => call.path),
  ).toEqual(['/oidc?audience=sigstore']);
  expect(JSON.stringify(result)).not.toContain('secret');
});

test.each([
  ['expired ISO expiry', { expires: '2020-01-01T00:00:00.000Z' }],
  ['malformed ISO expiry', { expires: 'exchange-secret echoed by upstream' }],
  ['expired numeric expiry', { expires: 0 }],
  ['overflowing numeric expiry', { expires: 1e308 }],
  ['null expiry', { expires: null }],
  ['boolean expiry', { expires: true }],
  ['object expiry', { expires: {} }],
  ['array expiry', { expires: [] }],
  ['wrong token type', { token_type: 'Bearer' }],
  ['empty token', { token: '' }],
  ['numeric token', { token: 42 }],
])(
  'npm exchange rejects %s after identity acquisition without upload or secret disclosure',
  async (_label, exchangeResponse) => {
    const { repo, service, settings } = await setup();
    service.trusted({ exchangeResponse });
    const result = repo.run(settings);
    expect(result.codes).toContain('EWORKSPACEOIDC');
    expect(identityRequests(service)).toHaveLength(1);
    expect(exchangeRequests(service)).toHaveLength(1);
    expect(service.state().uploads).toEqual([]);
    expect(
      service
        .state()
        .requests.filter((call: { method: string }) => call.method === 'PUT'),
    ).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(repo.state())).not.toContain('secret');
    expect(repo.tags()).not.toContain('npm/identity-fixture@1.1.0');
  },
);

test('numeric Unix-second npm exchange timestamps allow native pack/upload and a no-change rerun', async () => {
  const { repo, service, settings } = await setup();
  service.trusted({ numericDates: true });
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(identityRequests(service)).toHaveLength(1);
  expect(exchangeRequests(service)).toHaveLength(1);
  expect(service.state().uploads).toEqual(['npm:identity-fixture@1.1.0']);
  const bytes = Buffer.from(
    service.state().npm['identity-fixture']['1.1.0'].artifact,
    'base64',
  );
  const manifest = JSON.parse(
    execFileSync('tar', ['-xzOf', '-', 'package/package.json'], {
      input: bytes,
      encoding: 'utf8',
    }),
  );
  expect(manifest.name).toBe('identity-fixture');
  expect(manifest.version).toBe('1.1.0');
  expect(
    execFileSync('tar', ['-xzOf', '-', 'package/index.js'], {
      input: bytes,
      encoding: 'utf8',
    }),
  ).toBe('export const value = 42;\n');
  expect(repo.state().status).toBe('complete');
  expect(JSON.stringify(repo.state())).not.toContain('secret');
  expect(JSON.stringify(result)).not.toContain('secret');
  const before = service.state();
  const refs = repo.refs();
  const unchanged = repo.run(settings);
  expect(unchanged.ok, unchanged.logs).toBe(true);
  expect(unchanged.result).toBe(false);
  expect(service.state()).toEqual(before);
  expect(repo.refs()).toBe(refs);
});

test('numeric exchange configuration still performs a dry run without identity or remote mutation', async () => {
  const { repo, service, settings } = await setup();
  service.trusted({ numericDates: true });
  const manifest = readFileSync(
    join(repo.cwd, 'packages/0/package.json'),
    'utf8',
  );
  const refs = repo.refs();
  const result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(refs);
  expect(readFileSync(join(repo.cwd, 'packages/0/package.json'), 'utf8')).toBe(
    manifest,
  );
});

test.each([false, true])(
  'exchange expiry with less than fifteen seconds remaining rejects ISO/numeric=%s',
  async (numericDates) => {
    const { repo, service, settings } = await setup();
    service.trusted({ numericDates, expiresInMs: 10_000 });
    const result = repo.run(settings);
    expect(result.codes).toContain('EWORKSPACEOIDC');
    expect(exchangeRequests(service)).toHaveLength(1);
    expect(service.state().uploads).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret');
  },
);

test('numeric-looking expiry strings are rejected without coercion', async () => {
  const { repo, service, settings } = await setup();
  service.trusted({
    exchangeResponse: { expires: String(Math.floor(Date.now() / 1000) + 3600) },
  });
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(exchangeRequests(service)).toHaveLength(1);
  expect(service.state().uploads).toEqual([]);
});

test('numeric npm exchanges renew only remaining packages during a fresh-clone partial retry', async () => {
  const { repo, service, settings } = await setup([
    'identity-one',
    'identity-two',
  ]);
  service.trusted({ numericDates: true });
  service.control('reject-second');
  const first = repo.run(settings);
  expect(first.ok).toBe(false);
  expect(service.state().uploads).toEqual(['npm:identity-one@1.1.0']);
  expect(exchangeRequests(service)).toHaveLength(2);
  const retained = repo
    .state()
    .execution.packages.map((entry: { artifact: unknown }) => entry.artifact);
  service.control('');
  const recovered = repo.run(settings, repo.clone());
  expect(recovered.ok, recovered.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'npm:identity-one@1.1.0',
    'npm:identity-two@1.1.0',
  ]);
  expect(
    service.state().exchanges.map((entry: { name: string }) => entry.name),
  ).toEqual(['identity-one', 'identity-two', 'identity-two']);
  expect(
    repo
      .state()
      .execution.packages.map((entry: { artifact: unknown }) => entry.artifact),
  ).toEqual(retained);
  expect(repo.state().status).toBe('complete');
  expect(JSON.stringify(repo.state())).not.toContain('secret');
  expect(JSON.stringify(recovered)).not.toContain('secret');
});

test('numeric exchange accepted uploads reconcile from a fresh clone without new CI credentials', async () => {
  const { repo, service, settings } = await setup();
  service.trusted({ numericDates: true });
  service.control('once-drop-unreadable');
  expect(repo.run(settings).ok).toBe(false);
  expect(service.state().uploads).toEqual(['npm:identity-fixture@1.1.0']);
  const artifact = repo.state().execution.packages[0].artifact;
  service.control('');
  const recovered = repo.run({ ...settings, env: service.env }, repo.clone());
  expect(recovered.ok, recovered.logs).toBe(true);
  expect(service.state().uploads).toEqual(['npm:identity-fixture@1.1.0']);
  expect(exchangeRequests(service)).toHaveLength(1);
  expect(identityRequests(service)).toHaveLength(1);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(repo.state().status).toBe('complete');
});
