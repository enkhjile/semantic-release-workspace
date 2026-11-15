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
  );
  return { packages, plans, result };
}

test.each([
  ['npm', '1.0.0'],
  ['npm', '^1.0.0'],
  ['npm', '~1.0.0'],
  ['npm', 'workspace:^1.0.0'],
  ['npm', 'workspace:^'],
  ['npm', 'workspace:../lib'],
  ['npm', 'file:../lib'],
  ['npm', 'link:../lib'],
  ['npm', 'npm:lib@1.0.0'],
  ['npm', '^9.0.0'],
  ['cargo', '1.0.0'],
  ['cargo', '>=1, <2'],
  ['cargo', '1.2.*'],
  ['cargo', '1.*'],
  ['cargo', '^1.0.0'],
  ['cargo', null],
] as const)(
  '%s dependency %s never releases an unchanged consumer',
  (ecosystem, range) => {
    const { plans } = coordinate(ecosystem, range);
    expect(plans[1]?.nextVersion).toBeNull();
    expect(plans[1]?.dependencyUpdates).toEqual([]);
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
  );
  expect(plans[1]?.nextVersion).toBeNull();
});

test('manual dependency policy does not downgrade a requirement above the latest released version', () => {
  const { packages, plans } = coordinate('npm', '^5.0.0', '2.1.0');
  if (!packages[0] || !plans[0]) throw new Error('Missing library');
  packages[0].manifest.version = '5.0.0';
  plans[0].currentVersion = '2.0.0';
  coordinateDependencies(
    { root: '/repo', source: 'package.json', packages },
    plans,
    {},
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
