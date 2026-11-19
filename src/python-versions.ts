import SemanticReleaseError from '@semantic-release/error';
import { valid } from 'semver';

// A bounded PEP 440 subset that maps losslessly to the planner's SemVer bumps.
// Keep Python spelling in plans/tags; convert only at comparison boundaries.
export function pythonSemver(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:(a|b|rc)(0|[1-9]\d*))?$/.exec(
      value,
    );
  if (!match || match[0] !== value) return null;
  const [, major, minor = '0', patch = '0', stage, iteration] = match;
  if (iteration !== undefined && !Number.isSafeInteger(Number(iteration)))
    return null;
  const pre = stage === 'a' ? 'alpha' : stage === 'b' ? 'beta' : stage;
  const result = `${major}.${minor}.${patch}${pre ? `-${pre}.${iteration}` : ''}`;
  return valid(result) === result ? result : null;
}
export function pythonVersion(version: string): string {
  const result = version.replace(
    /-(alpha|beta|rc)\.(\d+)$/,
    (_, pre: string, n: string) =>
      `${pre === 'alpha' ? 'a' : pre === 'beta' ? 'b' : 'rc'}${n}`,
  );
  if (pythonSemver(result) === null)
    throw new SemanticReleaseError(
      'Cannot represent the planned Python version.',
      'EWORKSPACEVERSION',
    );
  return result;
}
export function comparableVersion(id: string, version: string): string {
  if (!id.startsWith('python:')) return version;
  const parsed = pythonSemver(version);
  if (parsed === null)
    throw new SemanticReleaseError(
      `Unsupported Python version for ${id}.`,
      'EWORKSPACEVERSION',
    );
  return parsed;
}
export function validPackageVersion(
  id: string,
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    (id.startsWith('python:')
      ? pythonSemver(value) !== null
      : valid(value) === value)
  );
}
