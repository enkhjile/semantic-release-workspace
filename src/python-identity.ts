import { identityToken } from './npm-identity.js';
import { releaseError } from './release-io.js';
import { record } from './workspace-files.js';

async function exchange(origin: string, endpoint: string, token?: string) {
  const response = await fetch(new URL(`/_/oidc/${endpoint}`, origin), {
    method: token === undefined ? 'GET' : 'POST',
    ...(token === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error();
  return response;
}

export async function withPythonToken(
  registry: string,
  env: NodeJS.ProcessEnv,
  upload: (token: string) => Promise<void>,
) {
  let token: string;
  try {
    const audience: unknown = await (
      await exchange(registry, 'audience')
    ).json();
    if (
      !record(audience) ||
      typeof audience.audience !== 'string' ||
      !audience.audience ||
      env.GITHUB_ACTIONS !== 'true'
    )
      throw new Error();
    const jwt = await identityToken(
      {
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: env.ACTIONS_ID_TOKEN_REQUEST_URL,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      },
      audience.audience,
    );
    const result: unknown = await (
      await exchange(registry, 'mint-token', jwt)
    ).json();
    if (
      !record(result) ||
      typeof result.token !== 'string' ||
      !/^[!-~]+$/.test(result.token)
    )
      throw new Error();
    token = result.token;
  } catch {
    return releaseError(
      'Python trusted-publisher exchange failed. Check GitHub Actions identity permissions and PyPI publisher configuration.',
      'EWORKSPACEOIDC',
    );
  }
  try {
    await upload(token);
  } finally {
    try {
      await exchange(registry, 'burn-token', token);
    } catch {
      releaseError(
        'Could not revoke the temporary Python publishing token.',
        'EWORKSPACEOIDC',
      );
    }
  }
}
