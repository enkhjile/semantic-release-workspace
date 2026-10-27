import { spawn } from 'node:child_process';
import {
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
async function workspace() {
  const repo = fixture();
  const service = await registry();
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
  mkdirSync(join(repo.cwd, '.cargo'));
  mkdirSync(join(repo.cwd, 'crates/core/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, '.cargo/config.toml'),
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  writeFileSync(join(repo.cwd, '.gitignore'), 'target/\nCargo.lock\n');
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/core"]\nresolver = "3"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/core/Cargo.toml'),
    '[package]\nname = "notes-core"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Changelog fixture"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/core/src/lib.rs'),
    'pub fn value() -> u8 { 1 }',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: add workspaces');
  const settings = {
    env: service.env,
    pluginConfig: {
      publish: true,
      changelog: true,
      synchronizeDependents: true,
      npm: { registry: service.url },
      cargo: { registry: 'fixture' },
    },
  };
  return { repo, service, settings };
}
function change(
  repo: Awaited<ReturnType<typeof workspace>>['repo'],
  path: string,
  message: string,
) {
  writeFileSync(
    join(repo.cwd, path),
    path.endsWith('.rs')
      ? `pub fn value() -> u64 { ${Date.now()} }`
      : `export const value = ${Date.now()};`,
  );
  repo.git(repo.cwd, 'add', '.');
  return repo.commit(message);
}
function released(
  repo: Awaited<ReturnType<typeof workspace>>['repo'],
  tag: string,
  path: string,
) {
  return repo.git(repo.remote, 'show', `${tag}:${path}`);
}
test('changelogs are previewed without writes and included in npm/Cargo snapshots and native artifacts', async () => {
  const { repo, service, settings } = await workspace();
  const history = '# Changelog\n\n## 0.9.0\n\nPrevious library history.\n';
  writeFileSync(join(repo.cwd, 'packages/lib/CHANGELOG.md'), history);
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: preserve old history');
  change(repo, 'packages/lib/index.js', 'feat: add searchable library');
  change(repo, 'crates/core/src/lib.rs', 'fix: correct crate behavior');
  const refs = repo.refs();
  const dry = repo.run({ ...settings, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(JSON.stringify(dry.result)).toContain('CHANGELOG.md');
  expect(repo.refs()).toBe(refs);
  expect(service.state().uploads).toEqual([]);
  expect(
    readFileSync(join(repo.cwd, 'packages/lib/CHANGELOG.md'), 'utf8'),
  ).toBe(history);
  expect(() =>
    readFileSync(join(repo.cwd, 'packages/app/CHANGELOG.md')),
  ).toThrow();
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const lib = released(repo, 'npm/lib@1.1.0', 'packages/lib/CHANGELOG.md');
  expect(lib).toContain('npm:lib@1.1.0');
  expect(lib).toContain('add searchable library');
  expect(lib).toContain('Previous library history.');
  expect(
    released(repo, 'npm/app@1.0.1', 'packages/app/CHANGELOG.md'),
  ).toContain('### Dependencies');
  expect(
    released(repo, 'cargo/notes-core@1.0.1', 'crates/core/CHANGELOG.md'),
  ).toContain('correct crate behavior');
  expect(
    await archiveFile(
      Buffer.from(service.state().npm.lib['1.1.0'].artifact, 'base64'),
      'package/CHANGELOG.md',
    ),
  ).toContain('add searchable library');
  expect(
    await archiveFile(
      Buffer.from(
        service.state().cargo['notes-core']['1.0.1'].artifact,
        'base64',
      ),
      'notes-core-1.0.1/CHANGELOG.md',
    ),
  ).toContain('correct crate behavior');
  expect(
    readFileSync(join(repo.cwd, 'packages/lib/CHANGELOG.md'), 'utf8'),
  ).toBe(history);
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  expect(() =>
    readFileSync(join(repo.cwd, 'crates/core/CHANGELOG.md')),
  ).toThrow();
  change(repo, 'packages/lib/index.js', 'fix: preserve released history');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const next = released(repo, 'npm/lib@1.1.1', 'packages/lib/CHANGELOG.md');
  expect(next.indexOf('npm:lib@1.1.1')).toBeLessThan(
    next.indexOf('npm:lib@1.1.0'),
  );
  expect(next.match(/npm:lib@1\.1\.0/g)).toHaveLength(1);
  expect(next).toContain('Previous library history.');
});

test('fresh-clone retries reuse exact changelog bytes and reject policy drift without duplicating uploads', async () => {
  const { repo, service, settings } = await workspace();
  change(repo, 'packages/lib/index.js', 'feat: retry changelog feature');
  service.control('reject');
  const first = repo.run(settings);
  expect(first.ok).toBe(false);
  const frozen = repo.state().planning.releaseNotes;
  expect(frozen.changelogs).toHaveLength(2);
  const retained = repo
    .state()
    .execution.packages.find(
      (pkg: { id: string }) => pkg.id === 'npm:lib',
    ).artifact;
  const clone = repo.clone();
  const refs = repo.refs();
  const dry = repo.run({ ...settings, dryRun: true }, clone);
  expect(dry.ok, dry.logs).toBe(true);
  expect(repo.refs()).toBe(refs);
  expect(repo.state().planning.releaseNotes).toEqual(frozen);
  expect(service.state().uploads).toEqual([]);
  const drift = repo.run(
    {
      ...settings,
      pluginConfig: { ...settings.pluginConfig, changelog: false },
    },
    clone,
  );
  expect(drift.codes).toContain('EWORKSPACEPLAN');
  expect(repo.refs()).toBe(refs);
  service.control('');
  const retry = repo.run(settings, clone);
  expect(retry.ok, retry.logs).toBe(true);
  expect(repo.state().planning.releaseNotes).toEqual(frozen);
  expect(
    repo
      .state()
      .execution.packages.find((pkg: { id: string }) => pkg.id === 'npm:lib')
      .artifact,
  ).toEqual(retained);
  expect(service.state().uploads).toHaveLength(2);
  expect(repo.git(clone, 'status', '--porcelain')).toBe('');
  const noChange = repo.run(settings, clone);
  expect(noChange.ok, noChange.logs).toBe(true);
  expect(noChange.result).toBe(false);
  expect(service.state().uploads).toHaveLength(2);
});

test('changelogs are opt-in and publish:false leaves the preview files absent', async () => {
  const { repo, service, settings } = await workspace();
  change(repo, 'packages/lib/index.js', 'feat: optional changelog');
  const preview = repo.run({
    pluginConfig: { publish: false, changelog: true },
  });
  expect(preview.ok, preview.logs).toBe(true);
  expect(repo.state().planning.releaseNotes.changelogs).toHaveLength(2);
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  expect(service.state().uploads).toEqual([]);
  change(repo, 'packages/lib/index.js', 'fix: publish without generated files');
  const result = repo.run({
    ...settings,
    pluginConfig: { ...settings.pluginConfig, changelog: false },
  });
  expect(result.ok, result.logs).toBe(true);
  expect(repo.state().planning.releaseNotes.changelogs).toEqual([]);
  expect(
    repo.git(repo.remote, 'ls-tree', '-r', '--name-only', 'npm/lib@1.1.1'),
  ).not.toContain('CHANGELOG.md');
});

test('explicitly committed changelog edits take precedence over released history', async () => {
  const { repo, settings } = await workspace();
  change(repo, 'packages/lib/index.js', 'feat: old generated note');
  expect(repo.run(settings).ok).toBe(true);
  const edited = '# Maintained history\n\nCurated migration instructions.\n';
  writeFileSync(join(repo.cwd, 'packages/lib/CHANGELOG.md'), edited);
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: curate changelog');
  change(repo, 'packages/lib/index.js', 'fix: follow curated history');
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const text = released(repo, 'npm/lib@1.1.1', 'packages/lib/CHANGELOG.md');
  expect(text).toContain('Curated migration instructions.');
  expect(text).not.toContain('old generated note');
  expect(
    readFileSync(join(repo.cwd, 'packages/lib/CHANGELOG.md'), 'utf8'),
  ).toBe(edited);
});

test('npm and Cargo packages sharing a directory retain both histories in one changelog', async () => {
  const { repo, service, settings } = await workspace();
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["packages/lib"]\nresolver = "3"\n',
  );
  mkdirSync(join(repo.cwd, 'packages/lib/src'));
  writeFileSync(
    join(repo.cwd, 'packages/lib/src/lib.rs'),
    'pub fn value() -> u8 { 1 }',
  );
  writeFileSync(
    join(repo.cwd, 'packages/lib/Cargo.toml'),
    readFileSync(join(repo.cwd, 'crates/core/Cargo.toml'), 'utf8'),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: share package directory');
  change(repo, 'packages/lib/index.js', 'feat: first dual package release');
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const first = released(repo, 'npm/lib@1.1.0', 'packages/lib/CHANGELOG.md');
  expect(first).toContain('npm:lib@1.1.0');
  expect(first).toContain('cargo:notes-core@1.1.0');
  expect(
    await archiveFile(
      Buffer.from(
        service.state().cargo['notes-core']['1.1.0'].artifact,
        'base64',
      ),
      'notes-core-1.1.0/CHANGELOG.md',
    ),
  ).toContain('npm:lib@1.1.0');
  change(repo, 'packages/lib/index.js', 'fix: next dual package release');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const next = released(repo, 'npm/lib@1.1.1', 'packages/lib/CHANGELOG.md');
  expect(next.match(/## npm:lib@1\.1\.0/g)).toHaveLength(1);
  expect(next.match(/## cargo:notes-core@1\.1\.0/g)).toHaveLength(1);
  expect(next).toContain('cargo:notes-core@1.1.1');
});

test('prerelease changelogs keep their own history and stable npm/Cargo releases exclude prerelease entries', async () => {
  const { repo, settings } = await workspace();
  const branches = ['main', { name: 'beta', prerelease: true }];
  const options = { ...settings, branches };
  change(repo, 'packages/lib/index.js', 'feat: stable library');
  change(repo, 'crates/core/src/lib.rs', 'feat: stable crate');
  expect(repo.run(options).ok).toBe(true);
  repo.git(repo.cwd, 'checkout', '-b', 'beta');
  repo.git(repo.cwd, 'push', '-u', 'origin', 'beta');
  change(repo, 'packages/lib/index.js', 'feat: preview library');
  change(repo, 'crates/core/src/lib.rs', 'feat: preview crate');
  let result = repo.run(options);
  expect(result.ok, result.logs).toBe(true);
  change(repo, 'packages/lib/index.js', 'fix: refine preview');
  result = repo.run(options);
  expect(result.ok, result.logs).toBe(true);
  const preview = released(
    repo,
    'npm/lib@1.2.0-beta.2',
    'packages/lib/CHANGELOG.md',
  );
  expect(preview).toContain('npm:lib@1.2.0-beta.1');
  expect(preview).toContain('npm:lib@1.1.0');
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'beta');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  result = repo.run(options);
  expect(result.ok, result.logs).toBe(true);
  const stable = released(repo, 'npm/lib@1.2.0', 'packages/lib/CHANGELOG.md');
  expect(stable).toContain('npm:lib@1.1.0');
  expect(stable).toContain('preview library');
  expect(stable).not.toContain('npm:lib@1.2.0-beta');
  const cargo = released(
    repo,
    'cargo/notes-core@1.2.0',
    'crates/core/CHANGELOG.md',
  );
  expect(cargo).toContain('cargo:notes-core@1.1.0');
  expect(cargo).not.toContain('cargo:notes-core@1.2.0-beta');
});

test('native channel promotions preserve changelog snapshots without republishing npm or Cargo', async () => {
  const { repo, service, settings } = await workspace();
  const options = { ...settings, branches: ['main', 'next'] };
  change(repo, 'packages/lib/index.js', 'feat: original library');
  change(repo, 'crates/core/src/lib.rs', 'feat: original crate');
  expect(repo.run(options).ok).toBe(true);
  repo.git(repo.cwd, 'checkout', '-b', 'next');
  repo.git(repo.cwd, 'push', '-u', 'origin', 'next');
  change(
    repo,
    'packages/lib/index.js',
    'feat: future library\n\nBREAKING CHANGE: new library API',
  );
  change(
    repo,
    'crates/core/src/lib.rs',
    'feat: future crate\n\nBREAKING CHANGE: new crate API',
  );
  let result = repo.run(options);
  expect(result.ok, result.logs).toBe(true);
  const before = released(repo, 'npm/lib@2.0.0', 'packages/lib/CHANGELOG.md');
  const cargo = released(
    repo,
    'cargo/notes-core@2.0.0',
    'crates/core/CHANGELOG.md',
  );
  const uploads = service.state().uploads;
  repo.git(repo.cwd, 'checkout', 'main');
  repo.git(repo.cwd, 'merge', '--ff-only', 'next');
  repo.git(repo.cwd, 'push', 'origin', 'main');
  result = repo.run(options);
  expect(result.ok, result.logs).toBe(true);
  expect(JSON.stringify(result.result)).toContain('new crate API');
  expect(JSON.stringify(result.result)).toContain('npm channel: `latest`');
  expect(service.state().uploads).toEqual(uploads);
  expect(released(repo, 'npm/lib@2.0.0', 'packages/lib/CHANGELOG.md')).toBe(
    before,
  );
  expect(
    released(repo, 'cargo/notes-core@2.0.0', 'crates/core/CHANGELOG.md'),
  ).toBe(cargo);
});

test('hard termination recovers newly generated changelogs and preserves user edits before a later retry', async () => {
  const { repo, service, settings } = await workspace();
  const file = join(repo.cwd, 'packages/lib/package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.scripts = {
    prepack: `node -e "if(process.env.BLOCK_PACK==='1'){require('fs').writeFileSync(process.env.READY_PATH,'ready');setInterval(()=>{},1000)}"`,
  };
  writeFileSync(file, JSON.stringify(manifest));
  repo.git(repo.cwd, 'add', '.');
  repo.commit('feat: interrupt generated changelogs');
  const ready = join(service.root, 'ready');
  const options = {
    ...settings,
    env: { ...service.env, BLOCK_PACK: '1', READY_PATH: ready },
  };
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./fixtures/run-release.mjs', import.meta.url)),
      repo.cwd,
      repo.remote,
      fileURLToPath(new URL('../dist/index.mjs', import.meta.url)),
      JSON.stringify(options),
    ],
    { cwd: repo.cwd, env: repo.env, detached: true, stdio: 'ignore' },
  );
  try {
    let reached = false;
    for (let attempt = 0; attempt < 300; attempt++) {
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
  const changelog = join(repo.cwd, 'packages/lib/CHANGELOG.md');
  expect(readFileSync(changelog, 'utf8')).toContain(
    'interrupt generated changelogs',
  );
  writeFileSync(changelog, 'Uncommitted user edits.\n');
  const retryOptions = { ...options, env: { ...options.env, BLOCK_PACK: '0' } };
  let result = repo.run(retryOptions);
  expect(result.codes).toContain('EWORKSPACEDIRTY');
  expect(readFileSync(changelog, 'utf8')).toBe('Uncommitted user edits.\n');
  expect(service.state().uploads).toEqual([]);
  unlinkSync(changelog);
  const outside = join(service.root, 'outside.md');
  writeFileSync(outside, 'Outside file.\n');
  symlinkSync(outside, changelog);
  result = repo.run(retryOptions);
  expect(result.codes).toContain('EWORKSPACEDIRTY');
  expect(readFileSync(outside, 'utf8')).toBe('Outside file.\n');
  unlinkSync(changelog);
  result = repo.run(retryOptions);
  expect(result.ok, result.logs).toBe(true);
  expect(repo.git(repo.cwd, 'status', '--porcelain')).toBe('');
  expect(service.state().uploads).toHaveLength(2);
});

test('dry runs reject ignored source changelogs that are absent from committed history', async () => {
  const { repo, settings } = await workspace();
  writeFileSync(
    join(repo.cwd, '.gitignore'),
    'target/\nCargo.lock\nCHANGELOG.md\n',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: ignore local changelogs');
  change(repo, 'packages/lib/index.js', 'feat: do not release ignored files');
  writeFileSync(
    join(repo.cwd, 'packages/lib/CHANGELOG.md'),
    'Local content outside Git history.\n',
  );
  const refs = repo.refs();
  const result = repo.run({ ...settings, dryRun: true });
  expect(result.ok, result.logs).toBe(false);
  expect(result.codes).toContain('EWORKSPACEDIRTY');
  expect(repo.refs()).toBe(refs);
});

test('reenabling changelogs retains the last generated history across releases with changelogs disabled', async () => {
  const { repo, settings } = await workspace();
  change(repo, 'packages/lib/index.js', 'feat: recorded release');
  expect(repo.run(settings).ok).toBe(true);
  change(
    repo,
    'packages/lib/index.js',
    'fix: release with changelogs disabled',
  );
  let result = repo.run({
    ...settings,
    pluginConfig: { ...settings.pluginConfig, changelog: false },
  });
  expect(result.ok, result.logs).toBe(true);
  change(repo, 'packages/lib/index.js', 'fix: record releases again');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const text = released(repo, 'npm/lib@1.1.2', 'packages/lib/CHANGELOG.md');
  expect(text).toContain('## npm:lib@1.1.0');
  expect(text).toContain('## npm:lib@1.1.2');
  expect(text).not.toContain('## npm:lib@1.1.1');
});

test('Cargo dependency-only releases have explicit crate requirement notes and changelogs', async () => {
  const { repo, service, settings } = await workspace();
  mkdirSync(join(repo.cwd, 'crates/app/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/app/Cargo.toml'),
    '[package]\nname = "notes-app"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Dependent changelog fixture"\n[dependencies]\nnotes-core = { path = "../core", version = "=1.0.0" }\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/app/src/lib.rs'),
    'pub fn value() -> u64 { notes_core::value() as u64 }',
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: add dependent crate');
  change(repo, 'crates/core/src/lib.rs', 'feat: coordinated crate API');
  const result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:notes-core@1.1.0',
    'cargo:notes-app@1.0.1',
  ]);
  const text = released(
    repo,
    'cargo/notes-app@1.0.1',
    'crates/app/CHANGELOG.md',
  );
  expect(text).toContain('### Dependencies');
  expect(text).toContain('cargo:notes-core');
  expect(text).toContain('=1.1.0');
  expect(text).not.toContain('coordinated crate API');
});

test('alternating ecosystem-only dependency releases preserve the entire shared-directory changelog', async () => {
  const { repo, settings } = await workspace();
  writeFileSync(
    join(repo.cwd, 'Cargo.toml'),
    '[workspace]\nmembers = ["packages/lib", "crates/dep"]\nresolver = "3"\n',
  );
  mkdirSync(join(repo.cwd, 'packages/lib/src'));
  mkdirSync(join(repo.cwd, 'crates/dep/src'), { recursive: true });
  writeFileSync(
    join(repo.cwd, 'packages/lib/src/lib.rs'),
    'pub fn value() -> u8 { 1 }',
  );
  writeFileSync(
    join(repo.cwd, 'packages/lib/Cargo.toml'),
    `${readFileSync(join(repo.cwd, 'crates/core/Cargo.toml'), 'utf8')}[dependencies]\nexternal-core = { path = "../../crates/dep", version = "=1.0.0" }\n`,
  );
  writeFileSync(
    join(repo.cwd, 'crates/dep/Cargo.toml'),
    '[package]\nname = "external-core"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Shared history dependency"\n',
  );
  writeFileSync(
    join(repo.cwd, 'crates/dep/src/lib.rs'),
    'pub fn value() -> u8 { 1 }',
  );
  writeFileSync(
    join(repo.cwd, 'packages/lib/package.json'),
    JSON.stringify({
      name: 'lib',
      version: '1.0.0',
      dependencies: { app: '1.0.0' },
    }),
  );
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: shared dependency graphs');
  change(repo, 'crates/dep/src/lib.rs', 'feat: initial external crate');
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  change(repo, 'packages/lib/index.js', 'feat: shared package API');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  change(repo, 'crates/dep/src/lib.rs', 'fix: cargo-only coordinated release');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  expect(
    released(repo, 'cargo/notes-core@1.1.1', 'packages/lib/CHANGELOG.md'),
  ).toContain('## npm:lib@1.1.0');
  change(repo, 'packages/app/index.js', 'fix: npm-only coordinated release');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  const text = released(repo, 'npm/lib@1.1.1', 'packages/lib/CHANGELOG.md');
  expect(text).toContain('## cargo:notes-core@1.1.1');
  expect(text.match(/## npm:lib@1\.1\.0/g)).toHaveLength(1);
});

test('non-UTF-8 changelogs fail before publication or source-byte changes', async () => {
  const { repo, service, settings } = await workspace();
  const file = join(repo.cwd, 'packages/lib/CHANGELOG.md');
  const bytes = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]);
  writeFileSync(file, bytes);
  repo.git(repo.cwd, 'add', '.');
  repo.commit('chore: legacy encoded changelog');
  change(repo, 'packages/lib/index.js', 'feat: validate changelog encoding');
  const refs = repo.refs();
  for (const dryRun of [true, false]) {
    const result = repo.run({ ...settings, dryRun });
    expect(result.ok, result.logs).toBe(false);
    expect(result.codes).toContain('EWORKSPACEDIRTY');
    expect(readFileSync(file)).toEqual(bytes);
    expect(repo.refs()).toBe(refs);
    expect(service.state().uploads).toEqual([]);
  }
});
