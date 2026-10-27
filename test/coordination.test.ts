import { expect, test } from 'vitest';
import { coordinateDependencies } from '../src/dependencies.js';
import type { PackagePlan } from '../src/plan-types.js';
import type { WorkspacePackage } from '../src/workspace-types.js';

function coordinate(
  ecosystem: 'npm' | 'cargo',
  spec: string | null,
  next = '2.0.0',
  section = 'dependencies',
) {
  const packages: WorkspacePackage[] = ['lib', 'consumer'].map((name) => ({
    ecosystem,
    name,
    directory: `/repo/packages/${name}`,
    path: `packages/${name}`,
    manifestPath: `/repo/packages/${name}/${ecosystem === 'npm' ? 'package.json' : 'Cargo.toml'}`,
    private: false,
    manifest: ecosystem === 'npm' ? { name } : { package: { name } },
  }));
  const consumer = packages[1];
  if (!consumer) throw new Error('Missing fixture');
  consumer.manifest[section] =
    ecosystem === 'npm'
      ? { lib: spec }
      : {
          lib: { path: '../lib', ...(spec === null ? {} : { version: spec }) },
        };
  const plans: PackagePlan[] = packages.map((pkg, index) => ({
    id: `${ecosystem}:${pkg.name}`,
    ecosystem,
    name: pkg.name,
    path: pkg.path,
    private: false,
    currentVersion: '1.0.0',
    nextVersion: index === 0 ? next : null,
    type: index === 0 ? 'major' : null,
    commits: [],
    dependencyUpdates: [],
  }));
  const result = coordinateDependencies(
    { root: '/repo', source: 'mixed', packages },
    plans,
    {},
    undefined,
    undefined,
    true,
  );
  return { packages, plans, result };
}

test.each([
  ['npm', '1.0.0', '1.1.0', '1.0.1', '1.1.0'],
  ['cargo', '1.0.0', '1.1.0', null, null],
  ['npm', '^1.0.0', '1.1.0', null, null],
  ['cargo', '>=1, <2', '1.1.0', null, null],
  ['cargo', '1.2.*', '1.3.0', '1.0.1', '1.3.0'],
  ['cargo', '1.*', '2.0.0', '1.0.1', '2.0.0'],
  ['cargo', '^1.0.0', '2.0.0', '1.0.1', '^2.0.0'],
  ['npm', '~1.0.0', '2.0.0', '1.0.1', '~2.0.0'],
  ['npm', 'workspace:^1.0.0', '2.0.0', '1.0.1', 'workspace:^2.0.0'],
  ['npm', 'workspace:^', '1.1.0', '1.0.1', 'workspace:^'],
  ['npm', 'workspace:../lib', '2.0.0', '1.0.1', 'workspace:../lib'],
  ['npm', 'file:../lib', '2.0.0', '1.0.1', 'file:../lib'],
  ['npm', 'link:../lib', '2.0.0', '1.0.1', 'link:../lib'],
  ['cargo', null, '2.0.0', '1.0.1', '2.0.0'],
  ['npm', 'npm:lib@1.0.0', '2.0.0', null, null],
  ['npm', '^9.0.0', '2.0.0', null, null],
] as const)(
  '%s dependency %s with next %s coordinates compatible releases',
  (ecosystem, range, next, want, to) => {
    const { plans } = coordinate(ecosystem, range, next);
    expect(plans[1]?.nextVersion).toBe(want);
    expect(plans[1]?.dependencyUpdates[0]?.to ?? null).toBe(to);
  },
);

test('optional npm dependencies override duplicate dependency declarations', () => {
  const { packages, plans } = coordinate('npm', '1.0.0', '1.1.0');
  const consumer = packages[1];
  if (!consumer) throw new Error('Missing consumer');
  consumer.manifest.optionalDependencies = { lib: '^1.0.0' };
  for (const pkg of plans)
    if (pkg.name === 'consumer') {
      pkg.type = null;
      pkg.nextVersion = null;
      pkg.dependencyUpdates = [];
    }
  coordinateDependencies(
    { root: '/repo', source: 'package.json', packages },
    plans,
    {},
    undefined,
    undefined,
    true,
  );
  expect(plans[1]?.nextVersion).toBeNull();
});

test('synchronization does not downgrade a requirement above the latest released version', () => {
  const { packages, plans } = coordinate('npm', '^5.0.0', '2.1.0');
  if (!packages[0] || !plans[0]) throw new Error('Missing library');
  packages[0].manifest.version = '5.0.0';
  plans[0].currentVersion = '2.0.0';
  coordinateDependencies(
    { root: '/repo', source: 'package.json', packages },
    plans,
    {},
    undefined,
    undefined,
    true,
  );
  expect(plans[1]?.nextVersion).toBeNull();
  expect(plans[1]?.dependencyUpdates).toEqual([]);
});

test.each(['workspace:missing@*', 'workspace:^9.0.0'])(
  'invalid explicit local reference fails: %s',
  (range) => {
    expect(() => coordinate('npm', range)).toThrowError(
      expect.objectContaining({ code: 'EWORKSPACEDEPENDENCY' }),
    );
  },
);

test.each(['garbage', '1 || 2'])(
  'invalid internal Cargo range fails: %s',
  (range) => {
    expect(() => coordinate('cargo', range)).toThrowError(
      expect.objectContaining({ code: 'EWORKSPACEDEPENDENCY' }),
    );
  },
);

test('projected dependency ranges are discarded when a field targets a different package', () => {
  const { packages, plans } = coordinate('cargo', '^1.0.0', '1.1.0');
  const result = coordinateDependencies(
    { root: '/repo', source: 'Cargo.toml', packages },
    plans,
    {},
    [
      {
        dependency: 'cargo:old-lib',
        manifestPath: 'packages/consumer/Cargo.toml',
        field: ['dependencies', 'lib', 'version'],
        from: '^1.0.0',
        to: '^2.0.0',
        publishedRange: '^2.0.0',
      },
    ],
  );
  expect(plans[1]?.nextVersion).toBeNull();
  expect(plans[1]?.dependencyUpdates).toEqual([]);
  expect(result.dependencyRanges).toEqual([]);
});
