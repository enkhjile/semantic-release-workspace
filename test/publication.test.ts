import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
function workspace(directory = 'packages') {
  const repo = fixture();
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ private: true, workspaces: [`${directory}/*`] }),
  );
  mkdirSync(join(repo.cwd, directory, 'lib'), { recursive: true });
  writeFileSync(
    join(repo.cwd, directory, 'lib/package.json'),
    JSON.stringify({ name: 'publication-fixture', version: '1.0.0' }),
  );
  writeFileSync(
    join(repo.cwd, directory, 'lib/index.js'),
    'export const value = 1;\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add library');
  return repo;
}
test('publication dry run leaves manifests, refs and worktree untouched', () => {
  const repo = workspace();
  const refs = repo.refs();
  const before = readFileSync(
    join(repo.cwd, 'packages/lib/package.json'),
    'utf8',
  );
  const result = repo.run({
    dryRun: true,
    pluginConfig: { publish: true, npm: { registry: 'http://127.0.0.1:1' } },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(repo.refs()).toBe(refs);
  expect(
    readFileSync(join(repo.cwd, 'packages/lib/package.json'), 'utf8'),
  ).toBe(before);
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
});
test('unavailable registry stops before creating publication intent', () => {
  const repo = workspace();
  const before = readFileSync(
    join(repo.cwd, 'packages/lib/package.json'),
    'utf8',
  );
  const result = repo.run({
    pluginConfig: { publish: true, npm: { registry: 'http://127.0.0.1:1' } },
  });
  expect(result.ok).toBe(false);
  expect(repo.refs()).not.toContain('refs/notes/semantic-release-workspace');
  expect(repo.tags()).toEqual([]);
  expect(
    readFileSync(join(repo.cwd, 'packages/lib/package.json'), 'utf8'),
  ).toBe(before);
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
});

test('npm publishes retained bytes, tags released manifests, restores the checkout and skips no-change runs', async () => {
  const repo = workspace();
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: {
      publish: true,
      npm: { registry: service.url, access: 'public' },
    },
  };
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual(['npm:publication-fixture@1.1.0']);
  expect(repo.tags()).toContain('npm/publication-fixture@1.1.0');
  expect(
    JSON.parse(
      repo.git(
        repo.remote,
        'show',
        'npm/publication-fixture@1.1.0:packages/lib/package.json',
      ),
    ).version,
  ).toBe('1.1.0');
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  expect(
    JSON.parse(
      readFileSync(join(repo.cwd, 'packages/lib/package.json'), 'utf8'),
    ).version,
  ).toBe('1.0.0');
  expect(repo.state().execution.packages[0].tagged).toBe(true);
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok, retry.logs).toBe(true);
  expect(retry.result).toBe(false);
  expect(service.state().uploads).toHaveLength(1);
});

test('npm accepted upload with a lost response is recovered by integrity without a second upload', async () => {
  const repo = workspace();
  const service = await registry();
  service.control('once-drop');
  const result = repo.run({
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(1);
  expect(repo.state().status).toBe('complete');
});

test('fresh-clone retry replays an artifact without rerunning package scripts', async () => {
  const repo = workspace();
  const service = await registry();
  service.control('reject');
  const script = join(repo.cwd, 'packages/lib/package.json');
  writeFileSync(
    script,
    JSON.stringify({
      name: 'publication-fixture',
      version: '1.0.0',
      scripts: {
        prepack:
          "node -e \"require('fs').writeFileSync('built.js','retained bytes')\"",
      },
    }),
  );
  writeFileSync(join(repo.cwd, '.gitignore'), 'built.js\n');
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: build artifact');
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const first = repo.run(settings);
  expect(first.ok).toBe(false);
  expect(repo.state().execution.packages[0].intent).toBe(true);
  const artifact = repo.state().execution.packages[0].artifact;
  service.control('');
  const clone = repo.clone();
  const retry = repo.run(settings, clone);
  expect(retry.ok, retry.logs).toBe(true);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(service.state().uploads).toHaveLength(1);
  expect(() => readFileSync(join(clone, 'packages/lib/built.js'))).toThrow();
});

test('fresh-clone retries preserve leading whitespace in package paths', async () => {
  const repo = workspace(' packages');
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  service.control('reject');
  const first = repo.run(settings);
  expect(first.ok).toBe(false);
  expect(first.codes).toContain('EWORKSPACEPUBLISH');
  const artifact = repo.state().execution.packages[0].artifact;
  expect(artifact).toBeDefined();
  expect(service.state().uploads).toEqual([]);
  const clone = repo.clone();
  expect(repo.git(clone, 'status', '--porcelain')).toBe('');
  service.control('');
  const retry = repo.run(settings, clone);
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toEqual(['npm:publication-fixture@1.1.0']);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(repo.state().status).toBe('complete');
  expect(repo.git(clone, 'status', '--porcelain')).toBe('');
});

test('Cargo publishes dependency-first using verified native crate artifacts and inherited manifests', async () => {
  const { repo, service } = await cargoWorkspace();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  };
  const dry = repo.run({ ...settings, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(service.state().uploads).toEqual([]);
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:fixture-core@1.1.0',
    'cargo:fixture-app@1.1.0',
  ]);
  expect(repo.tags()).toContain('cargo/fixture-app@1.1.0');
  expect(
    repo.git(
      repo.remote,
      'show',
      'cargo/fixture-core@1.1.0:crates/core/Cargo.toml',
    ),
  ).toContain('version = "1.1.0" # preserve comment');
  expect(
    repo.git(repo.remote, 'show', 'cargo/fixture-core@1.1.0:Cargo.toml'),
  ).toContain('version = "=1.1.0"');
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  expect(repo.state().status).toBe('complete');
});

async function cargoWorkspace() {
  const repo = fixture();
  const service = await registry();
  mkdirSync(join(repo.cwd, '.cargo'));
  mkdirSync(join(repo.cwd, 'crates/core/src'), { recursive: true });
  mkdirSync(join(repo.cwd, 'crates/app/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n[workspace.package]\nversion = "1.0.0"\n[workspace.dependencies]\nrenamed = { package = "fixture-core", path = "crates/core", version = "=1.0.0" }\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/core/Cargo.toml'),
    '[package]\nname = "fixture-core"\nversion.workspace = true # preserve comment\nedition = "2024"\npublish = ["fixture"]\nlicense = "MIT"\ndescription = "fixture"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/core/src/lib.rs'),
    'pub fn value() -> u32 { 1 }\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/app/Cargo.toml'),
    '[package]\nname = "fixture-app"\nedition = "2024"\npublish = ["fixture"]\nlicense = "MIT"\ndescription = "fixture"\n[package.version]\nworkspace = true\n[dependencies]\nrenamed.workspace = true\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/app/src/lib.rs'),
    'pub fn value() -> u32 { renamed::value() }\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add crates');
  return { repo, service };
}

test('npm registry override wins over package and scope configuration', async () => {
  const repo = workspace();
  const selected = await registry();
  const other = await registry();
  const manifest = join(repo.cwd, 'packages/lib/package.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      name: '@fixture/scoped',
      version: '1.0.0',
      publishConfig: { registry: other.url, access: 'restricted' },
    }),
  );
  writeFileSync(join(repo.cwd, '.npmrc'), `@fixture:registry=${other.url}\n`);
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: configure scoped package');
  const result = repo.run({
    env: selected.env,
    pluginConfig: {
      publish: true,
      npm: { registry: selected.url, access: 'public' },
    },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(selected.state().uploads).toEqual(['npm:@fixture/scoped@1.1.0']);
  expect(other.state().requests).toEqual([]);
});

test.each(['redirect:', 'redirect-put:'])(
  'npm %s cannot forward credentials to another port',
  async (mode) => {
    const repo = workspace();
    const origin = await registry();
    const receiver = await registry();
    origin.control(`${mode}${receiver.url}`);
    const result = repo.run({
      env: origin.env,
      pluginConfig: { publish: true, npm: { registry: origin.url } },
    });
    expect(result.ok).toBe(false);
    expect(receiver.state().requests).toEqual([]);
    expect(
      origin
        .state()
        .requests.some(
          (entry: { authorization?: string }) =>
            entry.authorization === 'Bearer fixture-token',
        ),
    ).toBe(true);
    expect(result.logs).not.toContain('fixture-token');
    if (mode === 'redirect-put:') expect(repo.state().status).toBe('pending');
    else
      expect(repo.refs()).not.toContain(
        'refs/notes/semantic-release-workspace',
      );
  },
);

test('fresh clone confirms an accepted npm upload after registry verification was unavailable', async () => {
  const repo = workspace();
  const service = await registry();
  service.control('once-drop-unreadable');
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const first = repo.run(settings);
  expect(first.ok).toBe(false);
  expect(service.state().uploads).toHaveLength(1);
  expect(repo.state().execution.packages[0]).toMatchObject({
    intent: true,
    published: false,
    tagged: false,
  });
  const artifact = repo.state().execution.packages[0].artifact;
  service.control('');
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok, retry.logs).toBe(true);
  expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
  expect(service.state().uploads).toHaveLength(1);
});

test('package tag push failure retries from a fresh clone without another registry upload', async () => {
  const repo = workspace();
  const service = await registry();
  const hook = join(repo.remote, 'hooks/update');
  writeFileSync(
    hook,
    '#!/bin/sh\ncase "$1" in refs/tags/npm/*) exit 1;; esac\n',
  );
  chmodSync(hook, 0o755);
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const first = repo.run(settings);
  expect(first.ok).toBe(false);
  expect(repo.state().execution.packages[0]).toMatchObject({
    published: true,
    tagged: false,
  });
  unlinkSync(hook);
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(1);
  expect(repo.tags()).toContain('npm/publication-fixture@1.1.0');
});

test('foreign npm version is rejected even when its artifact matches', async () => {
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const first = workspace();
  expect(first.run(settings).ok).toBe(true);
  const second = workspace();
  const result = second.run(settings);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACECONFLICT');
  expect(service.state().uploads).toHaveLength(1);
  expect(second.tags().some((tag) => tag.startsWith('npm/'))).toBe(false);
});

test('npm workspace aliases and local dependencies are converted only in the artifact; private packages stay unpublished', async () => {
  const repo = workspace();
  const service = await registry();
  mkdirSync(join(repo.cwd, 'packages/app'));
  mkdirSync(join(repo.cwd, 'packages/private'));
  writeFileSync(
    join(repo.cwd, 'packages/private/package.json'),
    JSON.stringify({ name: 'private-tool', version: '1.0.0', private: true }),
  );
  writeFileSync(
    join(repo.cwd, 'packages/app/package.json'),
    JSON.stringify({
      name: 'fixture-app',
      version: '1.0.0',
      dependencies: {
        alias: 'workspace:publication-fixture@^',
        local: 'file:../lib',
      },
      devDependencies: { 'private-tool': 'workspace:*' },
    }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add consumer and private tool');
  const result = repo.run({
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'npm:publication-fixture@1.1.0',
    'npm:fixture-app@1.1.0',
  ]);
  const bytes = Buffer.from(
    service.state().npm['fixture-app']['1.1.0'].artifact,
    'base64',
  );
  const manifest = JSON.parse(await archiveFile(bytes, 'package/package.json'));
  expect(manifest.dependencies).toEqual({
    alias: 'npm:publication-fixture@^1.1.0',
    local: 'npm:publication-fixture@1.1.0',
  });
  expect(
    repo.git(
      repo.remote,
      'show',
      'npm/fixture-app@1.1.0:packages/app/package.json',
    ),
  ).toContain('workspace:publication-fixture@^');
  expect(repo.tags().some((tag) => tag.includes('private-tool'))).toBe(false);
});

test('Cargo ignores ignored secrets, rejects credential redirects and retries retained bytes from a fresh clone', async () => {
  const { repo, service } = await cargoWorkspace();
  const receiver = await registry();
  writeFileSync(join(repo.cwd, '.gitignore'), 'credentials.txt\n');
  writeFileSync(
    join(repo.cwd, 'crates/core/credentials.txt'),
    'must-not-publish',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: ignore credentials');
  writeFileSync(join(repo.cwd, '.git/info/exclude'), 'local-secret.txt\n');
  writeFileSync(
    join(repo.cwd, 'crates/core/local-secret.txt'),
    'local ignore sentinel',
  );
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  };
  service.control(`redirect-put:${receiver.url}`);
  const failed = repo.run(settings);
  expect(failed.ok).toBe(false);
  expect(receiver.state().requests).toEqual([]);
  expect(service.state().uploads).toHaveLength(0);
  const artifact = repo
    .state()
    .execution.packages.find(
      (entry: { id: string }) => entry.id === 'cargo:fixture-core',
    ).artifact;
  service.control('once-drop');
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:fixture-core@1.1.0',
    'cargo:fixture-app@1.1.0',
  ]);
  const crate = Buffer.from(
    service.state().cargo['fixture-core']['1.1.0'].artifact,
    'base64',
  );
  await expect(
    archiveFile(crate, 'fixture-core-1.1.0/credentials.txt'),
  ).rejects.toMatchObject({ code: 'EWORKSPACEARTIFACT' });
  expect(
    repo
      .state()
      .execution.packages.find(
        (entry: { id: string }) => entry.id === 'cargo:fixture-core',
      ).artifact,
  ).toEqual(artifact);
});

test('conflicting per-package tag stops publication without moving the tag', async () => {
  const repo = workspace();
  const service = await registry();
  const commit = repo.git(
    repo.cwd,
    'commit-tree',
    'HEAD^{tree}',
    '-p',
    'HEAD',
    '-m',
    'unmerged release',
  );
  repo.git(repo.cwd, 'tag', 'npm/publication-fixture@1.1.0', commit);
  repo.git(
    repo.cwd,
    'push',
    'origin',
    'refs/tags/npm/publication-fixture@1.1.0',
  );
  const result = repo.run({
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  });
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACETAG');
  expect(service.state().uploads).toEqual([]);
  expect(
    repo.git(repo.remote, 'rev-parse', 'npm/publication-fixture@1.1.0'),
  ).toBe(commit);
});

test('changing the pending registry or deleting its retained artifact blocks retry', async () => {
  const repo = workspace();
  const service = await registry();
  const other = await registry();
  service.control('reject');
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  expect(repo.run(settings).ok).toBe(false);
  const changed = repo.run({
    ...settings,
    pluginConfig: { publish: true, npm: { registry: other.url } },
  });
  expect(changed.codes).toContain('EWORKSPACEPLAN');
  expect(other.state().requests).toEqual([]);
  repo.git(
    repo.remote,
    'update-ref',
    '-d',
    repo.state().execution.packages[0].artifact.ref,
  );
  service.control('');
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok).toBe(false);
  expect(retry.codes).toContain('EWORKSPACEARTIFACT');
  expect(service.state().uploads).toEqual([]);
});

test('swapped artifact descriptors fail package binding before any further registry writes', async () => {
  const repo = workspace();
  const service = await registry();
  service.control('reject-second');
  mkdirSync(join(repo.cwd, 'packages/extra'));
  writeFileSync(
    join(repo.cwd, 'packages/extra/package.json'),
    JSON.stringify({ name: 'fixture-extra', version: '1.0.0' }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add second package');
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  expect(repo.run(settings).ok).toBe(false);
  const state = repo.state();
  expect(
    state.execution.packages.every(
      (entry: { artifact?: unknown }) => entry.artifact,
    ),
  ).toBe(true);
  const [a, b] = state.execution.packages;
  [a.artifact, b.artifact] = [b.artifact, a.artifact];
  repo.git(
    repo.remote,
    'notes',
    '--ref=refs/notes/semantic-release-workspace',
    'add',
    '-f',
    '-m',
    JSON.stringify(state),
    repo.anchor,
  );
  service.control('');
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok).toBe(false);
  expect(retry.codes).toContain('EWORKSPACEARTIFACT');
  expect(service.state().uploads).toHaveLength(1);
});

test('retry preserves user edits rather than overwriting them as prepared manifests', async () => {
  const repo = workspace();
  const service = await registry();
  service.control('reject');
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  expect(repo.run(settings).ok).toBe(false);
  const file = join(repo.cwd, 'packages/lib/package.json');
  const edited = JSON.stringify({
    name: 'publication-fixture',
    version: '1.1.0',
    custom: 'user edit',
  });
  writeFileSync(file, edited);
  service.control('');
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEDIRTY');
  expect(readFileSync(file, 'utf8')).toBe(edited);
  expect(service.state().uploads).toEqual([]);
});

test('hard termination during npm prepack recovers canonical manifests on the next real release', async () => {
  const repo = workspace();
  const service = await registry();
  const ready = join(service.root, 'ready');
  const file = join(repo.cwd, 'packages/lib/package.json');
  writeFileSync(
    file,
    JSON.stringify({
      name: 'publication-fixture',
      version: '1.0.0',
      scripts: {
        prepack: `node -e "if(process.env.BLOCK_PACK==='1'){require('fs').writeFileSync(process.env.READY_PATH,'ready');setInterval(()=>{},1000)}"`,
      },
    }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('fix: exercise interrupted build');
  const settings = {
    env: { ...service.env, BLOCK_PACK: '1', READY_PATH: ready },
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./fixtures/run-release.mjs', import.meta.url)),
      repo.cwd,
      repo.remote,
      fileURLToPath(new URL('../dist/index.mjs', import.meta.url)),
      JSON.stringify(settings),
    ],
    { cwd: repo.cwd, env: repo.env, detached: true, stdio: 'ignore' },
  );
  try {
    let reached = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        readFileSync(ready);
        reached = true;
        break;
      } catch {
        await delay(50);
      }
    }
    expect(reached).toBe(true);
  } finally {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe('1.1.0');
  expect(service.state().uploads).toEqual([]);
  const retry = repo.run({
    ...settings,
    env: { ...settings.env, BLOCK_PACK: '0' },
  });
  expect(retry.ok, retry.logs).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe('1.0.0');
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  expect(service.state().uploads).toHaveLength(1);
});

test('Cargo registry override controls internal dependencies and skips publish=false crates', async () => {
  const { repo, service } = await cargoWorkspace();
  const selected = await registry();
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n[registries.other]\nindex = "sparse+${selected.url}/cargo/index/"\n`,
  );
  for (const name of ['core', 'app']) {
    const file = join(repo.cwd, `crates/${name}/Cargo.toml`);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'publish = ["fixture"]',
        'publish = ["fixture", "other"]',
      ),
    );
  }
  mkdirSync(join(repo.cwd, 'crates/private/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'crates/private/Cargo.toml'),
    '[package]\nname = "fixture-private"\nversion = "1.0.0"\npublish = false\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/private/src/lib.rs'),
    'deliberately not compilable',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add nonpublishable crate');
  const result = repo.run({
    env: { ...selected.env, CARGO_REGISTRIES_OTHER_TOKEN: 'fixture-token' },
    pluginConfig: { publish: true, cargo: { registry: 'other' } },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().requests).toEqual([]);
  expect(selected.state().uploads).toEqual([
    'cargo:fixture-core@1.1.0',
    'cargo:fixture-app@1.1.0',
  ]);
  expect(repo.tags().some((tag) => tag.includes('fixture-private'))).toBe(
    false,
  );
});

test('Cargo publish registry allowlist is enforced before any registry request', async () => {
  const { repo, service } = await cargoWorkspace();
  const result = repo.run({
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'other' } },
  });
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACECONFIG');
  expect(service.state().requests).toEqual([]);
  expect(repo.tags()).toEqual([]);
});

test.each(['restricted', null])(
  'npm native access %s is frozen without forcing public visibility',
  async (access) => {
    const repo = workspace();
    const service = await registry();
    writeFileSync(
      join(repo.cwd, 'packages/lib/package.json'),
      JSON.stringify({ name: '@fixture/access', version: '1.0.0' }),
    );
    if (access) writeFileSync(join(repo.cwd, '.npmrc'), `access=${access}\n`);
    repo.git(repo.cwd, 'add', '.');
    repo.commit('fix: configure access');
    const result = repo.run({
      env: service.env,
      pluginConfig: { publish: true, npm: { registry: service.url } },
    });
    expect(result.ok, result.logs).toBe(true);
    expect(repo.state().execution.packages[0].destination.access).toBe(access);
    expect(service.state().npm['@fixture/access']['1.1.0'].access).toBe(access);
  },
);

test.each(['public', 'restricted'])(
  'explicit npm access null overrides package publishConfig access %s',
  async (access) => {
    const repo = workspace();
    const service = await registry();
    const file = join(repo.cwd, 'packages/lib/package.json');
    const before = JSON.stringify({
      name: '@fixture/access',
      version: '1.0.0',
      publishConfig: { access },
    });
    writeFileSync(file, before);
    repo.git(repo.cwd, 'add', '.');
    repo.commit('fix: configure package access');
    const settings = {
      env: service.env,
      pluginConfig: {
        publish: true,
        npm: { registry: service.url, access: null },
      },
    };
    const refs = repo.refs();
    const dry = repo.run({ ...settings, dryRun: true });
    expect(dry.ok, dry.logs).toBe(true);
    expect(repo.refs()).toBe(refs);
    expect(service.state().requests).toEqual([]);
    service.control('reject');
    const first = repo.run(settings);
    expect(first.ok).toBe(false);
    expect(first.codes, first.logs).toContain('EWORKSPACEPUBLISH');
    const artifact = repo.state().execution.packages[0].artifact;
    expect(artifact).toBeDefined();
    service.control('');
    const clone = repo.clone();
    const retry = repo.run(settings, clone);
    expect(retry.ok, retry.logs).toBe(true);
    const entry = service.state().npm['@fixture/access']['1.1.0'];
    const manifest = JSON.parse(
      await archiveFile(
        Buffer.from(entry.artifact, 'base64'),
        'package/package.json',
      ),
    );
    expect(manifest.publishConfig.access ?? null).toBeNull();
    expect(entry.access).toBeNull();
    expect(repo.state().execution.packages[0].destination.access).toBeNull();
    expect(repo.state().execution.packages[0].artifact).toEqual(artifact);
    expect(service.state().uploads).toEqual(['npm:@fixture/access@1.1.0']);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(join(clone, 'packages/lib/package.json'), 'utf8')).toBe(
      before,
    );
    expect(repo.git(clone, 'status', '--porcelain')).toBe('');
  },
);

test('pending recovery rejects replaced manifest directories without touching symlink targets', async () => {
  const repo = workspace();
  const service = await registry();
  service.control('reject');
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  expect(repo.run(settings).ok).toBe(false);
  const target = join(service.root, 'outside');
  mkdirSync(target);
  const original = readFileSync(
    join(repo.cwd, 'packages/lib/package.json'),
    'utf8',
  );
  writeFileSync(join(target, 'package.json'), original);
  rmSync(join(repo.cwd, 'packages/lib'), { recursive: true });
  symlinkSync(target, join(repo.cwd, 'packages/lib'));
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACEDIRTY');
  expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe(original);
  expect(service.state().uploads).toEqual([]);
});

test('npm origin-bound transport preserves scoped client certificates and custom CA trust', async () => {
  const repo = workspace();
  const service = await registry(true);
  const result = repo.run({
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(1);
  expect(service.state().requests.length).toBeGreaterThan(0);
  expect(
    service
      .state()
      .requests.every(
        (entry: { authorized?: boolean }) => entry.authorized === true,
      ),
  ).toBe(true);
});

test('fresh clone restores a missing package tag from a partially completed batch without republishing', async () => {
  const repo = workspace();
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const first = repo.run({ ...settings, failure: 'publish' });
  expect(first.ok).toBe(false);
  expect(repo.state().execution.packages[0].tagged).toBe(true);
  repo.git(
    repo.remote,
    'update-ref',
    '-d',
    'refs/tags/npm/publication-fixture@1.1.0',
  );
  const retry = repo.run(settings, repo.clone());
  expect(retry.ok, retry.logs).toBe(true);
  expect(service.state().uploads).toHaveLength(1);
  expect(repo.tags()).toContain('npm/publication-fixture@1.1.0');
});

test('malformed Cargo registry responses cannot expose echoed credentials in release logs', async () => {
  const { repo, service } = await cargoWorkspace();
  service.control('bad-json');
  const result = repo.run({
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  });
  expect(result.ok).toBe(false);
  expect(result.codes).toContain('EWORKSPACEPUBLISH');
  expect(result.logs).not.toContain('fixture-token');
  expect(service.state().uploads).toEqual([]);
});

test('a foreign later package version blocks the whole batch before any new uploads', async () => {
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const seed = workspace();
  writeFileSync(
    join(seed.cwd, 'packages/lib/package.json'),
    JSON.stringify({ name: 'z-taken', version: '1.0.0' }),
  );
  seed.git(seed.cwd, 'add', '.');
  seed.commit('fix: seed occupied package');
  expect(seed.run(settings).ok).toBe(true);
  const repo = workspace();
  mkdirSync(join(repo.cwd, 'packages/z-taken'));
  writeFileSync(
    join(repo.cwd, 'packages/z-taken/package.json'),
    JSON.stringify({ name: 'z-taken', version: '1.0.0' }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: add occupied dependency');
  const result = repo.run(settings);
  expect(result.codes).toContain('EWORKSPACECONFLICT');
  expect(service.state().uploads).toEqual(['npm:z-taken@1.1.0']);
  expect(repo.tags()).toEqual([]);
});
