import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { minVersion, satisfies } from 'semver';
import { expect, test } from 'vitest';

test.each(['semantic-release', 'tsdown'])(
  'the declared Node minimum supports %s',
  (dependency) => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const required = createRequire(import.meta.url)(
      `${dependency}/package.json`,
    );
    const minimum = minVersion(manifest.engines.node);
    expect(satisfies(minimum ?? '', required.engines.node)).toBe(true);
  },
);

test('the built package can be imported by Node through its public export', () => {
  expect(() =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "await import('semantic-release-workspace');",
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: 'pipe',
      },
    ),
  ).not.toThrow();
});

// Keep the published support range above the security floors on each release line.
test.each([
  ['24.22.2', false],
  ['24.22.3', true],
  ['24.23.0', true],
  ['25.0.0', false],
  ['26.0.0', false],
  ['26.13.0', false],
  ['26.13.1', true],
  ['27.0.0', true],
])('Node %s support is %s', (version, supported) => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  expect(satisfies(version, manifest.engines.node)).toBe(supported);
});

test('CI derives the exact minimum from the compound Node range', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const workflow = readFileSync(
    new URL('../.github/workflows/verify.yml', import.meta.url),
    'utf8',
  );
  const expressions = [...workflow.matchAll(/jq -r '([^']+)' package.json/g)];
  expect(expressions).toHaveLength(2);
  for (const [, expression] of expressions) {
    const minimum = execFileSync('jq', ['-r', expression ?? ''], {
      input: JSON.stringify(manifest),
      encoding: 'utf8',
    }).trim();
    expect(minimum).toBe(minVersion(manifest.engines.node)?.version);
    expect(
      satisfies(manifest.devEngines.runtime.version, manifest.engines.node),
    ).toBe(true);
  }
});
