export interface WorkspacePackage {
  ecosystem: 'npm' | 'cargo' | 'python';
  name: string;
  directory: string;
  path: string;
  manifestPath: string;
  private: boolean;
  publish?: boolean | string[];
  manifest: Record<string, unknown>;
}

export interface WorkspaceInventory {
  root: string;
  source:
    | 'pnpm-workspace.yaml'
    | 'package.json'
    | 'Cargo.toml'
    | 'pyproject.toml'
    | 'mixed'
    | null;
  packages: WorkspacePackage[];
}
