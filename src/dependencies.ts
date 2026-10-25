import { resolve } from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import { inc, satisfies, validRange } from 'semver';
import { packageId } from './attribution.js';
import type {
  DependencyUpdate,
  PackagePlan,
  ReleaseType,
} from './plan-types.js';
import { record } from './workspace-files.js';
import type {
  WorkspaceInventory,
  WorkspacePackage,
} from './workspace-types.js';

type Projection = (
  owner: string,
  manifestPath: string,
  field: string[],
  value: string | null,
  dependency: string,
) => string | null;
interface Edge {
  owner: string;
  target: string;
  kind: 'runtime' | 'dev' | 'peer';
  ecosystem: 'npm' | 'cargo';
  spec: string | null;
  source: string | null;
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
  project: Projection,
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
      let spec = rawSpec;
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
      spec =
        project(
          packageId(pkg),
          manifestPath,
          field,
          rawSpec,
          packageId(target),
        ) ?? rawSpec;
      range =
        protocol === 'workspace'
          ? spec.slice(alias ? `workspace:${target.name}@`.length : 10)
          : spec;
      const current = plans.get(packageId(target))?.currentVersion ?? '1.0.0';
      if (protocol === 'workspace' && ['*', '^', '~'].includes(range))
        range = range === '*' ? '*' : `${range}${current}`;
      if (path) range = '*';
      if (!validRange(range))
        dependencyError(`Unsupported internal workspace reference: ${spec}`);
      if (!satisfies(current, range, { includePrerelease: true })) {
        if (protocol === 'workspace')
          dependencyError(
            `Workspace dependency does not accept its current version: ${spec}`,
          );
        continue; // An incompatible ordinary registry requirement does not select this workspace package.
      }
      edges.push({
        owner: packageId(pkg),
        target: packageId(target),
        kind:
          section === 'devDependencies'
            ? 'dev'
            : section === 'peerDependencies'
              ? 'peer'
              : 'runtime',
        ecosystem: 'npm',
        spec,
        source: rawSpec,
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
  project: Projection,
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
        const spec = project(
          packageId(pkg),
          manifestPath,
          [...field, 'version'],
          source,
          packageId(target),
        );
        const edge: Edge = {
          owner: packageId(pkg),
          target: packageId(target),
          kind: section.startsWith('dev') ? 'dev' : 'runtime',
          ecosystem: 'cargo',
          spec,
          source,
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
  const range = normalized(edge);
  if (edge.protocol === 'semver' && range && satisfies(version, range))
    return undefined;
  let to = version;
  let publishedRange = version;
  if (edge.protocol === 'workspace') {
    const prefix = edge.alias ? `workspace:${target.name}@` : 'workspace:';
    const raw = (edge.spec ?? '').slice(prefix.length);
    const symbol = raw.startsWith('^') ? '^' : raw.startsWith('~') ? '~' : '';
    const shorthand = ['*', '^', '~'].includes(raw) || raw.startsWith('.');
    to = shorthand ? (edge.spec ?? version) : `${prefix}${symbol}${version}`;
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
    from: edge.source,
    to,
    publishedRange,
  };
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
  previousRanges: DependencyUpdate[] = [],
  nextVersion: (current: string | null, type: ReleaseType) => string | null = (
    current,
    type,
  ) => (current ? inc(current, type) : '1.0.0'),
): { groups: string[][]; dependencyRanges: DependencyUpdate[] } {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const applied: { owner: string; update: DependencyUpdate }[] = [];
  const key = (manifestPath: string, field: string[]) =>
    JSON.stringify([manifestPath, field]);
  const prior = new Map(
    previousRanges.map((entry) => [
      key(entry.manifestPath, entry.field),
      entry,
    ]),
  );
  const project: Projection = (
    owner,
    manifestPath,
    field,
    value,
    dependency,
  ) => {
    const identity = key(manifestPath, field);
    const previous = prior.get(identity);
    if (
      previous &&
      previous.from === value &&
      previous.dependency === dependency
    ) {
      applied.push({ owner, update: previous });
      return previous.to;
    }
    return value;
  };
  const edges = inventory.packages.flatMap((pkg) =>
    pkg.ecosystem === 'npm'
      ? npmEdges(pkg, inventory, byId, project)
      : cargoEdges(pkg, inventory, workspace, project),
  );
  const rank = { patch: 1, minor: 2, major: 3 };
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const target = byId.get(edge.target);
      const owner = byId.get(edge.owner);
      if (!target || !owner || edge.kind === 'dev' || !update(edge, target))
        continue;
      const required: ReleaseType = edge.kind === 'peer' ? 'major' : 'patch';
      if (!owner.type || rank[owner.type] < rank[required]) {
        owner.type = required;
        owner.nextVersion = nextVersion(owner.currentVersion, required);
        changed = true;
      }
    }
  }
  // Retain matched projections even when their ranges become external.
  // This makes every persisted projection reviewable against the completed plan.
  const retained = new Map<string, DependencyUpdate>();
  for (const { owner: ownerId, update: previous } of applied) {
    const identity = key(previous.manifestPath, previous.field);
    const owner = byId.get(ownerId);
    if (
      owner &&
      !owner.dependencyUpdates.some(
        (entry) => key(entry.manifestPath, entry.field) === identity,
      )
    ) {
      retained.set(identity, previous);
      owner.dependencyUpdates.push(previous);
    }
  }
  for (const edge of edges) {
    const target = byId.get(edge.target);
    const owner = byId.get(edge.owner);
    if (!target || !owner) continue;
    const proposed = update(edge, target);
    if (!proposed) continue;
    const index = owner.dependencyUpdates.findIndex(
      (entry) =>
        key(entry.manifestPath, entry.field) ===
        key(proposed.manifestPath, proposed.field),
    );
    if (index < 0) owner.dependencyUpdates.push(proposed);
    else owner.dependencyUpdates[index] = proposed;
  }
  return {
    groups: groups(packages, edges),
    dependencyRanges: [...retained.values()],
  };
}
