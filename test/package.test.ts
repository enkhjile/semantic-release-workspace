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
