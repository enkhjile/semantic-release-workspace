import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createCargoIdentity } from '../src/cargo-identity.js';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function setup(dependents = false) {
  const repo = fixture();
  const service = await registry();
  service.trusted();
  service.cargoTrusted();
  mkdirSync(join(repo.cwd, '.cargo'));
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
  );
  for (const name of dependents ? ['core', 'app'] : ['core']) {
    mkdirSync(join(repo.cwd, `crates/${name}/src`), { recursive: true });
    writeFileSync(
      join(repo.cwd, `crates/${name}/Cargo.toml`),
      `[package]\nname = "trusted-${name}"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "OIDC fixture"\npublish = ["fixture"]\n${name === 'app' ? '[dependencies]\ntrusted-core = {path = "../core", version = "=1.0.0"}\n' : ''}`,
    );
    writeFileSync(
      join(repo.cwd, `crates/${name}/src/lib.rs`),
      name === 'core'
        ? 'pub fn value() -> u32 {1}\n'
        : 'pub fn value() -> u32 {trusted_core::value()}\n',
    );
  }
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add crates');
  const env = {
    ...service.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: repo.git(repo.cwd, 'rev-parse', 'HEAD'),
    GITHUB_EVENT_NAME: 'push',
    ACTIONS_ID_TOKEN_REQUEST_URL: `${service.url}/oidc`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ci-request-secret',
  };
  const settings = {
    env,
    pluginConfig: {
      publish: true,
      cargo: { registry: 'fixture', trustedPublishing: true },
    },
  };
  return { repo, service, settings };
}
test('Cargo OIDC exchanges once for coordinated crates, publishes and revokes using real semantic-release', async () => {
  const { repo, service, settings } = await setup(true);
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toHaveLength(1);
  expect(service.state().cargoExchanges[0].revoked).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:trusted-core@1.1.0',
    'cargo:trusted-app@1.1.0',
  ]);
  expect(repo.state().status).toBe('complete');
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT')
      .every((call: { userAgent: string }) =>
        call.userAgent.includes('semantic-release-workspace'),
      ),
  ).toBe(true);
  expect(
    repo
      .state()
      .execution.packages.every(
        (entry: { destination: { cargoAuth?: string } }) =>
          entry.destination.cargoAuth === 'oidc',
      ),
  ).toBe(true);
  expect(JSON.stringify(repo.state())).not.toContain('secret');
  expect(result.logs).not.toContain('secret');
});
test('Cargo OIDC dry runs do not request identity, exchange, pack, revoke or write refs', async () => {
  const { repo, service, settings } = await setup();
  const refs = repo.refs();
  const manifest = readFileSync(
    join(repo.cwd, 'crates/core/Cargo.toml'),
    'utf8',
  );
  const result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(refs);
  expect(readFileSync(join(repo.cwd, 'crates/core/Cargo.toml'), 'utf8')).toBe(
    manifest,
  );
});
test('required Cargo OIDC validates missing CI identity during dry-run preflight', async () => {
  const { repo, service, settings } = await setup();
  const result = repo.run({ ...settings, env: service.env, dryRun: true });
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(service.state().requests).toEqual([]);
});

test('Cargo OIDC no-change runs perform no new registry or identity calls', async () => {
  const { repo, service, settings } = await setup();
  expect(repo.run(settings).ok).toBe(true);
  const before = service.state();
  const refs = repo.refs();
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(result.result).toBe(false);
  expect(service.state()).toEqual(before);
  expect(repo.refs()).toBe(refs);
});
test('fresh clone confirms an uncertain Cargo upload without any CI identity or duplicate exchange', async () => {
  const { repo, service, settings } = await setup();
  service.control('once-drop-unreadable');
  expect(repo.run(settings).ok).toBe(false);
  expect(service.state().cargoExchanges[0].revoked).toBe(true);
  const artifact = repo.state().execution.packages[0].artifact;
  expect(repo.state().execution.packages[0].intent).toBe(true);
  service.control('');
  const result = repo.run({ ...settings, env: service.env }, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toHaveLength(1);
  expect(service.state().uploads).toHaveLength(1);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(repo.tags()).toContain('cargo/trusted-core@1.1.0');
  expect(
    repo.git(repo.remote, 'show', `${artifact.commit}:metadata.json`),
  ).not.toContain('secret');
});
test('rejected Cargo uploads revoke their token and fresh clones reuse artifacts with fresh credentials', async () => {
  const { repo, service, settings } = await setup();
  service.control('once-reject');
  expect(repo.run(settings).ok).toBe(false);
  const artifact = repo.state().execution.packages[0].artifact;
  expect(service.state().cargoExchanges[0].revoked).toBe(true);
  const result = repo.run(settings, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toHaveLength(2);
  expect(
    service
      .state()
      .cargoExchanges.every((entry: { revoked: boolean }) => entry.revoked),
  ).toBe(true);
  expect(service.state().uploads).toHaveLength(1);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
});
test.each([{ rejectExchange: true }, { badJSON: true }, { emptyToken: true }])(
  'Cargo OIDC exchange failure %j never falls back to native credentials',
  async (failure) => {
    const { repo, service, settings } = await setup();
    service.cargoTrusted(failure);
    const result = repo.run(settings);
    expect(result.codes).toContain('EWORKSPACEOIDC');
    expect(service.state().uploads).toEqual([]);
    expect(
      service
        .state()
        .requests.filter((call: { method: string }) => call.method === 'PUT'),
    ).toEqual([]);
    expect(result.logs).not.toContain('secret');
    expect(JSON.stringify(repo.state())).not.toContain('secret');
  },
);
test('expired Cargo upload tokens fail safely and a fresh-clone retry exchanges a new identity', async () => {
  const { repo, service, settings } = await setup();
  service.cargoTrusted({ expired: true });
  expect(repo.run(settings).ok).toBe(false);
  expect(service.state().uploads).toEqual([]);
  expect(service.state().cargoExchanges[0].revoked).toBe(true);
  service.cargoTrusted();
  const result = repo.run(settings, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toHaveLength(2);
  expect(service.state().uploads).toHaveLength(1);
});
test.each(['identity', 'exchange', 'upload', 'revoke'])(
  'Cargo %s redirects never forward credentials to another origin',
  async (stage) => {
    const { repo, service, settings } = await setup();
    const other = await registry();
    if (stage === 'identity')
      service.trusted({ redirectIdentity: `${other.url}/capture` });
    if (stage === 'exchange')
      service.cargoTrusted({ redirectExchange: `${other.url}/capture` });
    if (stage === 'upload') service.control(`redirect-put:${other.url}`);
    if (stage === 'revoke')
      service.cargoTrusted({ redirectRevoke: `${other.url}/capture` });
    const result = repo.run(settings);
    expect(result.ok).toBe(false);
    expect(other.state().requests).toEqual([]);
    if (stage !== 'revoke') expect(service.state().uploads).toEqual([]);
    expect(result.logs).not.toContain('secret');
  },
);
test('Cargo exchange rejects same-origin redirects before sending identity again', async () => {
  const { repo, service, settings } = await setup();
  service.cargoTrusted({ redirectExchange: `${service.url}/capture` });
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(
    service
      .state()
      .requests.some((call: { path: string }) => call.path === '/capture'),
  ).toBe(false);
});
const jwt = (aud?: string | string[]) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ aud, iss: 'https://gitlab.com', jti: 'gitlab-single-use' })).toString('base64url')}.fixture-signature`;
test('automatic Cargo OIDC rejects a crates.io identity before sending it to an alternate API', async () => {
  const { repo, service } = await setup();
  const result = repo.run({
    env: {
      ...service.env,
      GITLAB_CI: 'true',
      CI_COMMIT_BRANCH: 'main',
      CI_COMMIT_REF_NAME: 'main',
      CRATES_IO_ID_TOKEN: jwt('crates.io'),
    },
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  });
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(
    service
      .state()
      .requests.some((call: { path: string }) =>
        call.path.endsWith('/trusted_publishing/tokens'),
      ),
  ).toBe(false);
  expect(service.state().cargoExchanges ?? []).toEqual([]);
  expect(service.state().cargoRevocations ?? []).toEqual([]);
  expect(service.state().uploads).toEqual([]);
});
test.each([
  ['malformed JWT', 'not-a-jwt'],
  ['missing audience', jwt()],
])(
  'Cargo rejects a supplied identity with %s before exchange',
  async (_label, token) => {
    const { repo, service } = await setup();
    const result = repo.run({
      env: {
        ...service.env,
        GITLAB_CI: 'true',
        CI_COMMIT_BRANCH: 'main',
        CI_COMMIT_REF_NAME: 'main',
        CRATES_IO_ID_TOKEN: token,
      },
      pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
    });
    expect(result.codes).toContain('EWORKSPACEOIDC');
    expect(
      service
        .state()
        .requests.some((call: { path: string }) =>
          call.path.endsWith('/trusted_publishing/tokens'),
        ),
    ).toBe(false);
    expect(service.state().cargoRevocations ?? []).toEqual([]);
    expect(service.state().uploads).toEqual([]);
  },
);
test('automatic Cargo OIDC accepts a matching API audience within a supplied identity array', async () => {
  const { repo, service } = await setup();
  const result = repo.run({
    env: {
      ...service.env,
      GITLAB_CI: 'true',
      CI_COMMIT_BRANCH: 'main',
      CI_COMMIT_REF_NAME: 'main',
      CRATES_IO_ID_TOKEN: jwt([
        'crates.io',
        `${service.url.replace(/^https?:\/\//, '')}/cargo`,
      ]),
    },
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toHaveLength(1);
  expect(service.state().cargoExchanges[0].revoked).toBe(true);
  expect(service.state().uploads).toHaveLength(1);
});
test('GitLab Cargo OIDC exchanges a single-use CRATES_IO_ID_TOKEN once across dependent crates', async () => {
  const { repo, service, settings } = await setup(true);
  const result = repo.run({
    ...settings,
    env: {
      ...service.env,
      GITLAB_CI: 'true',
      CI_COMMIT_BRANCH: 'main',
      CI_COMMIT_REF_NAME: 'main',
      CRATES_IO_ID_TOKEN: jwt(
        `${service.url.replace(/^https?:\/\//, '')}/cargo`,
      ),
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toHaveLength(1);
  expect(service.state().cargoExchanges[0].revoked).toBe(true);
  expect(service.state().uploads).toHaveLength(2);
});
test('automatic Cargo auth selects OIDC when identity is available', async () => {
  const { repo, service, settings } = await setup();
  const result = repo.run({
    ...settings,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toHaveLength(1);
});
test('disabling Cargo OIDC preserves native credentials despite available CI identity', async () => {
  const { repo, service, settings } = await setup();
  rmSync(join(service.root, 'cargo-oidc.json'));
  const result = repo.run({
    ...settings,
    pluginConfig: {
      publish: true,
      cargo: { registry: 'fixture', trustedPublishing: false },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toBeUndefined();
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT')[0]
      .authorization,
  ).toBe('fixture-token');
});
test('older pending Cargo token batches retain native auth when retry CI gains OIDC', async () => {
  const { repo, service, settings } = await setup();
  rmSync(join(service.root, 'cargo-oidc.json'));
  const config = { publish: true, cargo: { registry: 'fixture' } };
  service.control('once-reject');
  expect(repo.run({ env: service.env, pluginConfig: config }).ok).toBe(false);
  const result = repo.run({ ...settings, pluginConfig: config }, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().cargoExchanges).toBeUndefined();
});
test('a changed Cargo API blocks pending retry before any new exchange', async () => {
  const { repo, service, settings } = await setup();
  const other = await registry();
  service.control('once-reject');
  expect(repo.run(settings).ok).toBe(false);
  service.cargoTrusted({ api: `${other.url}/cargo` });
  const result = repo.run(settings, repo.clone());
  expect(result.codes).toContain('EWORKSPACEPLAN');
  expect(other.state().requests).toEqual([]);
  expect(service.state().cargoExchanges).toHaveLength(1);
});
test('revocation failures preserve pending progress and can reconcile from a fresh clone without credentials', async () => {
  const { repo, service, settings } = await setup();
  service.cargoTrusted({ rejectRevoke: true });
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(repo.state().status).toBe('pending');
  expect(repo.state().execution.packages[0].published).toBe(true);
  expect(result.logs).not.toContain('cargo-secret');
  service.cargoTrusted();
  const recovered = repo.run({ ...settings, env: service.env }, repo.clone());
  expect(recovered.ok, recovered.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(1);
  expect(service.state().cargoExchanges).toHaveLength(1);
});
test('Cargo upload tokens are never used for registry reads', async () => {
  const { repo, service, settings } = await setup(true);
  expect(repo.run(settings).ok).toBe(true);
  const reads = service
    .state()
    .requests.filter(
      (call: { method: string; path: string }) =>
        call.method === 'GET' && !call.path.startsWith('/oidc'),
    );
  expect(reads.length).toBeGreaterThan(0);
  expect(
    reads.every(
      (call: { authorization?: string }) =>
        !call.authorization?.includes('cargo-secret'),
    ),
  ).toBe(true);
});
test('Cargo OIDC rejects unsupported providers and malformed policy in dry runs', async () => {
  const { repo, service, settings } = await setup();
  const unsupported = repo.run({
    ...settings,
    dryRun: true,
    env: { ...service.env, CIRCLECI: 'true', CIRCLE_BRANCH: 'main' },
  });
  expect(unsupported.codes).toContain('EWORKSPACEOIDC');
  const invalid = repo.run({
    ...settings,
    dryRun: true,
    pluginConfig: {
      publish: true,
      cargo: { registry: 'fixture', trustedPublishing: 'invalid' },
    },
  });
  expect(invalid.codes).toContain('EWORKSPACECONFIG');
  expect(service.state().requests).toEqual([]);
});

test('partial coordinated Cargo retries exchange anew only for remaining crates', async () => {
  const { repo, service, settings } = await setup(true);
  service.control('reject-second');
  expect(repo.run(settings).ok).toBe(false);
  expect(service.state().uploads).toEqual(['cargo:trusted-core@1.1.0']);
  expect(service.state().cargoExchanges[0].revoked).toBe(true);
  const retained = repo
    .state()
    .execution.packages.map((entry: { artifact: unknown }) => entry.artifact);
  service.control('');
  const result = repo.run(settings, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:trusted-core@1.1.0',
    'cargo:trusted-app@1.1.0',
  ]);
  expect(service.state().cargoExchanges).toHaveLength(2);
  expect(
    repo
      .state()
      .execution.packages.map((entry: { artifact: unknown }) => entry.artifact),
  ).toEqual(retained);
});
test('Cargo registry overrides bind identity audience, exchange and upload to the selected API', async () => {
  const { repo, service, settings } = await setup();
  const selected = await registry();
  selected.cargoTrusted();
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n[registries.selected]\nindex = "sparse+${selected.url}/cargo/index/"\n`,
  );
  const file = join(repo.cwd, 'crates/core/Cargo.toml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'publish = ["fixture"]',
      'publish = ["fixture", "selected"]',
    ),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: configure alternate registry');
  const result = repo.run({
    ...settings,
    pluginConfig: {
      publish: true,
      cargo: { registry: 'selected', trustedPublishing: true },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(selected.state().cargoExchanges).toHaveLength(1);
  expect(selected.state().uploads).toHaveLength(1);
  expect(service.state().cargoExchanges).toBeUndefined();
  expect(service.state().uploads).toEqual([]);
  const claims = JSON.parse(
    Buffer.from(
      selected.state().cargoExchanges[0].jwt.split('.')[1],
      'base64url',
    ).toString(),
  );
  expect(claims.aud).toBe(`${selected.url.replace(/^https?:\/\//, '')}/cargo`);
});
test('in-memory Cargo credentials stop being usable before their upstream expiry and are still revoked', async () => {
  const { service, settings } = await setup();
  const session = createCargoIdentity({ env: settings.env });
  const dest = {
    ecosystem: 'cargo' as const,
    registry: 'fixture',
    api: `${service.url}/cargo`,
    cargoAuth: 'oidc' as const,
  };
  try {
    await session.token(dest);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 26 * 60_000);
    await expect(session.token(dest)).rejects.toMatchObject({
      code: 'EWORKSPACEOIDC',
    });
  } finally {
    vi.restoreAllMocks();
    await session.close();
  }
  expect(service.state().cargoExchanges).toHaveLength(1);
  expect(service.state().cargoExchanges[0].revoked).toBe(true);
});
test('Cargo OIDC rejects insecure remote API discovery before requesting identity', async () => {
  const { repo, service, settings } = await setup();
  service.cargoTrusted({ api: 'http://example.invalid' });
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(
    service
      .state()
      .requests.every(
        (call: { path: string }) => !call.path.startsWith('/oidc'),
      ),
  ).toBe(true);
  expect(service.state().uploads).toEqual([]);
});
