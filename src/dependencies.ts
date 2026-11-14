import { resolve } from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import { satisfies, valid, validRange } from 'semver';
import { packageId } from './attribution.js';
import type { DependencyUpdate, PackagePlan } from './plan-types.js';
import { record } from './workspace-files.js';
import type {
  WorkspaceInventory,
  WorkspacePackage,
} from './workspace-types.js';

interface Edge {
  owner: string;
  target: string;
  ecosystem: 'npm' | 'cargo';
  spec: string | null;
  range: string | null;
  protocol: 'semver' | 'workspace' | 'local';
  alias: boolean;
  manifestPath: string;
  field: string[];
}
function dependencyError(message: string): never {
  throw new SemanticReleaseError(message, 'EWORKSPACEDEPENDENCY');
}
function cargoRange(spec: string): string {
  if (spec.includes('||'))
    dependencyError(`Unsupported Cargo version requirement: ${spec}`);
  return spec
    .split(',')
    .map((part) =>
      /^\s*\d/.test(part) && !part.includes('*')
        ? `^${part.trim()}`
        : part.trim(),
    )
    .join(' ');
}
function normalized(edge: Edge): string | null {
  if (edge.range === null) return null;
  const range =
    edge.ecosystem === 'cargo' ? cargoRange(edge.range) : edge.range;
  if (!validRange(range))
    dependencyError(`Invalid internal dependency range: ${edge.spec}`);
  return range;
}
function npmEdges(
  pkg: WorkspacePackage,
  inventory: WorkspaceInventory,
  plans: Map<string, PackagePlan>,
): Edge[] {
  const edges: Edge[] = [];
  for (const section of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    const table = pkg.manifest[section];
    if (table === undefined) continue;
    if (!record(table))
      dependencyError(`Invalid ${section} in ${packageId(pkg)}.`);
    for (const [name, rawSpec] of Object.entries(table)) {
      if (
        section === 'dependencies' &&
        record(pkg.manifest.optionalDependencies) &&
        name in pkg.manifest.optionalDependencies
      )
        continue;
      if (typeof rawSpec !== 'string')
        dependencyError(`Invalid dependency ${name} in ${packageId(pkg)}.`);
      const manifestPath = `${pkg.path}/package.json`;
      const field = [section, name];
      const spec = rawSpec;
      let targetName = name;
      let range = spec;
      let protocol: Edge['protocol'] = 'semver';
      let alias = false;
      let path: string | undefined;
      if (spec.startsWith('workspace:')) {
        protocol = 'workspace';
        range = spec.slice(10);
        if (range.startsWith('.')) path = resolve(pkg.directory, range);
        else {
          const aliased = range.match(/^(@[^/]+\/[^@]+|[^@]+)@(.+)$/);
          if (aliased) {
            targetName = aliased[1] ?? name;
            range = aliased[2] ?? '*';
            alias = true;
          }
        }
      } else if (/^(?:file:|link:)/.test(spec)) {
        protocol = 'local';
        path = resolve(pkg.directory, spec.slice(spec.indexOf(':') + 1));
      } else if (!validRange(spec)) continue; // Explicit registry aliases, URLs and git references are external.
      const target = inventory.packages.find(
        (candidate) =>
          candidate.ecosystem === 'npm' &&
          (path ? candidate.directory === path : candidate.name === targetName),
      );
      if (!target) {
        if (protocol === 'workspace')
          dependencyError(
            `Missing local workspace dependency ${spec} in ${packageId(pkg)}.`,
          );
        continue;
      }
      range =
        protocol === 'workspace'
          ? spec.slice(alias ? `workspace:${target.name}@`.length : 10)
          : spec;
      const targetPlan = plans.get(packageId(target));
      const current = targetPlan?.currentVersion ?? '1.0.0';
      if (protocol === 'workspace' && ['*', '^', '~'].includes(range))
        range = range === '*' ? '*' : `${range}${current}`;
      if (path) range = '*';
      if (!validRange(range))
        dependencyError(`Unsupported internal workspace reference: ${spec}`);
      const sourceVersion = target.manifest.version;
      const sourceRange = rawSpec.slice(
        alias ? `workspace:${target.name}@`.length : 10,
      );
      const sourceCompatible =
        protocol === 'workspace' &&
        typeof sourceVersion === 'string' &&
        valid(sourceVersion) &&
        (path ||
          ['*', '^', '~'].includes(sourceRange) ||
          (validRange(sourceRange) &&
            satisfies(sourceVersion, sourceRange, {
              includePrerelease: true,
            })));
      if (
        !satisfies(current, range, { includePrerelease: true }) &&
        !(
          targetPlan?.nextVersion &&
          satisfies(targetPlan.nextVersion, range, { includePrerelease: true })
        ) &&
        !sourceCompatible
      ) {
        if (protocol === 'workspace')
          dependencyError(
            `Workspace dependency does not accept its current version: ${spec}`,
          );
        continue; // The requirement selects an external registry version.
      }
      edges.push({
        owner: packageId(pkg),
        target: packageId(target),
        ecosystem: 'npm',
        spec,
        range,
        protocol,
        alias,
        manifestPath,
        field,
      });
    }
  }
  return edges;
}
function cargoEdges(
  pkg: WorkspacePackage,
  inventory: WorkspaceInventory,
  workspace: Record<string, unknown>,
): Edge[] {
  const data = pkg.manifest;
  const tables: { data: Record<string, unknown>; field: string[] }[] = [
    { data, field: [] },
  ];
  if (record(data.target))
    for (const [name, table] of Object.entries(data.target))
      if (record(table)) tables.push({ data: table, field: ['target', name] });
  const edges: Edge[] = [];
  for (const table of tables) {
    for (const aliases of [
      ['dependencies'],
      ['build-dependencies', 'build_dependencies'],
      ['dev-dependencies', 'dev_dependencies'],
    ]) {
      const section = aliases.find((key) => table.data[key] !== undefined);
      if (!section) continue;
      const dependencies = table.data[section];
      if (!record(dependencies))
        dependencyError(`Invalid Cargo dependency table: ${section}`);
      for (const [name, raw] of Object.entries(dependencies)) {
        if (!record(raw)) continue; // Registry-only Cargo dependencies are external.
        let value = raw;
        let directory = pkg.directory;
        let manifestPath = `${pkg.path === '.' ? '' : `${pkg.path}/`}Cargo.toml`;
        let field = [...table.field, section, name];
        if (raw.workspace === true) {
          const inherited = record(workspace.dependencies)
            ? workspace.dependencies[name]
            : undefined;
          if (!record(inherited)) continue;
          value = inherited;
          directory = inventory.root;
          manifestPath = 'Cargo.toml';
          field = ['workspace', 'dependencies', name];
        }
        if (value.path === undefined) continue;
        if (typeof value.path !== 'string' || value.git !== undefined)
          dependencyError(`Invalid Cargo path dependency: ${name}`);
        const path = resolve(directory, value.path);
        const target = inventory.packages.find(
          (candidate) =>
            candidate.ecosystem === 'cargo' && candidate.directory === path,
        );
        if (!target) continue; // Excluded or outside-workspace crates are external to the plan.
        if ((value.package ?? name) !== target.name)
          dependencyError(
            `Cargo dependency ${name} does not match ${target.name}.`,
          );
        if (value.version !== undefined && typeof value.version !== 'string')
          dependencyError(`Invalid Cargo dependency version: ${name}`);
        const source = typeof value.version === 'string' ? value.version : null;
        // Cargo omits path-only dev dependencies from published crates.
        if (section.startsWith('dev') && source === null) continue;
        const spec = source;
        const edge: Edge = {
          owner: packageId(pkg),
          target: packageId(target),
          ecosystem: 'cargo',
          spec,
          range: spec,
          protocol: spec === null ? 'local' : 'semver',
          alias: false,
          manifestPath,
          field: [...field, 'version'],
        };
        normalized(edge);
        edges.push(edge);
      }
    }
  }
  return edges;
}
function update(edge: Edge, target: PackagePlan): DependencyUpdate | undefined {
  const version = target.nextVersion;
  if (!version) return undefined;
  if (edge.protocol === 'semver') return undefined;
  let to = version;
  let publishedRange = version;
  if (edge.protocol === 'workspace') {
    const prefix = edge.alias ? `workspace:${target.name}@` : 'workspace:';
    const raw = (edge.spec ?? '').slice(prefix.length);
    const symbol = raw.startsWith('^') ? '^' : raw.startsWith('~') ? '~' : '';
    const shorthand = ['*', '^', '~'].includes(raw) || raw.startsWith('.');
    if (!shorthand) return undefined;
    to = edge.spec ?? version;
    publishedRange = `${symbol}${version}`;
  } else if (edge.protocol === 'local' && edge.ecosystem === 'npm')
    to = edge.spec ?? version;
  else {
    const operator = edge.spec?.match(/^(\^|~|=)/)?.[1] ?? '';
    to = `${operator}${version}`;
    publishedRange = to;
  }
  if (edge.ecosystem === 'npm' && (edge.alias || edge.field[1] !== target.name))
    publishedRange = `npm:${target.name}@${publishedRange}`;
  return {
    dependency: edge.target,
    manifestPath: edge.manifestPath,
    field: edge.field,
    from: edge.spec,
    to,
    publishedRange,
  };
}
function requiresPlannedVersion(edge: Edge, target: PackagePlan): boolean {
  if (!target.nextVersion) return false;
  if (edge.protocol === 'local') return true;
  if (edge.protocol === 'workspace') {
    const prefix = edge.alias ? `workspace:${target.name}@` : 'workspace:';
    const raw = (edge.spec ?? '').slice(prefix.length);
    if (['*', '^', '~'].includes(raw) || raw.startsWith('.')) return true;
  }
  const range = normalized(edge);
  return range !== null && satisfies(target.nextVersion, range);
}
function groups(packages: PackagePlan[], edges: Edge[]): string[][] {
  const active = new Set(
    packages.filter((pkg) => pkg.type).map((pkg) => pkg.id),
  );
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const result: string[][] = [];
  function visit(id: string) {
    const position = index.size;
    index.set(id, position);
    low.set(id, position);
    stack.push(id);
    stacked.add(id);
    for (const edge of edges.filter(
      (edge) => edge.owner === id && active.has(edge.target),
    )) {
      if (!index.has(edge.target)) {
        visit(edge.target);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(edge.target) ?? 0));
      } else if (stacked.has(edge.target))
        low.set(id, Math.min(low.get(id) ?? 0, index.get(edge.target) ?? 0));
    }
    if (low.get(id) === index.get(id)) {
      const group: string[] = [];
      let item: string | undefined;
      do {
        item = stack.pop();
        if (item) {
          stacked.delete(item);
          group.push(item);
        }
      } while (item !== id);
      result.push(group.sort());
    }
  }
  for (const id of active) if (!index.has(id)) visit(id);
  return result;
}
export function coordinateDependencies(
  inventory: WorkspaceInventory,
  packages: PackagePlan[],
  workspace: Record<string, unknown>,
): {
  groups: string[][];
} {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const edges = inventory.packages.flatMap((pkg) =>
    pkg.ecosystem === 'npm'
      ? npmEdges(pkg, inventory, byId)
      : cargoEdges(pkg, inventory, workspace),
  );
  for (const edge of edges) {
    const target = byId.get(edge.target);
    const owner = byId.get(edge.owner);
    if (!target || !owner?.type) continue;
    const proposed = update(edge, target);
    if (proposed) owner.dependencyUpdates.push(proposed);
  }
  return {
    groups: groups(
      packages,
      edges.filter((edge) => {
        const target = byId.get(edge.target);
        return target !== undefined && requiresPlannedVersion(edge, target);
      }),
    ),
  };
}
