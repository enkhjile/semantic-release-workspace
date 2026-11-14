import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { parse } from 'yaml';
import { fixture, roots } from './fixtures/repository.js';

const workflow = parse(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as {
  jobs: {
    integration: { steps: { id?: string; run?: string }[] };
  };
};
const script = workflow.jobs.integration.steps.find(
  (step) => step.id === 'changes',
)?.run;
if (!script) throw new Error('Missing CI change-classification script.');

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function change(repo: ReturnType<typeof fixture>, path: string) {
  const target = join(repo.cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'Changed content\n');
  repo.git(repo.cwd, 'add', '.');
  repo.git(repo.cwd, 'commit', '-m', 'test: change fixture');
}

function classify(
  repo: ReturnType<typeof fixture>,
  event = 'pull_request',
  base = repo.anchor,
) {
  const output = join(dirname(repo.cwd), 'output');
  writeFileSync(output, '');
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script ?? ''], {
    cwd: repo.cwd,
    env: {
      ...repo.env,
      EVENT_NAME: event,
      BASE_SHA: base,
      HEAD_SHA: repo.git(repo.cwd, 'rev-parse', 'HEAD'),
      RUNNER_TEMP: dirname(repo.cwd),
      GITHUB_OUTPUT: output,
    },
    stdio: 'pipe',
  });
  return readFileSync(output, 'utf8').trim();
}

test('docs-only PRs skip integration, including Markdown with spaces and newlines', () => {
  const repo = fixture();
  for (const path of [
    'README.md',
    'CONTRIBUTING.md',
    'AGENTS.md',
    'docs/nested/guide with spaces\nand newline.md',
  ])
    change(repo, path);
  expect(classify(repo)).toBe('integration=false');
});

test.each([
  'src/index.ts',
  'test/fixtures/README.md',
  'docs/example.mjs',
  'package.json',
  'pnpm-lock.yaml',
  '.github/workflows/ci.yml',
])('a PR changing %s retains integration after a later docs commit', (path) => {
  const repo = fixture();
  change(repo, path);
  change(repo, 'README.md');
  expect(classify(repo)).toBe('integration=true');
});

test('moving code into a documentation path still runs integration', () => {
  const repo = fixture();
  change(repo, 'src/example.ts');
  const base = repo.git(repo.cwd, 'rev-parse', 'HEAD');
  mkdirSync(join(repo.cwd, 'docs'));
  repo.git(repo.cwd, 'mv', 'src/example.ts', 'docs/example.md');
  repo.git(repo.cwd, 'commit', '-m', 'docs: move example');
  expect(classify(repo, 'pull_request', base)).toBe('integration=true');
});

test('base-branch code changes do not turn a docs-only PR into a code change', () => {
  const repo = fixture();
  change(repo, 'src/index.ts');
  const base = repo.git(repo.cwd, 'rev-parse', 'HEAD');
  repo.git(repo.cwd, 'checkout', '-b', 'docs', repo.anchor);
  change(repo, 'README.md');
  expect(classify(repo, 'pull_request', base)).toBe('integration=false');
});

test.each(['push', 'workflow_dispatch'])(
  '%s always runs integration, including docs-only changes',
  (event) => {
    const repo = fixture();
    change(repo, 'README.md');
    expect(classify(repo, event)).toBe('integration=true');
  },
);

test('empty or unavailable comparisons default to full verification', () => {
  const repo = fixture();
  expect(classify(repo)).toBe('integration=true');
  change(repo, 'README.md');
  expect(classify(repo, 'pull_request', 'missing-base')).toBe(
    'integration=true',
  );
});
