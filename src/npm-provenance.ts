import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { VerifyConditionsContext } from 'semantic-release';
import { attest, type Bundle, verify } from 'sigstore';
import { ciProvider, identityToken, serviceURL } from './npm-identity.js';
import type { PackagePlan } from './plan-types.js';
import type { Destination } from './publication-state.js';
import { releaseError } from './release-io.js';
import { record } from './workspace-files.js';

const payloadType = 'application/vnd.in-toto+json';
export function npmSubject(name: string, version: string, bytes: Buffer) {
  return {
    name: `pkg:npm/${name.replace('@', '%40')}@${version}`,
    digest: { sha512: createHash('sha512').update(bytes).digest('hex') },
  };
}
export async function sigstorePolicy(
  context: VerifyConditionsContext,
  value: unknown,
): Promise<Destination['sigstore']> {
  if (value === undefined) return undefined;
  try {
    if (!record(value) || typeof value.tufRootPath !== 'string')
      throw new Error();
    const urls = ['fulcioURL', 'rekorURL', 'tufMirrorURL'].map((key) => {
      const url = new URL(serviceURL(value[key]));
      if (url.search) throw new Error();
      return url.href.replace(/\/$/, '');
    });
    const root = await readFile(
      resolve(context.cwd ?? process.cwd(), value.tufRootPath),
    );
    return {
      fulcioURL: urls[0] as string,
      rekorURL: urls[1] as string,
      tufMirrorURL: urls[2] as string,
      tufRootPath: value.tufRootPath,
      tufRootDigest: createHash('sha256').update(root).digest('hex'),
    };
  } catch {
    return releaseError(
      'npm.sigstore requires HTTPS service URLs and a pinned TUF root file.',
      'EWORKSPACECONFIG',
    );
  }
}

// The SDK does not expose redirect policy. Its loopback gateway forwards only
// these two fixed signing routes, rejecting redirects before secrets can leave.
async function signingGateway(dest: Destination) {
  const secret = randomUUID();
  const routes: Record<string, string> = {
    [`/${secret}/fulcio/api/v2/signingCert`]: `${dest.sigstore?.fulcioURL ?? 'https://fulcio.sigstore.dev'}/api/v2/signingCert`,
    [`/${secret}/rekor/api/v1/log/entries`]: `${dest.sigstore?.rekorURL ?? 'https://rekor.sigstore.dev'}/api/v1/log/entries`,
  };
  const server = createServer(async (req, res) => {
    try {
      const target = routes[req.url ?? ''];
      if (req.method !== 'POST' || !target) throw new Error();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(chunk);
      }
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error();
      const body = await response.text();
      if (body.length > 4 * 1024 * 1024) throw new Error();
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(body);
    } catch {
      res.writeHead(502);
      res.end('{}');
    }
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  const url = `http://127.0.0.1:${address.port}/${secret}`;
  return {
    fulcioURL: `${url}/fulcio`,
    rekorURL: `${url}/rekor`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

function statement(
  env: NodeJS.ProcessEnv,
  subject: ReturnType<typeof npmSubject>,
  head: string,
) {
  const provider = ciProvider(env);
  if (provider === 'github') {
    if (
      env.GITHUB_SHA !== head ||
      !env.GITHUB_REPOSITORY ||
      !env.GITHUB_WORKFLOW_REF ||
      !env.GITHUB_REF ||
      !env.GITHUB_RUN_ID ||
      !env.GITHUB_RUN_ATTEMPT
    )
      throw new Error();
    const repository = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}`;
    const relative = env.GITHUB_WORKFLOW_REF.replace(
      `${env.GITHUB_REPOSITORY}/`,
      '',
    );
    const delimiter = relative.indexOf('@');
    if (delimiter < 0) throw new Error();
    return {
      source: {
        issuer: 'https://token.actions.githubusercontent.com',
        repository,
        head,
      },
      payload: {
        _type: 'https://in-toto.io/Statement/v1',
        subject: [subject],
        predicateType: 'https://slsa.dev/provenance/v1',
        predicate: {
          buildDefinition: {
            buildType:
              'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
            externalParameters: {
              workflow: {
                ref: relative.slice(delimiter + 1),
                path: relative.slice(0, delimiter),
                repository,
              },
            },
            internalParameters: {
              github: {
                event_name: env.GITHUB_EVENT_NAME,
                repository_id: env.GITHUB_REPOSITORY_ID,
                repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
              },
            },
            resolvedDependencies: [
              {
                uri: `git+${repository}@${env.GITHUB_REF}`,
                digest: { gitCommit: head },
              },
            ],
          },
          runDetails: {
            builder: {
              id: `https://github.com/actions/runner/${env.RUNNER_ENVIRONMENT}`,
            },
            metadata: {
              invocationId: `${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
            },
          },
        },
      },
    };
  }
  if (provider === 'gitlab') {
    if (
      env.CI_COMMIT_SHA !== head ||
      !env.CI_PROJECT_URL ||
      !env.CI_JOB_URL ||
      !env.CI_JOB_NAME ||
      !env.CI_RUNNER_ID
    )
      throw new Error();
    const repository = env.CI_PROJECT_URL;
    return {
      source: {
        issuer: env.CI_SERVER_URL ?? 'https://gitlab.com',
        repository,
        head,
      },
      payload: {
        _type: 'https://in-toto.io/Statement/v0.1',
        subject: [subject],
        predicateType: 'https://slsa.dev/provenance/v0.2',
        predicate: {
          buildType: 'https://github.com/npm/cli/gitlab/v0alpha1',
          builder: { id: `${repository}/-/runners/${env.CI_RUNNER_ID}` },
          invocation: {
            configSource: {
              uri: `git+${repository}`,
              digest: { sha1: head },
              entryPoint: env.CI_JOB_NAME,
            },
            parameters: {
              CI_PROJECT_ID: env.CI_PROJECT_ID,
              CI_PIPELINE_ID: env.CI_PIPELINE_ID,
              CI_JOB_ID: env.CI_JOB_ID,
            },
          },
          metadata: {
            buildInvocationId: env.CI_JOB_URL,
            completeness: {
              parameters: false,
              environment: false,
              materials: false,
            },
            reproducible: false,
          },
          materials: [{ uri: `git+${repository}`, digest: { sha1: head } }],
        },
      },
    };
  }
  throw new Error();
}
export function provenanceBundle(metadata: unknown): Bundle | undefined {
  return record(metadata) &&
    record(metadata.provenance) &&
    record(metadata.provenance.bundle)
    ? (metadata.provenance.bundle as unknown as Bundle)
    : undefined;
}

export function validateProvenanceContext(
  context: VerifyConditionsContext,
  dest: Destination,
  head: string,
) {
  if (dest.provenance !== true) return;
  const env = context.env ?? process.env;
  const provider = ciProvider(env);
  if (
    !['github', 'gitlab'].includes(provider ?? '') ||
    dest.access === 'restricted'
  )
    return releaseError(
      'npm provenance requires GitHub Actions or GitLab CI and public package access.',
      'EWORKSPACEPROVENANCE',
    );
  if (
    (provider === 'gitlab' && !env.SIGSTORE_ID_TOKEN) ||
    (provider === 'github' &&
      !env.SIGSTORE_ID_TOKEN &&
      !(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN))
  )
    return releaseError(
      'npm provenance requires a Sigstore-audience CI identity.',
      'EWORKSPACEPROVENANCE',
    );
  try {
    statement(env, { name: '', digest: { sha512: '' } }, head);
  } catch {
    return releaseError(
      'npm provenance requires complete CI metadata matching the source commit.',
      'EWORKSPACEPROVENANCE',
    );
  }
  const visibility =
    provider === 'github'
      ? env.GITHUB_REPOSITORY_VISIBILITY
      : env.CI_PROJECT_VISIBILITY;
  if (visibility && visibility !== 'public')
    return releaseError(
      'npm provenance requires a public source repository.',
      'EWORKSPACEPROVENANCE',
    );
}

export async function createProvenance(
  context: VerifyConditionsContext,
  dest: Destination,
  pkg: PackagePlan,
  bytes: Buffer,
  head: string,
  publicPackage: () => Promise<boolean>,
): Promise<unknown> {
  const metadata = { name: pkg.name, version: pkg.nextVersion };
  if (!dest.provenance) return metadata;
  try {
    const env = context.env ?? process.env;
    const provider = ciProvider(env);
    if (
      dest.provenance === 'auto' &&
      provider === 'github' &&
      !env.SIGSTORE_ID_TOKEN &&
      !(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    )
      return metadata;
    if (
      dest.provenance === 'auto' &&
      provider === 'gitlab' &&
      !env.SIGSTORE_ID_TOKEN
    )
      return metadata;
    if (provider !== 'github' && provider !== 'gitlab') {
      if (dest.provenance === 'auto') return metadata;
      throw new Error();
    }
    // Unknown visibility is treated as private; callers can explicitly set public.
    const visibility =
      provider === 'github'
        ? env.GITHUB_REPOSITORY_VISIBILITY
        : env.CI_PROJECT_VISIBILITY;
    if (
      (dest.access === 'restricted' ||
        visibility === 'private' ||
        visibility === 'internal') &&
      dest.provenance === 'auto'
    )
      return metadata;
    const token = await identityToken(env, 'sigstore');
    const claims: unknown = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    );
    const publicRepo =
      ((record(claims)
        ? (claims.repository_visibility ?? claims.project_visibility)
        : undefined) ?? visibility) === 'public';
    if (!(await publicPackage()) || !publicRepo) {
      if (dest.provenance === 'auto') return metadata;
      throw new Error();
    }
    const { source, payload } = statement(
      env,
      npmSubject(pkg.name, pkg.nextVersion ?? '', bytes),
      head,
    );
    const gateway = await signingGateway(dest);
    let bundle: Bundle;
    try {
      bundle = await attest(Buffer.from(JSON.stringify(payload)), payloadType, {
        ...gateway,
        identityToken: token,
        retry: 0,
        timeout: 30_000,
      });
    } finally {
      await gateway.close();
    }
    const result = { ...metadata, provenance: { source, bundle } };
    await verifyProvenance(context, dest, pkg, bytes, result, head);
    return result;
  } catch {
    return releaseError(
      'Cannot create npm provenance. Require public access and repository, matching CI source SHA, supported CI identity and reachable Sigstore services.',
      'EWORKSPACEPROVENANCE',
    );
  }
}

export async function verifyProvenance(
  context: VerifyConditionsContext,
  dest: Destination,
  pkg: PackagePlan,
  bytes: Buffer,
  metadata: unknown,
  head: string,
): Promise<void> {
  try {
    const bundle = provenanceBundle(metadata);
    if (!bundle) {
      if (dest.provenance === true) throw new Error();
      return;
    }
    if (
      !dest.provenance ||
      !record(metadata) ||
      !record(metadata.provenance) ||
      !record(metadata.provenance.source)
    )
      throw new Error();
    const source = metadata.provenance.source;
    if (
      source.head !== head ||
      typeof source.repository !== 'string' ||
      ![
        'https://token.actions.githubusercontent.com',
        'https://gitlab.com',
      ].includes(String(source.issuer))
    )
      throw new Error();
    if (bundle.dsseEnvelope?.payloadType !== payloadType) throw new Error();
    const payload = JSON.parse(
      Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString(),
    );
    if (
      JSON.stringify(payload.subject) !==
      JSON.stringify([npmSubject(pkg.name, pkg.nextVersion ?? '', bytes)])
    )
      throw new Error();
    const github =
      source.issuer === 'https://token.actions.githubusercontent.com';
    if (
      payload._type !==
        (github
          ? 'https://in-toto.io/Statement/v1'
          : 'https://in-toto.io/Statement/v0.1') ||
      payload.predicateType !==
        (github
          ? 'https://slsa.dev/provenance/v1'
          : 'https://slsa.dev/provenance/v0.2')
    )
      throw new Error();
    const material = github
      ? payload.predicate.buildDefinition.resolvedDependencies[0]
      : payload.predicate.materials[0];
    if (
      (github
        ? !material.uri.startsWith(`git+${source.repository}@`) ||
          material.uri.length <= `git+${source.repository}@`.length
        : material.uri !== `git+${source.repository}`) ||
      (material.digest.gitCommit ?? material.digest.sha1) !== head
    )
      throw new Error();
    const custom = dest.sigstore;
    if (custom) {
      const root = await readFile(
        resolve(context.cwd ?? process.cwd(), custom.tufRootPath),
      );
      if (
        createHash('sha256').update(root).digest('hex') !== custom.tufRootDigest
      )
        throw new Error();
    }
    const signer = await verify(bundle, {
      certificateIssuer: String(source.issuer),
      ...(custom
        ? {
            tufMirrorURL: custom.tufMirrorURL,
            tufRootPath: resolve(
              context.cwd ?? process.cwd(),
              custom.tufRootPath,
            ),
          }
        : {}),
      tufCachePath: join(
        context.env?.HOME ?? homedir(),
        '.cache',
        'semantic-release-workspace',
        custom?.tufRootDigest ?? 'public',
      ),
      retry: 0,
      timeout: 30_000,
    });
    // The SDK returns authenticated certificate extensions as DER bytes. Bind
    // both the source repository and commit to the signed certificate identity.
    for (const [oid, value] of [
      ['1.3.6.1.4.1.57264.1.12', source.repository],
      ['1.3.6.1.4.1.57264.1.13', head],
    ]) {
      const utf8 = Buffer.from(value as string);
      const lengthHex = utf8.length
        .toString(16)
        .padStart(Math.ceil(utf8.length.toString(16).length / 2) * 2, '0');
      const length =
        utf8.length < 128
          ? Buffer.from([utf8.length])
          : Buffer.concat([
              Buffer.from([0x80 + lengthHex.length / 2]),
              Buffer.from(lengthHex, 'hex'),
            ]);
      const expected = Buffer.concat([Buffer.from([0x0c]), length, utf8]);
      if (
        !signer.identity?.oids?.some(
          (entry) =>
            entry.oid?.id.join('.') === oid && entry.value.equals(expected),
        )
      )
        throw new Error();
    }
  } catch {
    return releaseError(
      'Retained npm provenance does not verify against its artifact, source identity and pinned trust root.',
      'EWORKSPACEPROVENANCE',
    );
  }
}
