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
async function setup(names = ['trusted-fixture']) {
  const repo = fixture();
  const service = await registry();
  service.trusted();
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
  }
  repo.git(repo.cwd, 'add', '.');
  const head = repo.commit('feat: add packages');
  service.trusted({ head });
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
    GITHUB_SHA: head,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY_VISIBILITY: 'public',
    ACTIONS_ID_TOKEN_REQUEST_URL: `${service.url}/oidc`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ci-request-secret',
  };
  const settings = {
    env,
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
test('OIDC exchanges credentials separately for each package using real semantic-release', async () => {
  const { repo, service, settings } = await setup([
    '@fixture/one',
    '@fixture/two',
  ]);
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(
    service.state().exchanges.map((entry: { name: string }) => entry.name),
  ).toEqual(['@fixture/one', '@fixture/two']);
  expect(service.state().uploads).toEqual([
    'npm:@fixture/one@1.1.0',
    'npm:@fixture/two@1.1.0',
  ]);
  expect(JSON.stringify(repo.state())).not.toContain('secret');
  expect(repo.refs()).not.toContain('secret');
  expect(result.logs).not.toContain('secret');
  const calls = service.state().requests;
  expect(
    calls
      .filter((call: { path: string }) => call.path.startsWith('/oidc'))
      .every(
        (call: { path: string }) =>
          new URL(call.path, service.url).searchParams.get('audience') ===
          'npm:127.0.0.1',
      ),
  ).toBe(true);
});
test('OIDC dry runs never request identity, exchange tokens or mutate source/remote state', async () => {
  const { repo, service, settings } = await setup();
  const refs = repo.refs();
  const before = readFileSync(
    join(repo.cwd, 'packages/0/package.json'),
    'utf8',
  );
  const result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(refs);
  expect(readFileSync(join(repo.cwd, 'packages/0/package.json'), 'utf8')).toBe(
    before,
  );
});
test('required OIDC fails closed without silently falling back to configured npm credentials', async () => {
  const { repo, service, settings } = await setup();
  service.trusted({ rejectExchange: true });
  const result = repo.run(settings);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(service.state().uploads).toEqual([]);
  expect(result.logs).not.toContain('ci-request-secret');
});

test('publishes a cryptographically verified provenance bundle using real semantic-release', async () => {
  const { repo, service, settings } = await setup();
  const signing = await sigstore();
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
  expect(result.ok, result.logs).toBe(true);
  expect(signing.events()).toContain('/api/v2/signingCert');
  expect(signing.events()).toContain('/api/v1/log/entries');
  const entry = service.state().npm['trusted-fixture']['1.1.0'];
  expect(entry.bundle.dsseEnvelope.payloadType).toBe(
    'application/vnd.in-toto+json',
  );
  const payload = JSON.parse(
    Buffer.from(entry.bundle.dsseEnvelope.payload, 'base64').toString(),
  );
  expect(payload.subject[0].name).toBe('pkg:npm/trusted-fixture@1.1.0');
  expect(
    payload.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit,
  ).toBe(settings.env.GITHUB_SHA);
  expect(repo.state().status).toBe('complete');
});

async function signedSetup() {
  const fixture = await setup(['@fixture/trusted']);
  const signing = await sigstore();
  const settings = {
    ...fixture.settings,
    pluginConfig: {
      ...fixture.settings.pluginConfig,
      npm: {
        ...fixture.settings.pluginConfig.npm,
        provenance: true,
        sigstore: signing.config,
      },
    },
  };
  return { ...fixture, settings, signing };
}
const signingCalls = (service: Awaited<ReturnType<typeof sigstore>>) =>
  service.events().filter((path) => path.startsWith('/api/'));

test('signed dry runs validate configuration without identity, signing or durable effects', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  const refs = repo.refs();
  const result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(signing.events()).toEqual([]);
  expect(repo.refs()).toBe(refs);
});
test('completed OIDC releases have no-change reruns without registry or signing calls', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  expect(repo.run(settings).ok).toBe(true);
  const before = service.state().requests;
  const events = signing.events();
  const refs = repo.refs();
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(result.result).toBe(false);
  expect(service.state().requests).toEqual(before);
  expect(signing.events()).toEqual(events);
  expect(repo.refs()).toBe(refs);
});
test('fresh clone confirms an uncertain accepted upload with exact retained provenance and no CI credentials', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  service.control('once-drop-unreadable');
  const failed = repo.run(settings);
  expect(failed.ok).toBe(false);
  expect(repo.state().status).toBe('pending');
  const artifact = repo.state().execution.packages[0].artifact;
  const bundle = service.state().npm['@fixture/trusted']['1.1.0'].bundle;
  const calls = signingCalls(signing);
  service.control('');
  const result = repo.run(
    { ...settings, env: { ...service.env } },
    repo.clone(),
  );
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual(['npm:@fixture/trusted@1.1.0']);
  expect(service.state().exchanges).toHaveLength(1);
  expect(signingCalls(signing)).toEqual(calls);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(service.state().npm['@fixture/trusted']['1.1.0'].bundle).toEqual(
    bundle,
  );
  const retained = repo.git(
    repo.remote,
    'show',
    `${artifact.commit}:metadata.json`,
  );
  expect(retained).not.toContain('ci-request-secret');
  expect(retained).not.toContain('exchange-secret');
});
test('fresh clone obtains a fresh upload token after rejection while reusing its signed artifact', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  service.control('once-reject');
  expect(repo.run(settings).ok).toBe(false);
  const artifact = repo.state().execution.packages[0].artifact;
  const calls = signingCalls(signing);
  const result = repo.run(settings, repo.clone());
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().exchanges).toHaveLength(2);
  expect(service.state().exchanges[0].token).not.toBe(
    service.state().exchanges[1].token,
  );
  expect(service.state().uploads).toHaveLength(1);
  expect(signingCalls(signing)).toEqual(calls);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
});
test.each(['attestation-missing', 'attestation-corrupt', 'attestation-404'])(
  'retry refuses %s registry proof without republishing',
  async (control) => {
    const { repo, service, settings, signing } = await signedSetup();
    service.control('once-drop-unreadable');
    expect(repo.run(settings).ok).toBe(false);
    const calls = signingCalls(signing);
    service.control(control);
    const result = repo.run(settings, repo.clone());
    expect(result.ok).toBe(false);
    expect(repo.state().status).toBe('pending');
    expect(service.state().uploads).toHaveLength(1);
    expect(service.state().exchanges).toHaveLength(1);
    expect(signingCalls(signing)).toEqual(calls);
    expect(repo.tags()).not.toContain('npm/@fixture/trusted@1.1.0');
  },
);
test('expired exchange credentials are rejected and a fresh-clone retry mints a new token', async () => {
  const { repo, service, settings } = await setup();
  service.trusted({ expired: true });
  const first = repo.run(settings);
  expect(first.codes).toContain('EWORKSPACEOIDC');
  expect(service.state().uploads).toHaveLength(0);
  service.trusted();
  const second = repo.run(settings, repo.clone());
  expect(second.ok, second.logs).toBe(true);
  expect(service.state().exchanges).toHaveLength(2);
});
test.each(['redirectIdentity', 'redirectExchange'])(
  '%s never forwards CI credentials to another origin',
  async (mode) => {
    const { repo, service, settings } = await setup();
    const other = await registry();
    service.trusted({ [mode]: `${other.url}/capture` });
    const result = repo.run(settings);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain('EWORKSPACEOIDC');
    expect(other.state().requests).toEqual([]);
    expect(result.logs).not.toContain('ci-request-secret');
  },
);
test('Sigstore redirects never forward the signing identity', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  const other = await registry();
  signing.control(`redirect:${other.url}/capture`);
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEPROVENANCE');
  expect(other.state().requests).toEqual([]);
  expect(service.state().uploads).toEqual([]);
  expect(repo.state().execution.packages[0].intent).toBe(false);
});
test('attestation redirects never forward registry credentials', async () => {
  const { repo, service, settings } = await signedSetup();
  const other = await registry();
  service.control('once-drop-unreadable');
  expect(repo.run(settings).ok).toBe(false);
  service.control(`attestation-redirect:${other.url}/capture`);
  const result = repo.run(settings, repo.clone());
  expect(result.ok).toBe(false);
  expect(other.state().requests).toEqual([]);
  expect(service.state().exchanges).toHaveLength(1);
});
test('explicit provenance rejects a wrong CI source even in a dry run', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  const result = repo.run({
    ...settings,
    dryRun: true,
    env: { ...settings.env, GITHUB_SHA: '0'.repeat(40) },
  });
  expect(result.codes).toContain('EWORKSPACEPROVENANCE');
  expect(service.state().requests).toEqual([]);
  expect(signing.events()).toEqual([]);
});

test('same-origin identity-exchange redirects are rejected before forwarding the token', async () => {
  const { repo, service, settings } = await setup();
  service.trusted({ redirectExchange: `${service.url}/capture` });
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(
    service
      .state()
      .requests.some((call: { path: string }) => call.path === '/capture'),
  ).toBe(false);
});
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture-signature`;
test('GitLab publishes npm OIDC plus signed provenance with real semantic-release', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  const claims = {
    iss: 'https://gitlab.com',
    sub: 'project_path:fixture/repo:ref_type:branch:ref:main',
    aud: 'sigstore',
    sha: settings.env.GITHUB_SHA,
    repository: 'fixture/repo',
    project_visibility: 'public',
    workflow_identity:
      'https://gitlab.com/fixture/repo//.gitlab-ci.yml@refs/heads/main',
  };
  const env = {
    ...service.env,
    GITLAB_CI: 'true',
    CI_COMMIT_BRANCH: 'main',
    CI_COMMIT_REF_NAME: 'main',
    NPM_ID_TOKEN: jwt({ ...claims, aud: 'npm:127.0.0.1' }),
    SIGSTORE_ID_TOKEN: jwt(claims),
    CI_COMMIT_SHA: settings.env.GITHUB_SHA,
    CI_PROJECT_URL: 'https://gitlab.com/fixture/repo',
    CI_SERVER_URL: 'https://gitlab.com',
    CI_PROJECT_VISIBILITY: 'public',
    CI_JOB_URL: 'https://gitlab.com/fixture/repo/-/jobs/42',
    CI_JOB_NAME: 'release',
    CI_RUNNER_ID: '123',
    UNRELATED_SECRET: 'must-never-enter-provenance',
  };
  const result = repo.run({ ...settings, env });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().exchanges).toHaveLength(1);
  expect(signingCalls(signing)).toHaveLength(2);
  const bundle = service.state().npm['@fixture/trusted']['1.1.0'].bundle;
  const payload = JSON.parse(
    Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString(),
  );
  expect(payload.predicateType).toBe('https://slsa.dev/provenance/v0.2');
  expect(payload.predicate.materials[0].digest.sha1).toBe(env.CI_COMMIT_SHA);
  expect(JSON.stringify(bundle)).not.toContain('must-never-enter-provenance');
});
test('CircleCI supports OIDC with automatic provenance skipped, and rejects required provenance', async () => {
  const { repo, service, settings } = await setup();
  const env = {
    ...service.env,
    CIRCLECI: 'true',
    CIRCLE_BRANCH: 'main',
    NPM_ID_TOKEN: jwt({
      iss: 'https://oidc.circleci.com/org/fixture',
      aud: 'npm:127.0.0.1',
    }),
  };
  const npm = { ...settings.pluginConfig.npm, provenance: 'auto' };
  const required = repo.run({
    ...settings,
    dryRun: true,
    env,
    pluginConfig: { publish: true, npm: { ...npm, provenance: true } },
  });
  expect(required.codes).toContain('EWORKSPACEPROVENANCE');
  expect(service.state().requests).toEqual([]);
  const result = repo.run({
    ...settings,
    env,
    pluginConfig: { publish: true, npm },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(1);
  expect(
    service.state().npm['trusted-fixture']['1.1.0'].bundle,
  ).toBeUndefined();
});
test('auto provenance skips private GitLab projects without requesting a signing token', async () => {
  const { repo, service, settings } = await setup();
  const result = repo.run({
    ...settings,
    env: {
      ...service.env,
      GITLAB_CI: 'true',
      CI_COMMIT_BRANCH: 'main',
      CI_COMMIT_REF_NAME: 'main',
      CI_PROJECT_VISIBILITY: 'private',
      NPM_ID_TOKEN: jwt({ aud: 'npm:127.0.0.1' }),
    },
    pluginConfig: {
      publish: true,
      npm: { ...settings.pluginConfig.npm, provenance: 'auto' },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().exchanges).toHaveLength(1);
});
test('OIDC uses the effective registry override for exchange and upload', async () => {
  const { repo, service, settings } = await setup();
  const other = await registry();
  other.trusted();
  const result = repo.run({
    ...settings,
    pluginConfig: {
      publish: true,
      npm: { ...settings.pluginConfig.npm, registry: other.url },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(other.state().exchanges).toHaveLength(1);
  expect(other.state().uploads).toHaveLength(1);
  expect(service.state().exchanges).toBeUndefined();
  expect(
    service
      .state()
      .requests.every((call: { path: string }) =>
        call.path.startsWith('/oidc'),
      ),
  ).toBe(true);
});
test('existing public scoped packages can sign with access left unchanged', async () => {
  const { repo, service, settings } = await signedSetup();
  service.trusted({ head: settings.env.GITHUB_SHA, publicPackage: true });
  const result = repo.run({
    ...settings,
    pluginConfig: {
      ...settings.pluginConfig,
      npm: { ...settings.pluginConfig.npm, access: null },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().npm['@fixture/trusted']['1.1.0'].bundle).toBeDefined();
  expect(service.state().npm['@fixture/trusted']['1.1.0'].access).toBeNull();
});
test('pending token batches retain their authentication mode when retry CI gains OIDC', async () => {
  const { repo, service, settings } = await setup();
  rmSync(join(service.root, 'oidc.json'));
  const npm = {
    ...settings.pluginConfig.npm,
    trustedPublishing: 'auto',
    provenance: 'auto',
  };
  service.control('once-reject');
  expect(
    repo.run({ env: service.env, pluginConfig: { publish: true, npm } }).ok,
  ).toBe(false);
  const result = repo.run(
    { ...settings, pluginConfig: { publish: true, npm } },
    repo.clone(),
  );
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().exchanges).toBeUndefined();
});
test('a source-mismatched signing certificate is rejected before upload intent', async () => {
  const { repo, service, settings } = await signedSetup();
  service.trusted({ head: '0'.repeat(40) });
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEPROVENANCE');
  expect(service.state().uploads).toEqual([]);
  expect(repo.state().execution.packages[0].artifact).toBeUndefined();
  expect(repo.state().execution.packages[0].intent).toBe(false);
});

test('required OIDC detects unavailable CI identity during dry-run preflight', async () => {
  const { repo, service, settings } = await setup();
  const refs = repo.refs();
  const result = repo.run({ ...settings, dryRun: true, env: service.env });
  expect(result.codes).toContain('EWORKSPACEOIDC');
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(refs);
});
test('invalid transparency-log signatures are rejected before artifact retention or upload', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  signing.control('bad-log');
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEPROVENANCE');
  expect(service.state().uploads).toEqual([]);
  expect(repo.state().execution.packages[0].artifact).toBeUndefined();
});
test('pending batches reject a changed pinned Sigstore root before any new exchange', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  service.control('once-reject');
  expect(repo.run(settings).ok).toBe(false);
  const calls = signingCalls(signing);
  writeFileSync(signing.config.tufRootPath, '{}');
  const result = repo.run(settings, repo.clone());
  expect(result.codes).toContain('EWORKSPACEPLAN');
  expect(service.state().exchanges).toHaveLength(1);
  expect(signingCalls(signing)).toEqual(calls);
});

test('default automatic OIDC and provenance sign a public GitHub release', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  const result = repo.run({
    ...settings,
    pluginConfig: {
      publish: true,
      npm: {
        registry: service.url,
        access: 'public',
        sigstore: signing.config,
      },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().exchanges).toHaveLength(1);
  expect(signingCalls(signing)).toHaveLength(2);
  expect(repo.state().execution.packages[0].destination.provenance).toBe(
    'auto',
  );
});
test('native npm provenance=false disables automatic signing without disabling OIDC', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  const npmrc = service.env.npm_config_userconfig;
  writeFileSync(npmrc, `${readFileSync(npmrc, 'utf8')}provenance=false\n`);
  const result = repo.run({
    ...settings,
    pluginConfig: {
      publish: true,
      npm: {
        registry: service.url,
        access: 'public',
        sigstore: signing.config,
      },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().exchanges).toHaveLength(1);
  expect(signing.events()).toEqual([]);
  expect(
    service.state().npm['@fixture/trusted']['1.1.0'].bundle,
  ).toBeUndefined();
});
test('explicit GitLab provenance validates signing-token availability during dry runs', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  const result = repo.run({
    ...settings,
    dryRun: true,
    env: {
      ...service.env,
      GITLAB_CI: 'true',
      CI_COMMIT_BRANCH: 'main',
      CI_COMMIT_REF_NAME: 'main',
      NPM_ID_TOKEN: jwt({ aud: 'npm:127.0.0.1' }),
      CI_COMMIT_SHA: settings.env.GITHUB_SHA,
      CI_PROJECT_URL: 'https://gitlab.com/fixture/repo',
      CI_JOB_URL: 'https://gitlab.com/fixture/repo/-/jobs/42',
      CI_JOB_NAME: 'release',
      CI_RUNNER_ID: '123',
    },
  });
  expect(result.codes).toContain('EWORKSPACEPROVENANCE');
  expect(service.state().requests).toEqual([]);
  expect(signing.events()).toEqual([]);
});

test('private identity claims cannot be overridden by public CI environment metadata', async () => {
  const { repo, service, settings, signing } = await signedSetup();
  service.trusted({
    head: settings.env.GITHUB_SHA,
    claims: { repository_visibility: 'private' },
  });
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEPROVENANCE');
  expect(signing.events()).toEqual([]);
  expect(service.state().uploads).toEqual([]);
});
