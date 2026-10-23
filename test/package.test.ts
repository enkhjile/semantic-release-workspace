import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

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
