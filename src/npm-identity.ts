import npmFetch from 'npm-registry-fetch';
import type { VerifyConditionsContext } from 'semantic-release';
import type { Destination } from './publication-state.js';
import { releaseError } from './release-io.js';
import { record } from './workspace-files.js';

export function ciProvider(
  env: NodeJS.ProcessEnv,
): 'github' | 'gitlab' | 'circleci' | undefined {
  if (env.GITHUB_ACTIONS === 'true') return 'github';
  if (env.GITLAB_CI === 'true') return 'gitlab';
  if (env.CIRCLECI === 'true') return 'circleci';
  return undefined;
}
export function hasIdentity(env: NodeJS.ProcessEnv): boolean {
  const provider = ciProvider(env);
  return Boolean(
    provider &&
      (env.NPM_ID_TOKEN ||
        (provider === 'github' &&
          env.ACTIONS_ID_TOKEN_REQUEST_URL &&
          env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)),
  );
}
export function serviceURL(value: unknown): string {
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
        ))
    )
      throw new Error();
    return url.href;
  } catch {
    return releaseError(
      'Identity and Sigstore services require HTTPS (HTTP is allowed only on loopback).',
      'EWORKSPACEOIDC',
    );
  }
}
// Check routing before disclosing identities; registries verify signatures.
export function identityForAudience(token: string, audience: string): string {
  try {
    const parts = token.split('.');
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    );
    if (
      parts.length !== 3 ||
      !parts.every(Boolean) ||
      !record(claims) ||
      !(
        claims.aud === audience ||
        (Array.isArray(claims.aud) &&
          claims.aud.every((value) => typeof value === 'string') &&
          claims.aud.includes(audience))
      )
    )
      throw new Error();
    return token;
  } catch {
    return releaseError(
      'The supplied CI identity must match the destination audience. Check the ID token audience configuration.',
      'EWORKSPACEOIDC',
    );
  }
}
export async function identityToken(
  env: NodeJS.ProcessEnv,
  audience: string,
): Promise<string> {
  try {
    if (audience.startsWith('npm:') && env.NPM_ID_TOKEN && ciProvider(env))
      return identityForAudience(env.NPM_ID_TOKEN, audience);
    if (
      audience === 'sigstore' &&
      env.SIGSTORE_ID_TOKEN &&
      ['github', 'gitlab'].includes(ciProvider(env) ?? '')
    )
      return env.SIGSTORE_ID_TOKEN;
    if (ciProvider(env) !== 'github' || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
      throw new Error();
    const url = new URL(serviceURL(env.ACTIONS_ID_TOKEN_REQUEST_URL));
    url.searchParams.set('audience', audience);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
        accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const data: unknown = await response.json();
    if (
      !response.ok ||
      !record(data) ||
      typeof data.value !== 'string' ||
      !data.value
    )
      throw new Error();
    return identityForAudience(data.value, audience);
  } catch {
    return releaseError(
      'Cannot obtain CI identity. Check the supported provider, audience and id-token permissions.',
      'EWORKSPACEOIDC',
    );
  }
}
export async function publishingOptions(
  context: VerifyConditionsContext,
  dest: Destination,
  name: string,
  opts: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (dest.npmAuth !== 'oidc') return opts;
  try {
    const token = await identityToken(
      context.env ?? process.env,
      `npm:${new URL(dest.registry).hostname}`,
    );
    let requests = 0;
    const agent = opts.agent as (target: { href: string }) => unknown;
    const exchangeAgent = (target: { href: string }) => {
      if (++requests > 1)
        return releaseError(
          'npm identity exchange redirects are forbidden.',
          'EWORKSPACEOIDC',
        );
      return agent(target);
    };
    const data: unknown = await npmFetch.json(
      `${dest.registry}/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`,
      { ...opts, agent: exchangeAgent, method: 'POST', forceAuth: { token } },
    );
    if (!record(data)) throw new Error();
    // npm returns Unix seconds; also accept documented ISO timestamps.
    const expires =
      typeof data.expires === 'number'
        ? data.expires * 1000
        : typeof data.expires === 'string'
          ? Date.parse(data.expires)
          : Number.NaN;
    if (
      data.token_type !== 'oidc' ||
      typeof data.token !== 'string' ||
      !data.token ||
      !Number.isFinite(expires) ||
      expires < Date.now() + 15_000
    )
      throw new Error();
    return { ...opts, forceAuth: { token: data.token } };
  } catch {
    return releaseError(
      'npm trusted-publisher token exchange failed. Check the package trust configuration, publish permission and token lifetime.',
      'EWORKSPACEOIDC',
    );
  }
}
