import { expect, test } from 'vitest';
import {
  comparableVersion,
  pythonSemver,
  pythonVersion,
  validPackageVersion,
} from '../src/python-versions.js';

test.each([
  ['1', '1.0.0'],
  ['1.2', '1.2.0'],
  ['0.2.3', '0.2.3'],
  ['1.2.3a0', '1.2.3-alpha.0'],
  ['1.2.3b2', '1.2.3-beta.2'],
  ['1.2.3rc10', '1.2.3-rc.10'],
])('maps supported Python %s to %s', (python, semver) => {
  expect(pythonSemver(python)).toBe(semver);
  expect(comparableVersion('python:core', python)).toBe(semver);
  expect(pythonSemver(pythonVersion(semver))).toBe(semver);
  expect(validPackageVersion('python:core', python)).toBe(true);
});
test.each([
  '01.2',
  '1.02',
  '1.2a01',
  '1.0+local',
  '1!2',
  '1.0.post1',
  '1.0.dev1',
  '1.2.3.4',
  '1.0.0-alpha.1',
  'v1.0',
  '1.0a',
  '1.0\n',
  '9007199254740992',
  '1.0a9007199254740992',
  null,
])('rejects unsupported Python version %s', (value) => {
  expect(pythonSemver(value)).toBeNull();
  expect(validPackageVersion('python:core', value)).toBe(false);
});
test('keeps npm/Cargo SemVer validation unchanged', () => {
  for (const id of ['npm:core', 'cargo:core']) {
    expect(validPackageVersion(id, '1.2.3-alpha.1')).toBe(true);
    expect(validPackageVersion(id, '1.2.3a1')).toBe(false);
    expect(validPackageVersion(id, '1.2')).toBe(false);
    expect(comparableVersion(id, '1.2.3-alpha.1')).toBe('1.2.3-alpha.1');
  }
});
