export type ReleaseType = 'major' | 'minor' | 'patch';
export interface Commit {
  hash: string;
  message: string;
}
export interface PackageVersion {
  id: string;
  version: string;
  head: string;
}
export interface DependencyUpdate {
  dependency: string;
  manifestPath: string;
  field: string[];
  from: string | null;
  to: string;
  publishedRange: string;
}
export interface PackagePlan {
  id: string;
  ecosystem: 'npm' | 'cargo';
  name: string;
  path: string;
  private: boolean;
  currentVersion: string | null;
  nextVersion: string | null;
  type: ReleaseType | null;
  commits: Commit[];
  dependencyUpdates: DependencyUpdate[];
}
export interface ReleasePlan {
  schemaVersion: 1;
  head: string;
  baseHead: string | null;
  packages: PackagePlan[];
  groups: string[][];
}

export interface PlanningState {
  plan: ReleasePlan;
  versions: PackageVersion[];
  dependencyRanges: DependencyUpdate[];
}
