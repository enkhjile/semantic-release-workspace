declare module '@semantic-release/commit-analyzer' {
  export function analyzeCommits(
    config: Record<string, unknown>,
    context: {
      cwd?: string | undefined;
      commits: readonly { hash: string; message: string }[];
      logger: { log(message: string, ...args: unknown[]): void };
    },
  ): Promise<'major' | 'minor' | 'patch' | null>;
}

declare module '@semantic-release/error' {
  export default class SemanticReleaseError extends Error {
    constructor(message: string, code: string, details?: string);
    code: string;
    details: string | undefined;
    semanticRelease: true;
  }
}
