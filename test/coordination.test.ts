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
    manifest:
      ecosystem === 'npm'
        ? { name, version: '1.0.0' }
        : { package: { name, version: '1.0.0' } },
  }));
  const consumer = packages[1];
  if (!consumer) throw new Error('Missing fixture');
  consumer.manifest[section] =
    ecosystem === 'npm'
      ? { lib: spec }
      : {
          lib: { path: '../lib', ...(spec === null ? {} : { version: spec }) },
        };
  const plans: PackagePlan[] = packages.map((pkg) => ({
    id: `${ecosystem}:${pkg.name}`,
    ecosystem,
    name: pkg.name,
    path: pkg.path,
    private: false,
    currentVersion: '1.0.0',
    nextVersion: next,
    type: 'major',
    commits: [],
    dependencyUpdates: [],
  }));
  const result = coordinateDependencies(
    { root: '/repo', source: 'mixed', packages },
    plans,
    {},
  );
  return { packages, plans, result };
}

test.each([
  ['npm', '1.0.0', '1.1.0', '1.1.0'],
  ['cargo', '1.0.0', '1.1.0', null],
  ['npm', '^1.0.0', '1.1.0', null],
  ['cargo', '>=1, <2', '1.1.0', null],
  ['cargo', '1.2.*', '1.3.0', '1.3.0'],
  ['cargo', '1.*', '2.0.0', '2.0.0'],
  ['cargo', '^1.0.0', '2.0.0', '^2.0.0'],
  ['npm', '~1.0.0', '2.0.0', '~2.0.0'],
  ['npm', 'workspace:^1.0.0', '2.0.0', 'workspace:^2.0.0'],
  ['npm', 'workspace:^', '1.1.0', 'workspace:^'],
  ['npm', 'workspace:../lib', '2.0.0', 'workspace:../lib'],
  ['npm', 'file:../lib', '2.0.0', 'file:../lib'],
  ['npm', 'link:../lib', '2.0.0', 'link:../lib'],
  ['cargo', null, '2.0.0', '2.0.0'],
  ['npm', 'npm:lib@1.0.0', '2.0.0', null],
  ['npm', '^9.0.0', '2.0.0', null],
] as const)(
  '%s dependency %s with next %s preserves shared release versions',
  (ecosystem, range, next, to) => {
    const { plans } = coordinate(ecosystem, range, next);
    expect(plans[1]?.nextVersion).toBe(next);
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
      pkg.dependencyUpdates = [];
    }
  coordinateDependencies(
    { root: '/repo', source: 'package.json', packages },
    plans,
    {},
  );
  expect(plans[1]?.nextVersion).toBe('1.1.0');
  expect(plans[1]?.dependencyUpdates).toEqual([]);
});

test('an external range is retained when neither current nor source version satisfies it', () => {
  const { packages, plans } = coordinate('npm', '^5.0.0', '2.1.0');
  if (!packages[0] || !plans[0]) throw new Error('Missing library');
  packages[0].manifest.version = '1.0.0';
  plans[0].currentVersion = '2.0.0';
  coordinateDependencies(
    { root: '/repo', source: 'package.json', packages },
    plans,
    {},
  );
  expect(plans[1]?.nextVersion).toBe('2.1.0');
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

test('source manifest pins remain internal after earlier shared releases', () => {
  const { packages, plans } = coordinate('npm', '1.0.0', '2.0.1');
  for (const plan of plans) {
    plan.currentVersion = '2.0.0';
    plan.dependencyUpdates = [];
  }
  coordinateDependencies(
    { root: '/repo', source: 'package.json', packages },
    plans,
    {},
  );
  expect(plans[1]?.dependencyUpdates[0]?.to).toBe('2.0.1');
});

test('private Cargo consumers stage updated local requirements without a release', () => {
  const { packages, plans } = coordinate('cargo', '=1.0.0', '2.0.0');
  const owner = plans[1];
  if (!owner) throw new Error('Missing consumer');
  owner.private = true;
  owner.type = null;
  owner.nextVersion = null;
  owner.dependencyUpdates = [];
  const result = coordinateDependencies(
    { root: '/repo', source: 'Cargo.toml', packages },
    plans,
    {},
  );
  expect(result.groups).toEqual([['cargo:lib']]);
  expect(result.stagingDependencies).toEqual([
    expect.objectContaining({ to: '=2.0.0' }),
  ]);
  expect(owner.dependencyUpdates).toEqual([]);
  expect(owner.nextVersion).toBeNull();
});

test('cyclic npm dependencies share one publication group without raising the release type', () => {
  const { packages, plans } = coordinate('npm', '^1.0.0', '1.0.1');
  const lib = packages[0];
  if (!lib) throw new Error('Missing library');
  lib.manifest.peerDependencies = { consumer: '1.0.0' };
  for (const plan of plans) plan.type = 'patch';
  const result = coordinateDependencies(
    { root: '/repo', source: 'package.json', packages },
    plans,
    {},
  );
  expect(result.groups).toEqual([['npm:consumer', 'npm:lib']]);
  expect(plans.map((plan) => [plan.type, plan.nextVersion])).toEqual([
    ['patch', '1.0.1'],
    ['patch', '1.0.1'],
  ]);
});
