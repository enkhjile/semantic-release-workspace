import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('../../dist/index.mjs', import.meta.url));
const runner = fileURLToPath(new URL('./run-release.mjs', import.meta.url));
const journalRef = 'refs/notes/semantic-release-workspace';
export const roots: string[] = [];

interface Outcome {
  ok: boolean;
  result?:
    | false
    | {
        commits: { message: string }[];
        nextRelease: {
          type: string;
          version: string;
          gitTag: string;
          notes: string;
        };
      };
  codes?: string[];
  message?: string;
  logs: string;
}

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'semantic-release-workspace-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const cwd = join(root, 'source');
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (directory: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '-b', 'main', cwd);
  const identity = (directory: string) => {
    git(directory, 'config', 'user.name', 'Lifecycle Test');
    git(directory, 'config', 'user.email', 'lifecycle@example.invalid');
  };
  identity(cwd);
  identity(remote);
  writeFileSync(
    join(cwd, 'package.json'),
    '{"name":"fixture","private":true}\n',
  );
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'chore: initialize fixture');
  git(cwd, 'remote', 'add', 'origin', remote);
  git(cwd, 'push', '-u', 'origin', 'main');
  const anchor = git(cwd, 'rev-parse', 'HEAD');
  return {
    cwd,
    env,
    remote,
    anchor,
    git,
    commit(message: string) {
      git(cwd, 'commit', '--allow-empty', '-m', message);
      git(cwd, 'push', 'origin', 'HEAD');
      return git(cwd, 'rev-parse', 'HEAD');
    },
    clone(branch = 'main', name = 'retry') {
      const directory = join(root, name);
      git(root, 'clone', '--branch', branch, remote, directory);
      identity(directory);
      return directory;
    },
    refs() {
      return git(remote, 'for-each-ref', '--format=%(refname) %(objectname)');
    },
    tags() {
      return git(remote, 'tag', '--list').split('\n').filter(Boolean);
    },
    state(branch = 'main') {
      const ref =
        branch === 'main'
          ? journalRef
          : `refs/notes/workspace-release-branches/${createHash('sha256').update(branch).digest('hex')}`;
      return JSON.parse(git(remote, 'notes', `--ref=${ref}`, 'show', anchor));
    },
    run(
      settings: {
        branches?: (
          | string
          | {
              name: string;
              prerelease?: boolean | string;
              channel?: string | false;
              range?: string;
            }
        )[];
        dryRun?: boolean;
        failure?: 'prepare' | 'after-prepare' | 'publish';
        tagFormat?: string;
        pluginConfig?: Record<string, unknown>;
        env?: Record<string, string>;
      } = {},
      directory = cwd,
    ): Outcome {
      const stdout = execFileSync(
        process.execPath,
        [runner, directory, remote, plugin, JSON.stringify(settings)],
        {
          cwd: directory,
          env,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const line = stdout
        .split('\n')
        .find((entry) => entry.startsWith('RESULT:'));
      if (!line)
        throw new Error(`Release runner did not return a result: ${stdout}`);
      return JSON.parse(line.slice('RESULT:'.length));
    },
  };
}
