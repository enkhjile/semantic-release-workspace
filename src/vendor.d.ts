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

declare module '@npmcli/config' {
  export default class Config {
    constructor(options: Record<string, unknown>);
    load(): Promise<void>;
    flat: Record<string, unknown>;
  }
}
declare module '@npmcli/config/lib/definitions/index.js' {
  const value: Record<string, unknown>;
  export default value;
}
declare module '@npmcli/agent' {
  export function getAgent(url: URL, options: Record<string, unknown>): unknown;
}
declare module 'npm-registry-fetch' {
  const fetch: {
    json(url: string, options: Record<string, unknown>): Promise<unknown>;
    getAuth(
      url: string,
      options: Record<string, unknown>,
    ): { cert?: string; key?: string };
  };
  export default fetch;
}
declare module 'libnpmpublish' {
  const value: {
    publish(
      manifest: Record<string, unknown>,
      bytes: Buffer,
      options: Record<string, unknown>,
    ): Promise<unknown>;
  };
  export default value;
}
