import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
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

type SourceLocation =
  | 'home'
  | 'local'
  | 'none'
  | 'direct-local'
  | 'candidate-local'
  | 'chained-local'
  | 'candidate-chain-local'
  | 'split-local';

async function setup(
  previousRegistry = false,
  customIndex = false,
  sourceLocation: SourceLocation = 'home',
  crossRegistry = false,
) {
  const repo = fixture();
  const service = await registry();
  const selected = crossRegistry ? await registry() : service;
  mkdirSync(service.env.CARGO_HOME, { recursive: true });
  const sourceConfig = `[source.crates-io]\nreplace-with = "fixture-source"\n[source.fixture-source]\nregistry = "sparse+${service.url}/cargo/index/"\n`;
  const directSourceConfig = `[source.crates-io]\nregistry = "sparse+${service.url}/cargo/index/"\n`;
  const candidateSourceConfig = `[source.fixture-source]\nregistry = "sparse+${service.url}/cargo/index/"\n`;
  const splitLocalSourceConfig = `[source.crates-io]\nreplace-with = "fixture-source"\n`;
  const splitGlobalSourceConfig = `[source.fixture-source]\nregistry = "sparse+${selected.url}/cargo/index/"\n`;
  const chainedSourceConfig = `[source.crates-io]\nreplace-with = "fixture-source"\n[source.fixture-source]\nregistry = "sparse+${service.url}/cargo/index/"\nreplace-with = "redirected-source"\n[source.redirected-source]\nregistry = "sparse+${service.url}/cargo/redirected/"\n`;
  const candidateChainSourceConfig = `[source.fixture-source]\nregistry = "sparse+${service.url}/cargo/index/"\nreplace-with = "redirected-source"\n[source.redirected-source]\nregistry = "sparse+${service.url}/cargo/redirected/"\n`;
  const localSourceConfig =
    sourceLocation === 'local'
      ? sourceConfig
      : sourceLocation === 'direct-local'
        ? directSourceConfig
        : sourceLocation === 'candidate-local'
          ? candidateSourceConfig
          : sourceLocation === 'chained-local'
            ? chainedSourceConfig
            : sourceLocation === 'candidate-chain-local'
              ? candidateChainSourceConfig
              : sourceLocation === 'split-local'
                ? splitLocalSourceConfig
                : undefined;
  const namedRegistry = crossRegistry
    ? `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`
    : '';
  const cargoConfig = `${sourceLocation === 'home' ? sourceConfig : ''}${sourceLocation === 'split-local' ? splitGlobalSourceConfig : ''}${previousRegistry ? `[registries.previous]\nindex = "sparse+${service.url}/cargo/index/"\n` : ''}${customIndex ? `[registries.crates-io]\nindex = "sparse+${selected.url}/cargo/index/"\n` : ''}`;
  // Ordinary cases leave [registries.crates-io] undefined. The custom-index
  // case defines it explicitly and verifies that the archive retains its index.
  writeFileSync(join(service.env.CARGO_HOME, 'config.toml'), cargoConfig);
  const files: Record<string, string> = {
    '.gitignore': 'Cargo.lock\ntarget/\n',
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
    'crates/core/Cargo.toml':
      '[package]\nname = "default-registry-core"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Default registry fixture"\n',
    'crates/core/src/lib.rs': 'pub fn value() -> u32 { 42 }\n',
    'crates/adapter/Cargo.toml': `[package]\nname = "default-registry-adapter"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Default registry fixture"\n${crossRegistry ? 'publish = ["fixture"]\n' : ''}\n[dependencies]\nrenamed = { package = "default-registry-core", path = "../core", version = "=1.0.0"${previousRegistry ? ', registry = "previous"' : ''} }\n`,
    'crates/adapter/src/lib.rs': 'pub fn value() -> u32 { renamed::value() }\n',
    ...(localSourceConfig || namedRegistry
      ? { '.cargo/config.toml': `${localSourceConfig ?? ''}${namedRegistry}` }
      : {}),
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(repo.cwd, file, '..'), { recursive: true });
    writeFileSync(join(repo.cwd, file), contents);
  }
  const env = {
    ...repo.env,
    ...service.env,
    CARGO_REGISTRY_TOKEN: 'fixture-token',
  };
  const native = spawnSync('cargo', ['test', '--workspace', '--offline'], {
    cwd: repo.cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(native.status, `${native.stdout}\n${native.stderr}`).toBe(0);
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add default registry crates');

  // Route built-in index HTTP transport locally without changing registry
  // selection; native Cargo uses its own source replacement.
  const transport = join(service.root, 'default-index-transport.mjs');
  writeFileSync(
    transport,
    `const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === 'https://index.crates.io')
    return nativeFetch(${JSON.stringify(`${service.url}/cargo/index`)} + url.pathname + url.search, init);
  if (url.origin !== ${JSON.stringify(service.url)} && url.origin !== ${JSON.stringify(selected.url)})
    throw new Error('Unexpected external request in Cargo fixture: ' + url.origin);
  return nativeFetch(input, init);
};\n`,
  );
  const runner = fileURLToPath(
    new URL('./fixtures/run-release.mjs', import.meta.url),
  );
  const plugin = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
  const run = (
    settings: { dryRun?: boolean } = {},
    directory = repo.cwd,
    runtimeEnv = env,
  ) => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        transport,
        runner,
        directory,
        repo.remote,
        plugin,
        JSON.stringify({
          ...settings,
          env: service.env,
          pluginConfig: {
            publish: true,
            cargo: { trustedPublishing: false },
          },
        }),
      ],
      { cwd: directory, env: runtimeEnv, encoding: 'utf8', timeout: 120_000 },
    );
    const result = stdout
      .split('\n')
      .find((line) => line.startsWith('RESULT:'));
    if (!result) throw new Error(stdout);
    return JSON.parse(result.slice('RESULT:'.length));
  };
  const unchanged = (directory = repo.cwd) => {
    for (const [file, contents] of Object.entries(files))
      expect(readFileSync(join(directory, file), 'utf8'), file).toBe(contents);
    expect(repo.git(directory, 'status', '--porcelain')).toBe('');
    expect(
      readFileSync(join(service.env.CARGO_HOME, 'config.toml'), 'utf8'),
    ).toBe(cargoConfig);
  };
  const runWithEmptyPackageHome = () => {
    const emptyHome = join(service.root, 'empty-cargo-home');
    const bin = join(service.root, 'bin');
    const trace = join(service.root, 'cargo-package.log');
    const cargo = execFileSync('which', ['cargo'], {
      encoding: 'utf8',
    }).trim();
    const shell = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    mkdirSync(emptyHome);
    mkdirSync(bin);
    const wrapper = join(bin, 'cargo');
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ "$1" = package ]; then
  env -u CARGO_REGISTRY_TOKEN -u CARGO_REGISTRIES_CRATES_IO_TOKEN -u CARGO_REGISTRIES_CRATES_IO_INDEX -u CARGO_REGISTRIES_FIXTURE_TOKEN CARGO_HOME=${shell(emptyHome)} ${shell(cargo)} "$@" >${shell(trace)} 2>&1
  status=$?
  if [ "$status" -ne 0 ]; then cat ${shell(trace)} >&2; fi
  exit "$status"
fi
exec ${shell(cargo)} "$@"
`,
    );
    chmodSync(wrapper, 0o755);
    return {
      emptyHome,
      trace,
      released: run({}, repo.cwd, {
        ...repo.env,
        ...service.env,
        CARGO_REGISTRY_TOKEN: 'fixture-token',
        PATH: `${bin}:${repo.env.PATH}`,
      }),
    };
  };
  return {
    repo,
    service,
    selected,
    run,
    runWithEmptyPackageHome,
    unchanged,
    files,
  };
}

async function dependencyManifest(
  service: Awaited<ReturnType<typeof registry>>,
  version = '1.1.0',
) {
  const response = await fetch(
    `${service.url}/cargo/api/v1/crates/default-registry-adapter/${version}/download`,
  );
  expect(response.status).toBe(200);
  return parse(
    await archiveFile(
      Buffer.from(await response.arrayBuffer()),
      `default-registry-adapter-${version}/Cargo.toml`,
    ),
  );
}

test.each([false, true])(
  'Cargo packages built-in default dependencies without a named registry alias (previous registry: %s)',
  async (previousRegistry) => {
    const { repo, service, run, unchanged, files } =
      await setup(previousRegistry);
    const refs = repo.refs();
    const dry = run({ dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(service.state().requests).toEqual([]);
    expect(repo.refs()).toBe(refs);
    unchanged();

    const released = run();
    expect(released.ok, released.logs).toBe(true);
    expect(service.state().uploads).toEqual([
      'cargo:default-registry-core@1.1.0',
      'cargo:default-registry-adapter@1.1.0',
    ]);
    const manifest = await dependencyManifest(service);
    expect(manifest.dependencies).toEqual({
      renamed: { package: 'default-registry-core', version: '=1.1.0' },
    });
    expect(
      service.state().cargo['default-registry-adapter']['1.1.0'].metadata.deps,
    ).toEqual([
      expect.objectContaining({
        name: 'default-registry-core',
        version_req: '=1.1.0',
        registry: null,
      }),
    ]);
    expect(repo.state().status).toBe('complete');
    expect(repo.state().execution.packages[0].destination).toMatchObject({
      registry: 'crates-io',
      index: 'https://index.crates.io/',
    });
    unchanged();
    const completedRefs = repo.refs();
    const before = service.state();
    const noChange = run();
    expect(noChange.ok, noChange.logs).toBe(true);
    expect(noChange.result).toBe(false);
    expect(service.state()).toEqual(before);
    expect(repo.refs()).toBe(completedRefs);
    unchanged();

    if (!previousRegistry) {
      const file = 'crates/adapter/src/lib.rs';
      files[file] = 'pub fn value() -> u32 { renamed::value() + 1 }\n';
      writeFileSync(join(repo.cwd, file), files[file]);
      repo.git(repo.cwd, 'add', file);
      repo.commit('fix: update adapter');
      const patched = run();
      expect(patched.ok, patched.logs).toBe(true);
      expect(service.state().uploads).toEqual([
        'cargo:default-registry-core@1.1.0',
        'cargo:default-registry-adapter@1.1.0',
        'cargo:default-registry-adapter@1.1.1',
      ]);
      expect(repo.state().planning.plan.packages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'cargo:default-registry-core',
            currentVersion: '1.1.0',
            nextVersion: null,
          }),
          expect.objectContaining({
            id: 'cargo:default-registry-adapter',
            currentVersion: '1.1.0',
            nextVersion: '1.1.1',
          }),
        ]),
      );
      expect((await dependencyManifest(service, '1.1.1')).dependencies).toEqual(
        {
          renamed: { package: 'default-registry-core', version: '=1.1.0' },
        },
      );
      unchanged();
    }
  },
);

test('Cargo retains a configured crates-io alias when it selects a custom index', async () => {
  const { repo, service, run, unchanged } = await setup(false, true);
  const released = run();
  expect(released.ok, released.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:default-registry-core@1.1.0',
    'cargo:default-registry-adapter@1.1.0',
  ]);
  // Resolution can use the fixture mirror in either case, but the published
  // dependency must still retain the explicitly selected custom registry index.
  expect((await dependencyManifest(service)).dependencies).toEqual({
    renamed: {
      package: 'default-registry-core',
      version: '=1.1.0',
      'registry-index': `sparse+${service.url}/cargo/index/`,
    },
  });
  expect(repo.state().execution.packages[0].destination).toMatchObject({
    registry: 'crates-io',
    index: `${service.url}/cargo/index/`,
  });
  unchanged();
});

test.each([
  ['no source alias', 'none'],
  ['a matching repository-local source alias', 'local'],
  ['a direct repository-local crates-io source', 'direct-local'],
  ['a direct repository-local source candidate', 'candidate-local'],
] as const)(
  'Cargo packages coordinated crates-io dependencies with an empty package subprocess home and %s',
  async (_sourceDescription, sourceLocation) => {
    const { repo, service, runWithEmptyPackageHome, unchanged } = await setup(
      false,
      true,
      sourceLocation,
    );
    const { emptyHome, trace, released } = runWithEmptyPackageHome();
    expect(
      released.ok,
      `${released.logs}\n${readFileSync(trace, 'utf8')}`,
    ).toBe(true);
    expect(service.state().uploads).toEqual([
      'cargo:default-registry-core@1.1.0',
      'cargo:default-registry-adapter@1.1.0',
    ]);
    expect((await dependencyManifest(service)).dependencies).toEqual({
      renamed: {
        package: 'default-registry-core',
        version: '=1.1.0',
        'registry-index': `sparse+${service.url}/cargo/index/`,
      },
    });
    expect(repo.state().execution.packages[0].destination).toMatchObject({
      registry: 'crates-io',
      index: `${service.url}/cargo/index/`,
    });
    expect(existsSync(join(emptyHome, 'config.toml'))).toBe(false);
    unchanged();
  },
);

test('Cargo combines a repository-local source prefix with a global terminal', async () => {
  const { repo, service, run, runWithEmptyPackageHome, unchanged } =
    await setup(false, true, 'split-local');
  const refs = repo.refs();
  const dry = run({ dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(repo.refs()).toBe(refs);
  unchanged();

  const { emptyHome, trace, released } = runWithEmptyPackageHome();
  expect(released.ok, `${released.logs}\n${readFileSync(trace, 'utf8')}`).toBe(
    true,
  );
  expect(service.state().uploads).toEqual([
    'cargo:default-registry-core@1.1.0',
    'cargo:default-registry-adapter@1.1.0',
  ]);
  expect((await dependencyManifest(service)).dependencies).toEqual({
    renamed: {
      package: 'default-registry-core',
      version: '=1.1.0',
      'registry-index': `sparse+${service.url}/cargo/index/`,
    },
  });
  expect(existsSync(join(emptyHome, 'config.toml'))).toBe(false);
  unchanged();
});

test('Cargo packages a named-registry crate with a staged custom crates-io dependency', async () => {
  const { repo, service, selected, runWithEmptyPackageHome, unchanged } =
    await setup(false, true, 'none', true);
  const { emptyHome, trace, released } = runWithEmptyPackageHome();
  expect(
    released.ok,
    `${released.logs}\n${existsSync(trace) ? readFileSync(trace, 'utf8') : ''}`,
  ).toBe(true);
  expect(selected.state().uploads).toEqual([
    'cargo:default-registry-core@1.1.0',
  ]);
  expect(service.state().uploads).toEqual([
    'cargo:default-registry-adapter@1.1.0',
  ]);
  expect((await dependencyManifest(service)).dependencies).toEqual({
    renamed: {
      package: 'default-registry-core',
      version: '=1.1.0',
      'registry-index': `sparse+${selected.url}/cargo/index/`,
    },
  });
  expect(repo.state().execution.packages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'cargo:default-registry-core',
        destination: expect.objectContaining({
          registry: 'crates-io',
          index: `${selected.url}/cargo/index/`,
        }),
      }),
      expect.objectContaining({
        id: 'cargo:default-registry-adapter',
        destination: expect.objectContaining({ registry: 'fixture' }),
      }),
    ]),
  );
  expect(existsSync(join(emptyHome, 'config.toml'))).toBe(false);
  unchanged();
});

test('Cargo rejects a conflicting custom crates-io source before cross-registry uploads', async () => {
  const { service, selected, runWithEmptyPackageHome, unchanged } = await setup(
    false,
    true,
    'chained-local',
    true,
  );
  const { released } = runWithEmptyPackageHome();
  expect(released.ok).toBe(false);
  expect(released.codes, released.logs).toContain('EWORKSPACECONFIG');
  expect(service.state().requests).toEqual([]);
  expect(selected.state().requests).toEqual([]);
  expect(service.state().uploads).toEqual([]);
  expect(selected.state().uploads).toEqual([]);
  unchanged();
});

test('Cargo rejects a chained source that conflicts with the selected crates-io index', async () => {
  const { service, runWithEmptyPackageHome, unchanged } = await setup(
    false,
    true,
    'chained-local',
  );
  const { released } = runWithEmptyPackageHome();
  expect(released.ok).toBe(false);
  expect(released.codes, released.logs).toContain('EWORKSPACECONFIG');
  expect(service.state().uploads).toEqual([]);
  unchanged();
});

test('Cargo rejects a matching source candidate that also replaces another source', async () => {
  const { service, runWithEmptyPackageHome, unchanged } = await setup(
    false,
    true,
    'candidate-chain-local',
  );
  const { released } = runWithEmptyPackageHome();
  expect(released.ok).toBe(false);
  expect(released.codes, released.logs).toContain('EWORKSPACECONFIG');
  expect(service.state().uploads).toEqual([]);
  unchanged();
});

test('fresh-clone default-registry Cargo recovery preserves both verified artifacts without republishing the dependency', async () => {
  const { repo, service, run, unchanged } = await setup();
  service.control('reject-second');
  const failed = run();
  expect(failed.ok).toBe(false);
  expect(service.state().uploads).toEqual([
    'cargo:default-registry-core@1.1.0',
  ]);
  const pending = repo.state();
  expect(pending.status).toBe('pending');
  const artifacts = pending.execution.packages.map(
    (entry: { artifact: unknown }) => entry.artifact,
  );
  expect(artifacts).toHaveLength(2);
  for (const artifact of artifacts) expect(artifact).toBeDefined();
  unchanged();

  service.control('');
  const clone = repo.clone();
  const released = run({}, clone);
  expect(released.ok, released.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:default-registry-core@1.1.0',
    'cargo:default-registry-adapter@1.1.0',
  ]);
  expect(repo.state().status).toBe('complete');
  expect(
    repo
      .state()
      .execution.packages.map((entry: { artifact: unknown }) => entry.artifact),
  ).toEqual(artifacts);
  expect((await dependencyManifest(service)).dependencies).toEqual({
    renamed: { package: 'default-registry-core', version: '=1.1.0' },
  });
  unchanged(clone);
});
