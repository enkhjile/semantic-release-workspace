import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { fixture, roots } from './fixtures/repository.js';

const journalRef = 'refs/notes/semantic-release-workspace';

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// Each test may launch several real release processes and Git fetch/push cycles.
describe('real semantic-release lifecycle', { timeout: 60_000 }, () => {
  test('loads via plugins and pushes a completed batch without changing source files', () => {
    const f = fixture();
    const head = f.commit('feat: add a workspace feature');
    const outcome = f.run();
    expect(outcome.ok, outcome.logs).toBe(true);
    expect(outcome.result).toMatchObject({
      nextRelease: {
        type: 'patch',
        version: '1.0.0',
        gitTag: 'workspace-v1.0.0',
      },
    });
    expect(f.tags()).toEqual(['workspace-v1.0.0']);
    expect(f.state()).toMatchObject({
      schemaVersion: 1,
      status: 'complete',
      head,
      baseHead: null,
      batchTag: 'workspace-v1.0.0',
    });
    expect(f.git(f.cwd, 'status', '--porcelain')).toBe('');
    expect(f.git(f.cwd, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(f.cwd, 'package.json'), 'utf8')).toBe(
      '{"name":"fixture","private":true}\n',
    );
  });

  test('dry-run previews a batch without writing remote refs, journals, tags, or files', () => {
    const f = fixture();
    f.commit('feat: preview workspace work');
    const before = f.refs();
    const outcome = f.run({ dryRun: true });
    expect(outcome.ok, outcome.logs).toBe(true);
    expect(outcome.result).toMatchObject({
      nextRelease: {
        type: 'patch',
        gitTag: 'workspace-v1.0.0',
        notes: expect.stringContaining('preview workspace work'),
      },
    });
    expect(f.refs()).toBe(before);
    expect(
      f.git(f.cwd, 'for-each-ref', '--format=%(refname)', journalRef),
    ).toBe('');
    expect(f.git(f.cwd, 'status', '--porcelain')).toBe('');
  });

  test('no-change runs and skipped commits create no batch', () => {
    const f = fixture();
    f.commit('feat: ignored work [skip release]');
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok, outcome.logs).toBe(true);
    expect(outcome.result).toBe(false);
    expect(f.refs()).toBe(before);
  });

  test('completed work is not released again, while later fixes create a patch batch', () => {
    const f = fixture();
    const firstHead = f.commit('feat: first release');
    expect(f.run().ok).toBe(true);
    const before = f.refs();
    expect(f.run().result).toBe(false);
    expect(f.refs()).toBe(before);
    f.commit('docs: describe the workspace');
    expect(f.run().result).toBe(false);
    const head = f.commit('fix: repair workspace behavior');
    expect(f.run().result).toMatchObject({ nextRelease: { version: '1.0.1' } });
    expect(f.state()).toMatchObject({
      status: 'complete',
      head,
      baseHead: firstHead,
    });
  });

  test('fresh checkout retries after a tag was pushed but publication failed', () => {
    const f = fixture();
    const head = f.commit('feat: retry this batch');
    const failed = f.run({ failure: 'publish' });
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('Injected lifecycle failure');
    expect(failed.logs).toContain(
      'Any pending journal is preserved for retry.',
    );
    expect(f.tags()).toEqual(['workspace-v1.0.0']);
    expect(f.state()).toMatchObject({
      status: 'pending',
      head,
      baseHead: null,
    });
    const clone = f.clone();
    const before = f.refs();
    expect(f.run({ dryRun: true }, clone).result).toMatchObject({
      nextRelease: {
        version: '1.0.1',
        notes: expect.stringContaining('retry this batch'),
      },
    });
    expect(f.refs()).toBe(before);
    expect(f.state().status).toBe('pending');
    const retried = f.run({}, clone);
    expect(retried.ok, retried.logs).toBe(true);
    expect(retried.result).toMatchObject({
      commits: [],
      nextRelease: { type: 'patch', gitTag: 'workspace-v1.0.1' },
    });
    expect(f.tags()).toEqual(['workspace-v1.0.0', 'workspace-v1.0.1']);
    expect(f.state()).toMatchObject({
      status: 'complete',
      head,
      baseHead: null,
    });
    expect(f.run({}, clone).result).toBe(false);
  });

  test('failure before preparation writes no checkpoint and can be retried', () => {
    const f = fixture();
    f.commit('feat: work awaiting preparation');
    const before = f.refs();
    expect(f.run({ failure: 'prepare' }).ok).toBe(false);
    expect(f.refs()).toBe(before);
    expect(f.run().result).toMatchObject({
      nextRelease: { gitTag: 'workspace-v1.0.0' },
    });
  });

  test('unfinished work blocks a newer source commit without creating another tag', () => {
    const f = fixture();
    const head = f.commit('feat: unfinished batch');
    expect(f.run({ failure: 'publish' }).ok).toBe(false);
    f.commit('fix: newer work');
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEPENDING');
    expect(f.refs()).toBe(before);
    expect(f.state()).toMatchObject({ status: 'pending', head });
  });

  test('pending preparation survives a failure before core creates its batch tag', () => {
    const f = fixture();
    const head = f.commit('feat: persist preparation before tagging');
    expect(f.run({ failure: 'after-prepare' }).ok).toBe(false);
    expect(f.tags()).toEqual([]);
    expect(f.state()).toMatchObject({ status: 'pending', head });
    const clone = f.clone();
    expect(f.run({}, clone).result).toMatchObject({
      nextRelease: { gitTag: 'workspace-v1.0.0' },
    });
    expect(f.state().status).toBe('complete');
  });

  test('missing journal with existing batch tags is rejected instead of re-releasing history', () => {
    const f = fixture();
    f.commit('feat: protect completed history');
    expect(f.run().ok).toBe(true);
    f.git(f.remote, 'update-ref', '-d', journalRef);
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEJOURNAL');
    expect(f.refs()).toBe(before);
  });

  test('malformed journal fails without modifying any remote ref', () => {
    const f = fixture();
    f.commit('feat: validate durable release state');
    expect(f.run().ok).toBe(true);
    f.git(
      f.remote,
      'notes',
      `--ref=${journalRef}`,
      'add',
      '-f',
      '-m',
      '{broken',
      f.anchor,
    );
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEJOURNAL');
    expect(f.refs()).toBe(before);
  });

  test('journal source must match its completed batch tag', () => {
    const f = fixture();
    f.commit('feat: bind the journal to its release');
    expect(f.run().ok).toBe(true);
    const state = { ...f.state(), head: f.anchor };
    f.git(
      f.remote,
      'notes',
      `--ref=${journalRef}`,
      'add',
      '-f',
      '-m',
      JSON.stringify(state),
      f.anchor,
    );
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEJOURNAL');
    expect(f.refs()).toBe(before);
  });

  test('dirty worktree cannot start a release', () => {
    const f = fixture();
    f.commit('feat: protect source fingerprint');
    writeFileSync(join(f.cwd, 'untracked.txt'), 'uncommitted work');
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEDIRTY');
    expect(f.refs()).toBe(before);
  });

  test.each(['npm', 'pnpm', 'yarn'])(
    'discovers %s workspaces through the real plugin lifecycle',
    (manager) => {
      const f = fixture();
      const definition =
        manager === 'yarn' ? { packages: ['packages/*'] } : ['packages/*'];
      const rootManifest = {
        name: 'fixture',
        private: true,
        ...(manager === 'pnpm' ? {} : { workspaces: definition }),
      };
      writeFileSync(join(f.cwd, 'package.json'), JSON.stringify(rootManifest));
      if (manager === 'pnpm')
        writeFileSync(
          join(f.cwd, 'pnpm-workspace.yaml'),
          'packages: ["packages/*", "!packages/excluded"]',
        );
      for (const [name, isPrivate] of [
        ['public', false],
        ['private', true],
      ] as const) {
        const directory = join(f.cwd, 'packages', name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'package.json'),
          JSON.stringify({ name, private: isPrivate }),
        );
      }
      f.git(f.cwd, 'add', '.');
      f.commit('feat: discover workspace packages');
      const before = f.refs();
      const result = f.run({ dryRun: true });
      expect(result.ok, result.logs).toBe(true);
      expect(result.logs).toContain(
        'Discovered 2 workspace packages (1 publishable).',
      );
      expect(f.refs()).toBe(before);
      expect(f.git(f.cwd, 'status', '--porcelain')).toBe('');
    },
  );

  test.each(['cargo', 'mixed'])(
    '%s discovery runs through real semantic-release without invoking Cargo',
    (kind) => {
      const f = fixture();
      if (kind === 'cargo') rmSync(join(f.cwd, 'package.json'));
      else {
        writeFileSync(
          join(f.cwd, 'package.json'),
          JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
        );
        mkdirSync(join(f.cwd, 'packages/shared'), { recursive: true });
        writeFileSync(
          join(f.cwd, 'packages/shared/package.json'),
          '{"name":"shared"}',
        );
      }
      const cargo =
        '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/excluded"]\n';
      writeFileSync(join(f.cwd, 'Cargo.toml'), cargo);
      for (const [name, policy] of [
        ['shared', 'true'],
        ['internal', 'false'],
      ] as const) {
        const directory = join(f.cwd, 'crates', name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'Cargo.toml'),
          `[package]\nname = "${name}"\npublish = ${policy}\n`,
        );
      }
      mkdirSync(join(f.cwd, 'crates/excluded'), { recursive: true });
      writeFileSync(join(f.cwd, 'crates/excluded/Cargo.toml'), '[broken');
      f.git(f.cwd, 'add', '.');
      f.commit('feat: discover Cargo crates');
      const before = f.refs();
      const outcome = f.run({ dryRun: true });
      expect(outcome.ok, outcome.logs).toBe(true);
      expect(outcome.logs).toContain(
        kind === 'cargo'
          ? 'Discovered 2 workspace packages (1 publishable).'
          : 'Discovered 3 workspace packages (2 publishable).',
      );
      expect(f.refs()).toBe(before);
      expect(f.git(f.cwd, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(f.cwd, 'Cargo.toml'), 'utf8')).toBe(cargo);
      if (kind === 'cargo') {
        expect(f.run().ok).toBe(true);
        expect(f.tags()).toEqual(['workspace-v1.0.0']);
        const completed = f.refs();
        expect(f.run().result).toBe(false);
        expect(f.refs()).toBe(completed);
      }
    },
  );

  test('duplicate Cargo crate names abort real semantic-release before tagging', () => {
    const f = fixture();
    rmSync(join(f.cwd, 'package.json'));
    writeFileSync(
      join(f.cwd, 'Cargo.toml'),
      '[workspace]\nmembers = ["crates/*"]\n',
    );
    for (const [name, policy] of [
      ['a', 'true'],
      ['b', 'false'],
    ] as const) {
      const directory = join(f.cwd, 'crates', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'Cargo.toml'),
        `[package]\nname = "duplicate"\npublish = ${policy}\n`,
      );
    }
    f.git(f.cwd, 'add', '.');
    f.commit('feat: reject duplicate Cargo crates');
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEDUPLICATE');
    expect(f.refs()).toBe(before);
  });

  test('duplicate package names abort real semantic-release before tagging', () => {
    const f = fixture();
    writeFileSync(
      join(f.cwd, 'package.json'),
      JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
    );
    for (const directory of ['a', 'b']) {
      mkdirSync(join(f.cwd, 'packages', directory), { recursive: true });
      writeFileSync(
        join(f.cwd, 'packages', directory, 'package.json'),
        '{"name":"duplicate"}',
      );
    }
    f.git(f.cwd, 'add', '.');
    f.commit('feat: reject invalid inventory');
    const before = f.refs();
    const outcome = f.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACEDUPLICATE');
    expect(f.refs()).toBe(before);
  });

  test('requires an explicit workspace tag namespace', () => {
    const f = fixture();
    f.commit('feat: reject ambiguous tags');
    const before = f.refs();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this placeholder.
    const outcome = f.run({ tagFormat: 'v${version}' });
    expect(outcome.ok).toBe(false);
    expect(outcome.codes).toContain('EWORKSPACECONFIG');
    expect(f.refs()).toBe(before);
  });
});
