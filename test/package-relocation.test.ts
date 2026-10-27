import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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

function workspace() {
  const repo = fixture({ synchronizeDependents: true });
  return {
    ...repo,
    file(path: string, content: string) {
      mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
      writeFileSync(join(repo.cwd, path), content);
    },
    change(message: string) {
      repo.git(repo.cwd, 'add', '.');
      return repo.commit(message);
    },
  };
}

test('moved npm packages retain published dependency ranges through dry runs and fresh-clone retries until explicitly edited', async () => {
  const repo = workspace();
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, npm: { registry: service.url } },
  };
  const publishedManifest = async (version: string) =>
    JSON.parse(
      await archiveFile(
        Buffer.from(service.state().npm.app[version].artifact, 'base64'),
        'package/package.json',
      ),
    );
  repo.file(
    'package.json',
    JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }),
  );
  repo.file('packages/lib/package.json', '{"name":"lib","version":"1.0.0"}');
  repo.file('packages/lib/index.js', 'export const value = 1;\n');
  repo.file(
    'packages/app/package.json',
    '{"name":"app","version":"1.0.0","dependencies":{"lib":"1.0.0"}}',
  );
  repo.file('packages/app/index.js', 'export const app = 1;\n');
  repo.change('chore: set up packages');
  repo.file('packages/lib/index.js', 'export const replacement = 2;\n');
  repo.change('feat: replace library API\n\nBREAKING CHANGE: replace API');
  const first = repo.run(settings);
  expect(first.ok, first.logs).toBe(true);
  expect((await publishedManifest('1.0.1')).dependencies.lib).toBe('2.0.0');

  mkdirSync(join(repo.cwd, 'apps'));
  renameSync(join(repo.cwd, 'packages/app'), join(repo.cwd, 'apps/app'));
  repo.change('fix: relocate application');
  const source = readFileSync(join(repo.cwd, 'apps/app/package.json'), 'utf8');
  const refs = repo.refs();
  const uploads = service.state().uploads;
  const dry = repo.run({ ...settings, dryRun: true });
  expect(dry.ok, dry.logs).toBe(true);
  expect(repo.refs()).toBe(refs);
  expect(service.state().uploads).toEqual(uploads);
  expect(readFileSync(join(repo.cwd, 'apps/app/package.json'), 'utf8')).toBe(
    source,
  );

  service.control('reject');
  const failed = repo.run(settings);
  expect(failed.ok).toBe(false);
  expect(failed.codes, failed.logs).toContain('EWORKSPACEPUBLISH');
  const pending = repo.state();
  const artifact = pending.execution.packages.find(
    (pkg: { id: string }) => pkg.id === 'npm:app',
  ).artifact;
  service.control('');
  const clone = repo.clone();
  const retry = repo.run(settings, clone);
  expect(retry.ok, retry.logs).toBe(true);
  expect((await publishedManifest('1.0.2')).dependencies.lib).toBe('2.0.0');
  expect(repo.state().planning.plan).toEqual(pending.planning.plan);
  expect(
    repo
      .state()
      .execution.packages.find((pkg: { id: string }) => pkg.id === 'npm:app')
      .artifact,
  ).toEqual(artifact);
  expect(readFileSync(join(clone, 'apps/app/package.json'), 'utf8')).toBe(
    source,
  );
  expect(repo.git(clone, 'status', '--porcelain')).toBe('');
  expect(
    service
      .state()
      .uploads.filter((value: string) => value === 'npm:app@1.0.2'),
  ).toHaveLength(1);

  repo.file(
    'apps/app/package.json',
    '{"name":"app","version":"1.0.0","dependencies":{"lib":"^1.0.0"}}',
  );
  repo.change('fix: explicitly select the earlier registry API');
  const edited = repo.run(settings, repo.clone('main', 'edited'));
  expect(edited.ok, edited.logs).toBe(true);
  expect((await publishedManifest('1.0.3')).dependencies.lib).toBe('^1.0.0');
});

test('moving a Cargo package to the workspace root retains its own and shared dependency ranges in the published crate', async () => {
  const repo = workspace();
  const service = await registry();
  const settings = {
    env: service.env,
    pluginConfig: { publish: true, cargo: { registry: 'fixture' } },
  };
  const packageSection =
    '[package]\nname = "relocated-app"\nversion = "1.0.0"\nedition = "2024"\npublish = ["fixture"]\nlicense = "MIT"\ndescription = "fixture"\n';
  const shared =
    '[workspace.dependencies]\nshared = { package = "shared-lib", path = "crates/shared", version = "=1.0.0", registry = "fixture" }\n';
  repo.file(
    '.cargo/config.toml',
    `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
  );
  repo.file(
    'Cargo.toml',
    `[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n${shared}`,
  );
  repo.file(
    'crates/app/Cargo.toml',
    `${packageSection}[dependencies]\nlocal = { package = "local-lib", path = "../local", version = "=1.0.0", registry = "fixture" }\nshared.workspace = true\n`,
  );
  repo.file(
    'crates/app/src/lib.rs',
    'pub fn app() -> u32 { local::value() + shared::value() }\n',
  );
  for (const name of ['local', 'shared']) {
    repo.file(
      `crates/${name}/Cargo.toml`,
      `[package]\nname = "${name}-lib"\nversion = "1.0.0"\nedition = "2024"\npublish = ["fixture"]\nlicense = "MIT"\ndescription = "fixture"\n`,
    );
    repo.file(`crates/${name}/src/lib.rs`, 'pub fn value() -> u32 { 1 }\n');
  }
  repo.change('chore: set up Cargo workspace');
  for (const name of ['local', 'shared'])
    repo.file(`crates/${name}/src/lib.rs`, 'pub fn value() -> u32 { 2 }\n');
  repo.change('feat: replace library APIs\n\nBREAKING CHANGE: replace APIs');
  const first = repo.run(settings);
  expect(first.ok, first.logs).toBe(true);
  expect(service.state().uploads).toEqual([
    'cargo:local-lib@2.0.0',
    'cargo:shared-lib@2.0.0',
    'cargo:relocated-app@1.0.1',
  ]);

  renameSync(join(repo.cwd, 'crates/app/src'), join(repo.cwd, 'src'));
  rmSync(join(repo.cwd, 'crates/app'), { recursive: true });
  repo.file(
    'Cargo.toml',
    `[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n${shared}${packageSection}[dependencies]\nlocal = { package = "local-lib", path = "crates/local", version = "=1.0.0", registry = "fixture" }\nshared.workspace = true\n`,
  );
  repo.change('fix: relocate application to workspace root');
  const clone = repo.clone();
  const second = repo.run(settings, clone);
  expect(second.ok, second.logs).toBe(true);
  const artifact = Buffer.from(
    service.state().cargo['relocated-app']['1.0.2'].artifact,
    'base64',
  );
  const manifest = parse(
    await archiveFile(artifact, 'relocated-app-1.0.2/Cargo.toml'),
  );
  expect(manifest.dependencies).toMatchObject({
    local: { version: '=2.0.0' },
    shared: { version: '=2.0.0' },
  });
  expect(
    repo.git(repo.remote, 'show', 'cargo/relocated-app@1.0.2:Cargo.toml'),
  ).toContain('version = "=2.0.0"');
  expect(readFileSync(join(clone, 'Cargo.toml'), 'utf8')).toContain(
    'version = "=1.0.0"',
  );
  expect(repo.git(clone, 'status', '--porcelain')).toBe('');
});

test('moving a root Cargo package keeps shared projections at the root and respects explicit source edits', () => {
  const repo = workspace();
  const shared =
    '[workspace.dependencies]\nshared = { package = "lib", path = "crates/lib", version = "=1.0.0" }\n';
  const application = '[package]\nname = "app"\nversion = "1.0.0"\n';
  repo.file(
    'Cargo.toml',
    `[workspace]\nmembers = ["crates/*"]\n${shared}${application}[dependencies]\ndirect = { package = "lib", path = "crates/lib", version = "=1.0.0" }\nshared.workspace = true\n`,
  );
  repo.file('src/lib.rs', 'pub fn app() {}\n');
  repo.file(
    'crates/lib/Cargo.toml',
    '[package]\nname = "lib"\nversion = "1.0.0"\n',
  );
  repo.file('crates/lib/src/lib.rs', 'pub fn original() {}\n');
  repo.change('chore: set up root Cargo package');
  repo.file('crates/lib/src/lib.rs', 'pub fn replacement() {}\n');
  repo.change('feat: replace API\n\nBREAKING CHANGE: remove original API');
  const first = repo.run();
  expect(first.ok, first.logs).toBe(true);

  mkdirSync(join(repo.cwd, 'apps/app'), { recursive: true });
  renameSync(join(repo.cwd, 'src'), join(repo.cwd, 'apps/app/src'));
  repo.file(
    'Cargo.toml',
    `[workspace]\nmembers = ["crates/*", "apps/*"]\n${shared}`,
  );
  const manifest = `${application}[dependencies]\ndirect = { package = "lib", path = "../../crates/lib", version = "=1.0.0" }\nshared.workspace = true\n`;
  repo.file('apps/app/Cargo.toml', manifest);
  repo.change('fix: relocate root application');
  const moved = repo.run({}, repo.clone());
  expect(moved.ok, moved.logs).toBe(true);
  const app = repo
    .state()
    .planning.plan.packages.find(
      (pkg: { id: string }) => pkg.id === 'cargo:app',
    );
  expect(app.dependencyUpdates).toEqual(
    expect.arrayContaining([
      {
        dependency: 'cargo:lib',
        manifestPath: 'apps/app/Cargo.toml',
        field: ['dependencies', 'direct', 'version'],
        from: '=1.0.0',
        to: '=2.0.0',
        publishedRange: '=2.0.0',
      },
      {
        dependency: 'cargo:lib',
        manifestPath: 'Cargo.toml',
        field: ['workspace', 'dependencies', 'shared', 'version'],
        from: '=1.0.0',
        to: '=2.0.0',
        publishedRange: '=2.0.0',
      },
    ]),
  );
  expect(app.dependencyUpdates).toHaveLength(2);

  repo.file(
    'apps/app/Cargo.toml',
    manifest.replace('version = "=1.0.0" }', 'version = "^1.0.0" }'),
  );
  repo.change('fix: explicitly select earlier registry API');
  const edited = repo.run({}, repo.clone('main', 'edited'));
  expect(edited.ok, edited.logs).toBe(true);
  const updated = repo
    .state()
    .planning.plan.packages.find(
      (pkg: { id: string }) => pkg.id === 'cargo:app',
    );
  expect(updated.dependencyUpdates).toMatchObject([
    {
      manifestPath: 'Cargo.toml',
      field: ['workspace', 'dependencies', 'shared', 'version'],
      to: '=2.0.0',
    },
  ]);
});
