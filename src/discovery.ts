import { realpath } from 'node:fs/promises';
import SemanticReleaseError from '@semantic-release/error';
import { discoverCargoWorkspaces } from './cargo-discovery.js';
import { discoverJavaScriptWorkspaces } from './javascript-discovery.js';
import type { WorkspaceInventory } from './workspace-types.js';

export async function discoverWorkspaces(
  directory: string,
): Promise<WorkspaceInventory> {
  const root = await realpath(directory);
  const javascript = await discoverJavaScriptWorkspaces(root);
  const cargo = await discoverCargoWorkspaces(root);
  if (!javascript && !cargo)
    throw new SemanticReleaseError(
      'A root package.json or Cargo.toml is required.',
      'EWORKSPACEMANIFEST',
    );
  const packages = [
    ...(javascript?.packages ?? []),
    ...(cargo?.packages ?? []),
  ].sort((a, b) =>
    a.path < b.path
      ? -1
      : a.path > b.path
        ? 1
        : a.ecosystem.localeCompare(b.ecosystem),
  );
  const names = new Map<string, string>();
  for (const pkg of packages) {
    const key = `${pkg.ecosystem}:${pkg.name}`;
    const previous = names.get(key);
    if (previous !== undefined)
      throw new SemanticReleaseError(
        `Duplicate ${pkg.ecosystem} package name ${pkg.name}: ${previous} and ${pkg.path}`,
        'EWORKSPACEDUPLICATE',
      );
    names.set(key, pkg.path);
  }
  return {
    root,
    source:
      cargo && javascript?.source
        ? 'mixed'
        : cargo
          ? 'Cargo.toml'
          : (javascript?.source ?? null),
    packages,
  };
}
