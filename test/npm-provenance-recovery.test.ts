import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type Bundle, verify } from 'sigstore';
import { afterEach, expect, test, vi } from 'vitest';
import { archiveFile } from '../src/archive.js';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';
import { sigstore } from './fixtures/sigstore.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const repo = fixture();
  const service = await registry();
  const signing = await sigstore();
  const trace = join(service.root, 'native-pack.txt');
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  mkdirSync(join(repo.cwd, 'packages/core'), { recursive: true });
  const manifest = JSON.stringify({
    name: '@fixture/provenance-core',
    version: '1.0.0',
    repository: 'https://github.com/fixture/repo',
    scripts: {
      prepack:
        "node -e \"require('node:fs').appendFileSync(process.env.PACK_TRACE, 'pack\\n')\"",
    },
  });
  writeFileSync(join(repo.cwd, 'packages/core/package.json'), manifest);
  writeFileSync(
    join(repo.cwd, 'packages/core/index.js'),
    'exports.value = 42;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  const head = repo.commit('feat: add provenance recovery fixture');
  service.trusted({ head });
  const settings = {
    env: {
      ...service.env,
      PACK_TRACE: trace,
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
        provenance: true,
        sigstore: signing.config,
      },
    },
  };
  const packs = () => (existsSync(trace) ? readFileSync(trace, 'utf8') : '');
  const setBundle = (bundle: Bundle) => {
    const state = service.state();
    state.npm['@fixture/provenance-core']['1.1.0'].bundle = bundle;
    writeFileSync(join(service.root, 'registry.json'), JSON.stringify(state));
  };
  return { repo, service, signing, settings, packs, setBundle, manifest };
}

function withRegistryDefaults(bundle: Bundle): Bundle {
  const result = structuredClone(bundle);
  for (const signature of result.dsseEnvelope?.signatures ?? [])
    signature.keyid = '';
  assert(result.verificationMaterial.timestampVerificationData);
  result.verificationMaterial.timestampVerificationData.rfc3161Timestamps = [];
  return result;
}

test('real semantic-release recovers an acknowledged hidden OIDC upload without credentials, packing or signing again', async () => {
  const { repo, service, signing, settings, packs } = await setup();
  const timed = {
    ...settings,
    pluginConfig: {
      ...settings.pluginConfig,
      npm: { ...settings.pluginConfig.npm, visibilityTimeout: 0 },
    },
  };
  service.control('hide-npm');
  const initial = repo.run(timed);
  expect(initial.ok).toBe(false);
  expect(initial.codes).toContain('EWORKSPACEPUBLISH');
  const pending = repo.state();
  expect(pending.status).toBe('pending');
  expect(pending.execution.packages[0]).toMatchObject({
    intent: true,
    acknowledged: true,
    published: false,
    tagged: false,
  });
  const artifact = pending.execution.packages[0].artifact;
  const published = service.state().npm['@fixture/provenance-core']['1.1.0'];
  const signingCalls = signing
    .events()
    .filter((path) => path.startsWith('/api/'));
  expect(signingCalls.length).toBeGreaterThan(0);
  expect(service.state().exchanges).toHaveLength(1);
  expect(packs()).toBe('pack\n');

  const withoutCI = {
    ...timed,
    env: { ...service.env, PACK_TRACE: settings.env.PACK_TRACE },
  };
  const hidden = repo.run(withoutCI, repo.clone('main', 'hidden-retry'));
  expect(hidden.ok).toBe(false);
  expect(hidden.codes).toContain('EWORKSPACEPUBLISH');
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(service.state().uploads).toEqual([
    'npm:@fixture/provenance-core@1.1.0',
  ]);
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT'),
  ).toHaveLength(1);
  expect(service.state().exchanges).toHaveLength(1);
  expect(signing.events().filter((path) => path.startsWith('/api/'))).toEqual(
    signingCalls,
  );
  expect(packs()).toBe('pack\n');

  service.control('');
  const recovered = repo.run(withoutCI, repo.clone('main', 'visible-retry'));
  expect(recovered.ok, recovered.logs).toBe(true);
  expect(repo.state().status).toBe('complete');
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(service.state().npm['@fixture/provenance-core']['1.1.0']).toEqual(
    published,
  );
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT'),
  ).toHaveLength(1);
  expect(service.state().exchanges).toHaveLength(1);
  expect(signing.events().filter((path) => path.startsWith('/api/'))).toEqual(
    signingCalls,
  );
  expect(packs()).toBe('pack\n');
  expect(repo.tags()).toContain('npm/@fixture/provenance-core@1.1.0');
});

test('real semantic-release recovers an accepted npm OIDC upload with registry ProtoJSON defaults without repacking or resigning', async () => {
  const { repo, service, signing, settings, packs, setBundle, manifest } =
    await setup();
  const initialRefs = repo.refs();
  const preview = repo.run({ ...settings, dryRun: true });
  expect(preview.ok, preview.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(signing.events()).toEqual([]);
  expect(packs()).toBe('');
  expect(repo.refs()).toBe(initialRefs);

  service.control('once-drop-unreadable');
  const interrupted = repo.run(settings);
  expect(interrupted.ok).toBe(false);
  const pending = repo.state();
  expect(pending.status).toBe('pending');
  const artifact = pending.execution.packages[0].artifact;
  const published = service.state().npm['@fixture/provenance-core']['1.1.0'];
  const original: Bundle = published.bundle;
  const normalized = withRegistryDefaults(original);
  const verification = {
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    tufMirrorURL: settings.pluginConfig.npm.sigstore.tufMirrorURL,
    tufRootPath: settings.pluginConfig.npm.sigstore.tufRootPath,
    tufCachePath: join(service.root, 'verify-cache'),
  };
  await verify(original, verification);
  await verify(normalized, verification);
  const bytes = Buffer.from(published.artifact, 'base64');
  expect(await archiveFile(bytes, 'package/index.js')).toBe(
    'exports.value = 42;\n',
  );
  expect(packs()).toBe('pack\n');
  const signingCalls = signing
    .events()
    .filter((path) => path.startsWith('/api/'));

  setBundle(normalized);
  service.control('');
  const retry = repo.clone();
  const recovered = repo.run(
    {
      ...settings,
      env: { ...service.env, PACK_TRACE: settings.env.PACK_TRACE },
    },
    retry,
  );
  expect(recovered.ok, recovered.logs).toBe(true);
  expect(repo.state().status).toBe('complete');
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(repo.tags()).toContain('npm/@fixture/provenance-core@1.1.0');
  expect(service.state().uploads).toEqual([
    'npm:@fixture/provenance-core@1.1.0',
  ]);
  expect(
    service
      .state()
      .requests.filter((call: { method: string }) => call.method === 'PUT'),
  ).toHaveLength(1);
  expect(service.state().exchanges).toHaveLength(1);
  expect(signing.events().filter((path) => path.startsWith('/api/'))).toEqual(
    signingCalls,
  );
  expect(packs()).toBe('pack\n');
  expect(
    service.state().npm['@fixture/provenance-core']['1.1.0'].artifact,
  ).toBe(published.artifact);
  expect(
    service.state().npm['@fixture/provenance-core']['1.1.0'].bundle,
  ).toEqual(normalized);
  expect(
    JSON.parse(
      repo.git(repo.remote, 'show', `${artifact.commit}:metadata.json`),
    ).provenance.bundle,
  ).toEqual(original);
  expect(
    readFileSync(join(repo.cwd, 'packages/core/package.json'), 'utf8'),
  ).toBe(manifest);
  expect(readFileSync(join(retry, 'packages/core/package.json'), 'utf8')).toBe(
    manifest,
  );

  const requests = service.state().requests;
  const events = signing.events();
  const refs = repo.refs();
  const noChange = repo.run(settings, repo.clone('main', 'no-change'));
  expect(noChange.ok, noChange.logs).toBe(true);
  expect(noChange.result).toBe(false);
  expect(service.state().requests).toEqual(requests);
  expect(signing.events()).toEqual(events);
  expect(packs()).toBe('pack\n');
  expect(repo.refs()).toBe(refs);
});

test('real semantic-release rejects changed cryptographic proofs and nonempty registry fields without accepting a duplicate upload', async () => {
  const { repo, service, signing, settings, packs, setBundle } = await setup();
  service.control('once-drop-unreadable');
  expect(repo.run(settings).ok).toBe(false);
  const artifact = repo.state().execution.packages[0].artifact;
  const original: Bundle =
    service.state().npm['@fixture/provenance-core']['1.1.0'].bundle;
  const signingCalls = signing
    .events()
    .filter((path) => path.startsWith('/api/'));
  const refs = repo.refs();
  service.control('');
  const variants: [string, (bundle: Bundle) => void][] = [
    [
      'payload',
      (bundle) => {
        assert(bundle.dsseEnvelope);
        bundle.dsseEnvelope.payload = 'e30=';
      },
    ],
    [
      'signature',
      (bundle) => {
        const signature = bundle.dsseEnvelope?.signatures[0];
        assert(signature);
        signature.sig = 'AAAA';
      },
    ],
    [
      'certificate',
      (bundle) => {
        assert(bundle.verificationMaterial.certificate);
        bundle.verificationMaterial.certificate.rawBytes = 'AAAA';
      },
    ],
    [
      'log',
      (bundle) => {
        const log = bundle.verificationMaterial.tlogEntries[0];
        assert(log);
        log.canonicalizedBody = 'AAAA';
      },
    ],
    [
      'nonempty keyid',
      (bundle) => {
        const signature = bundle.dsseEnvelope?.signatures[0];
        assert(signature);
        signature.keyid = 'different-key';
      },
    ],
    [
      'nonempty timestamps',
      (bundle) => {
        bundle.verificationMaterial.timestampVerificationData = {
          rfc3161Timestamps: [{ signedTimestamp: 'AAAA' }],
        };
      },
    ],
    [
      'unknown empty field',
      (bundle) => {
        assert(bundle.verificationMaterial.timestampVerificationData);
        Object.assign(bundle.verificationMaterial.timestampVerificationData, {
          unknown: [],
        });
      },
    ],
    [
      'missing timestamp message',
      (bundle) => {
        Reflect.deleteProperty(
          bundle.verificationMaterial,
          'timestampVerificationData',
        );
      },
    ],
    [
      'null keyid',
      (bundle) => {
        const signature = bundle.dsseEnvelope?.signatures[0];
        assert(signature);
        Object.assign(signature, { keyid: null });
      },
    ],
    [
      'null timestamps',
      (bundle) => {
        assert(bundle.verificationMaterial.timestampVerificationData);
        Object.assign(bundle.verificationMaterial.timestampVerificationData, {
          rfc3161Timestamps: null,
        });
      },
    ],
    [
      'null timestamp message',
      (bundle) => {
        Object.assign(bundle.verificationMaterial, {
          timestampVerificationData: null,
        });
      },
    ],
  ];
  for (const [index, [label, mutate]] of variants.entries()) {
    const changed = withRegistryDefaults(original);
    mutate(changed);
    setBundle(changed);
    const result = repo.run(settings, repo.clone('main', `tampered-${index}`));
    expect(result.ok, `${label}: ${result.logs}`).toBe(false);
    expect(result.codes, label).toContain('EWORKSPACEPUBLISH');
    expect(repo.state().status, label).toBe('pending');
    expect(repo.state().execution.packages[0].artifact, label).toEqual(
      artifact,
    );
    expect(repo.refs(), label).toBe(refs);
    expect(service.state().uploads, label).toEqual([
      'npm:@fixture/provenance-core@1.1.0',
    ]);
    expect(
      service
        .state()
        .requests.filter((call: { method: string }) => call.method === 'PUT'),
      label,
    ).toHaveLength(1);
    expect(service.state().exchanges, label).toHaveLength(1);
    expect(
      signing.events().filter((path) => path.startsWith('/api/')),
      label,
    ).toEqual(signingCalls);
    expect(packs(), label).toBe('pack\n');
  }
});
