import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { archiveFile } from '../src/archive.js';
import { registry, servers } from './fixtures/registry.js';
import { fixture, roots } from './fixtures/repository.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test.each([
  { ecosystem: 'npm', override: false },
  { ecosystem: 'cargo', override: false },
  { ecosystem: 'npm', override: true },
])(
  '$ecosystem relocation uses the correct changelog history (committed override: $override)',
  async ({ ecosystem, override }) => {
    const repo = fixture();
    const service = await registry();
    const file = (path: string, contents: string) => {
      mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
      writeFileSync(join(repo.cwd, path), contents);
    };
    const commit = (message: string) => {
      repo.git(repo.cwd, 'add', '.');
      repo.commit(message);
    };
    const previousPath = ecosystem === 'npm' ? 'packages/app' : 'crates/app';
    const manifest = ecosystem === 'npm' ? 'package.json' : 'Cargo.toml';
    const configure = (path: string) => {
      if (ecosystem === 'npm')
        file(
          'package.json',
          JSON.stringify({ private: true, workspaces: [path] }),
        );
      else
        file(
          'Cargo.toml',
          `[workspace]\nmembers = ["${path}"]\nresolver = "3"\n`,
        );
    };
    configure(previousPath);
    if (ecosystem === 'npm') {
      file(`${previousPath}/${manifest}`, '{"name":"app","version":"1.0.0"}\n');
      file(`${previousPath}/index.js`, 'export const value = 1;\n');
    } else {
      file(
        '.cargo/config.toml',
        `[registries.fixture]\nindex = "sparse+${service.url}/cargo/index/"\n`,
      );
      file('.gitignore', 'target/\nCargo.lock\n');
      file(
        `${previousPath}/${manifest}`,
        '[package]\nname = "app"\nversion = "1.0.0"\nedition = "2024"\nlicense = "MIT"\ndescription = "Changelog relocation fixture"\n',
      );
      file(`${previousPath}/src/lib.rs`, 'pub fn value() -> u8 { 1 }\n');
    }
    commit('feat: introduce original behavior');
    const settings = {
      env: service.env,
      pluginConfig: {
        publish: true,
        changelog: true,
        npm: { registry: service.url },
        cargo: { registry: 'fixture' },
      },
    };
    const first = repo.run(settings);
    expect(first.ok, first.logs).toBe(true);
    expect(
      repo.git(
        repo.remote,
        'show',
        `${ecosystem}/app@1.1.0:${previousPath}/CHANGELOG.md`,
      ),
    ).toContain('introduce original behavior');

    mkdirSync(join(repo.cwd, 'apps'));
    renameSync(join(repo.cwd, previousPath), join(repo.cwd, 'apps/app'));
    configure('apps/app');
    const source = '# Changelog\n\nReplacement history at the new location.\n';
    if (override) file('apps/app/CHANGELOG.md', source);
    commit('fix: relocate application');
    const clone = repo.clone();
    const before = readFileSync(join(clone, 'apps/app', manifest), 'utf8');
    const second = repo.run(settings, clone);
    expect(second.ok, second.logs).toBe(true);
    const text = await archiveFile(
      Buffer.from(service.state()[ecosystem].app['1.1.1'].artifact, 'base64'),
      `${ecosystem === 'npm' ? 'package' : 'app-1.1.1'}/CHANGELOG.md`,
    );
    expect(text).toContain(`${ecosystem}:app@1.1.1`);
    expect(text).toContain('relocate application');
    if (override) {
      expect(text).toContain('Replacement history at the new location.');
      expect(text).not.toContain(`${ecosystem}:app@1.1.0`);
      expect(readFileSync(join(clone, 'apps/app/CHANGELOG.md'), 'utf8')).toBe(
        source,
      );
    } else {
      expect(text).toContain(`${ecosystem}:app@1.1.0`);
      expect(text).toContain('introduce original behavior');
      expect(existsSync(join(clone, 'apps/app/CHANGELOG.md'))).toBe(false);
    }
    expect(readFileSync(join(clone, 'apps/app', manifest), 'utf8')).toBe(
      before,
    );
    expect(repo.git(clone, 'status', '--porcelain')).toBe('');
  },
  120_000,
);

test('co-locating, splitting and reuniting packages preserves each changelog entry once', async () => {
  const repo = fixture();
  const service = await registry();
  const file = (path: string, contents: string) => {
    mkdirSync(join(repo.cwd, path, '..'), { recursive: true });
    writeFileSync(join(repo.cwd, path), contents);
  };
  const commit = (message: string) => {
    repo.git(repo.cwd, 'add', '.');
    repo.commit(message);
  };
  file('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
  file('packages/app/package.json', '{"name":"app","version":"1.0.0"}\n');
  file('packages/app/index.js', 'export const value = 1;\n');
  file('Cargo.toml', '[workspace]\nmembers=["crates/app"]\nresolver="3"\n');
  file(
    'crates/app/Cargo.toml',
    '[package]\nname="app"\nversion="1.0.0"\nedition="2024"\nlicense="MIT"\ndescription="Converging changelog fixture"\n',
  );
  file('crates/app/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  file('.gitignore', 'target/\nCargo.lock\n');
  file(
    '.cargo/config.toml',
    `[registries.fixture]\nindex="sparse+${service.url}/cargo/index/"\n`,
  );
  commit('feat: original independent package histories');
  const settings = {
    env: service.env,
    pluginConfig: {
      publish: true,
      changelog: true,
      npm: { registry: service.url },
      cargo: { registry: 'fixture' },
    },
  };
  const first = repo.run(settings);
  expect(first.ok, first.logs).toBe(true);
  renameSync(
    join(repo.cwd, 'crates/app/Cargo.toml'),
    join(repo.cwd, 'packages/app/Cargo.toml'),
  );
  renameSync(
    join(repo.cwd, 'crates/app/src'),
    join(repo.cwd, 'packages/app/src'),
  );
  file('Cargo.toml', '[workspace]\nmembers=["packages/app"]\nresolver="3"\n');
  commit('fix: colocate package implementations');
  const clone = repo.clone();
  const second = repo.run(settings, clone);
  expect(second.ok, second.logs).toBe(true);
  for (const ecosystem of ['npm', 'cargo']) {
    const text = await archiveFile(
      Buffer.from(service.state()[ecosystem].app['1.1.1'].artifact, 'base64'),
      `${ecosystem === 'npm' ? 'package' : 'app-1.1.1'}/CHANGELOG.md`,
    );
    for (const id of ['npm:app', 'cargo:app'])
      for (const version of ['1.1.0', '1.1.1'])
        expect(
          text.match(
            new RegExp(`## ${id}@${version.replaceAll('.', '\\.')}`, 'g'),
          ) ?? [],
          `${id}@${version}`,
        ).toHaveLength(1);
  }
  expect(existsSync(join(clone, 'packages/app/CHANGELOG.md'))).toBe(false);
  expect(repo.git(clone, 'status', '--porcelain')).toBe('');

  mkdirSync(join(repo.cwd, 'crates/app'), { recursive: true });
  renameSync(
    join(repo.cwd, 'packages/app/Cargo.toml'),
    join(repo.cwd, 'crates/app/Cargo.toml'),
  );
  renameSync(
    join(repo.cwd, 'packages/app/src'),
    join(repo.cwd, 'crates/app/src'),
  );
  file('Cargo.toml', '[workspace]\nmembers=["crates/app"]\nresolver="3"\n');
  commit('fix: split package implementations');
  let result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  file('packages/app/index.js', 'export const value = 2;\n');
  commit('fix: improve npm independently');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  file('crates/app/src/lib.rs', 'pub fn value() -> u8 { 2 }\n');
  commit('fix: improve Cargo independently');
  result = repo.run(settings);
  expect(result.ok, result.logs).toBe(true);
  renameSync(
    join(repo.cwd, 'crates/app/Cargo.toml'),
    join(repo.cwd, 'packages/app/Cargo.toml'),
  );
  renameSync(
    join(repo.cwd, 'crates/app/src'),
    join(repo.cwd, 'packages/app/src'),
  );
  file('Cargo.toml', '[workspace]\nmembers=["packages/app"]\nresolver="3"\n');
  commit('fix: reunite package implementations');
  const reunited = repo.clone('main', 'reunited');
  result = repo.run(settings, reunited);
  expect(result.ok, result.logs).toBe(true);
  for (const ecosystem of ['npm', 'cargo']) {
    const text = await archiveFile(
      Buffer.from(service.state()[ecosystem].app['1.1.4'].artifact, 'base64'),
      `${ecosystem === 'npm' ? 'package' : 'app-1.1.4'}/CHANGELOG.md`,
    );
    for (const id of ['npm:app', 'cargo:app'])
      for (const version of ['1.1.0', '1.1.1', '1.1.2', '1.1.3', '1.1.4'])
        expect(
          text.match(
            new RegExp(`## ${id}@${version.replaceAll('.', '\\.')}`, 'g'),
          ) ?? [],
          `${id}@${version}`,
        ).toHaveLength(1);
  }
  expect(existsSync(join(reunited, 'packages/app/CHANGELOG.md'))).toBe(false);
  expect(repo.git(reunited, 'status', '--porcelain')).toBe('');
}, 120_000);
