import { expect, test } from 'vitest';
import type { PackagePlan } from '../src/plan-types.js';
import { validatePython } from '../src/python-publication.js';
import { digest } from '../src/release-io.js';

const pkg: PackagePlan = {
  id: 'python:example',
  name: 'example',
  path: '.',
  ecosystem: 'python',
  private: false,
  currentVersion: '0.9.0',
  nextVersion: '1.0.0',
  type: 'major',
  commits: [],
  dependencyUpdates: [],
};
const files = ['example-1.0.0.tar.gz', 'example-1.0.0-py3-none-any.whl'].map(
  (filename) => ({
    filename,
    data: 'YQ==',
    sha256: digest('a'),
  }),
);
function retained(input: typeof files) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: input }));
  const metadata = {
    name: 'example',
    version: '1.0.0',
    sha256: digest(bytes),
    files: input.map(({ filename, sha256 }) => ({ filename, sha256 })),
  };
  return { bytes, metadata };
}
test.each([
  ['missing wheel', files.slice(0, 1)],
  [
    'duplicate sdist',
    files.map((f) => ({ ...f, filename: 'example-1.0.0.tar.gz' })),
  ],
  ['changed checksum', files.map((f) => ({ ...f, sha256: digest('b') }))],
  ['noncanonical encoding', files.map((f) => ({ ...f, data: 'YQ' }))],
  [
    'different package',
    files.map((f) => ({
      ...f,
      filename: f.filename.replace('example', 'other'),
    })),
  ],
  [
    'unexpected filename',
    files.map((f) => ({ ...f, filename: `../${f.filename}` })),
  ],
])('rejects %s before opening an archive', async (_label, value) => {
  const { bytes, metadata } = retained(value as typeof files);
  await expect(validatePython(pkg, bytes, metadata)).rejects.toMatchObject({
    code: 'EWORKSPACEARTIFACT',
  });
});
