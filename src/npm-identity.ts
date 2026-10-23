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
export async function identityToken(
  env: NodeJS.ProcessEnv,
  audience: string,
): Promise<string> {
  try {
    if (audience.startsWith('npm:') && env.NPM_ID_TOKEN && ciProvider(env))
      return env.NPM_ID_TOKEN;
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
    return data.value;
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
    if (
      !record(data) ||
      data.token_type !== 'oidc' ||
      typeof data.token !== 'string' ||
      !data.token ||
      typeof data.expires !== 'string' ||
      !Number.isFinite(Date.parse(data.expires)) ||
      Date.parse(data.expires) < Date.now() + 15_000
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
