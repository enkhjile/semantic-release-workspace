import type { VerifyConditionsContext } from 'semantic-release';
import {
  ciProvider,
  identityForAudience,
  identityToken,
  serviceURL,
} from './npm-identity.js';
import type { Destination } from './publication-state.js';
import { releaseError } from './release-io.js';
import { record } from './workspace-files.js';

export function hasCargoIdentity(env: NodeJS.ProcessEnv): boolean {
  const provider = ciProvider(env);
  return Boolean(
    (provider === 'github' &&
      env.ACTIONS_ID_TOKEN_REQUEST_URL &&
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) ||
      (provider === 'gitlab' && env.CRATES_IO_ID_TOKEN),
  );
}
export function cargoPolicy(
  context: VerifyConditionsContext,
  options: Record<string, unknown>,
  previous?: Destination,
): Pick<Destination, 'cargoAuth'> {
  const setting = options.trustedPublishing ?? 'auto';
  if (![true, false, 'auto'].includes(setting as boolean | string))
    return releaseError(
      'cargo.trustedPublishing must be true, false or auto.',
      'EWORKSPACECONFIG',
    );
  const enabled =
    setting === true ||
    (setting === 'auto' &&
      (previous
        ? previous.cargoAuth === 'oidc'
        : hasCargoIdentity(context.env ?? process.env)));
  return enabled ? { cargoAuth: 'oidc' } : {};
}

export const cargoUserAgent =
  'semantic-release-workspace (https://www.npmjs.com/package/semantic-release-workspace)';
const headers = { 'user-agent': cargoUserAgent, accept: 'application/json' };
// crates.io issues 30-minute tokens and accepts each CI JWT only once. Share
// within one publication invocation, with a conservative five-minute margin.
const usableLifetime = 25 * 60_000;
export function createCargoIdentity(
  context: Pick<VerifyConditionsContext, 'env'>,
) {
  const credentials = new Map<string, { token: string; created: number }>();
  return {
    async token(dest: Destination): Promise<string> {
      try {
        if (dest.cargoAuth !== 'oidc' || !dest.api) throw new Error();
        const api = serviceURL(dest.api).replace(/\/$/, '');
        const existing = credentials.get(api);
        if (existing) {
          if (Date.now() - existing.created >= usableLifetime)
            throw new Error();
          return existing.token;
        }
        const env = context.env ?? process.env;
        if (!hasCargoIdentity(env)) throw new Error();
        const audience = api.replace(/^https?:\/\//, '');
        const jwt =
          ciProvider(env) === 'gitlab'
            ? identityForAudience(env.CRATES_IO_ID_TOKEN ?? '', audience)
            : await identityToken(env, audience);
        const created = Date.now();
        const response = await fetch(
          `${api}/api/v1/trusted_publishing/tokens`,
          {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ jwt }),
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
          },
        );
        const data: unknown = await response.json();
        if (
          !response.ok ||
          !record(data) ||
          typeof data.token !== 'string' ||
          !data.token ||
          !/^[!-~]+$/.test(data.token)
        )
          throw new Error();
        credentials.set(api, { token: data.token, created });
        return data.token;
      } catch {
        return releaseError(
          'Cargo trusted-publisher exchange failed or the in-memory token is too old. Check registry trust, CI identity/audience and id-token permissions; rerun the CI job for fresh credentials.',
          'EWORKSPACEOIDC',
        );
      }
    },
    async close(): Promise<void> {
      let failed = false;
      for (const [api, { token }] of credentials) {
        try {
          const response = await fetch(
            `${api}/api/v1/trusted_publishing/tokens`,
            {
              method: 'DELETE',
              headers: { ...headers, authorization: `Bearer ${token}` },
              redirect: 'error',
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (!response.ok) throw new Error();
        } catch {
          failed = true;
        }
      }
      credentials.clear();
      if (failed)
        return releaseError(
          'Could not revoke a temporary Cargo publishing token. Registry tokens expire after 30 minutes; this batch remains pending for retry.',
          'EWORKSPACEOIDC',
        );
    },
  };
}
