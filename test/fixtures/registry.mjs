import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';

const directory = process.argv[2];
const stateFile = join(directory, 'registry.json');
writeFileSync(
  stateFile,
  JSON.stringify({
    npm: {},
    npmTags: {},
    cargo: {},
    uploads: [],
    requests: [],
  }),
);
let base;
const handler = async (req, res) => {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.requests ??= [];
  state.requests.push({
    method: req.method,
    userAgent: req.headers['user-agent'],
    path: req.url,
    authorization: req.headers.authorization,
    authorized: req.socket.authorized,
  });
  writeFileSync(stateFile, JSON.stringify(state));
  const controlValue = existsSync(join(directory, 'control'))
    ? readFileSync(join(directory, 'control'), 'utf8')
    : '';
  const path = decodeURIComponent(
    new URL(req.url, 'http://localhost').pathname,
  );
  const json = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (
    controlValue.startsWith('redirect:') ||
    (controlValue.startsWith('redirect-put:') && req.method === 'PUT')
  ) {
    const target = controlValue.slice(controlValue.indexOf(':') + 1);
    res.writeHead(307, { location: `${target}${req.url}` });
    return res.end();
  }
  if (controlValue === 'bad-json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('fixture-token invalid JSON');
  }
  if (controlValue === 'get-fail' && req.method === 'GET') {
    res.writeHead(503);
    return res.end();
  }
  const trusted = existsSync(join(directory, 'oidc.json'))
    ? JSON.parse(readFileSync(join(directory, 'oidc.json'), 'utf8'))
    : undefined;
  if (trusted && path === '/oidc') {
    if (trusted.redirectIdentity) {
      res.writeHead(307, { location: trusted.redirectIdentity });
      return res.end();
    }
    if (req.headers.authorization !== 'Bearer ci-request-secret')
      return json({ error: 'unauthorized' }, 401);
    const audience = new URL(req.url, 'http://localhost').searchParams.get(
      'audience',
    );
    const claims = {
      iss: 'https://token.actions.githubusercontent.com',
      sub: 'repo:fixture/repo:ref:refs/heads/main',
      workflow_identity:
        'https://github.com/fixture/repo/.github/workflows/release.yml@refs/heads/main',
      repository: 'fixture/repo',
      sha: trusted.head,
      jti: `identity-${state.requests.filter((entry) => entry.path.startsWith('/oidc')).length}`,
      aud: audience,
      repository_visibility: 'public',
      ...(trusted.claims ?? {}),
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const value = `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture-signature`;
    return json({ value });
  }
  if (trusted && path.startsWith('/-/npm/v1/oidc/token/exchange/package/')) {
    if (trusted.rejectExchange)
      return json({ message: 'ci-request-secret exchange rejected' }, 403);
    if (trusted.redirectExchange) {
      res.writeHead(307, { location: trusted.redirectExchange });
      return res.end();
    }
    const name = path.slice('/-/npm/v1/oidc/token/exchange/package/'.length);
    const bearer = req.headers.authorization?.slice(7);
    if (!bearer || bearer === 'fixture-token')
      return json({ error: 'missing identity' }, 401);
    const token = `exchange-secret:${name}:${(state.exchanges?.length ?? 0) + 1}`;
    state.exchanges ??= [];
    state.exchanges.push({ name, token });
    writeFileSync(stateFile, JSON.stringify(state));
    return json(
      {
        token_type: 'oidc',
        token,
        created: new Date().toISOString(),
        expires: new Date(
          Date.now() + (trusted.expired ? -1000 : 3600000),
        ).toISOString(),
      },
      201,
    );
  }
  const cargoTrusted = existsSync(join(directory, 'cargo-oidc.json'))
    ? JSON.parse(readFileSync(join(directory, 'cargo-oidc.json'), 'utf8'))
    : undefined;
  if (cargoTrusted && path === '/cargo/api/v1/trusted_publishing/tokens') {
    if (req.method === 'DELETE') {
      if (cargoTrusted.redirectRevoke) {
        res.writeHead(307, { location: cargoTrusted.redirectRevoke });
        return res.end();
      }
      if (cargoTrusted.rejectRevoke)
        return json(
          { errors: [{ detail: 'cargo-secret revoke failed' }] },
          503,
        );
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const entry = state.cargoExchanges?.find(
        (entry) => entry.token === token,
      );
      if (!entry) return json({}, 401);
      entry.revoked = true;
      state.cargoRevocations ??= [];
      state.cargoRevocations.push(token);
      writeFileSync(stateFile, JSON.stringify(state));
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'POST') return json({}, 405);
    if (cargoTrusted.redirectExchange) {
      res.writeHead(307, { location: cargoTrusted.redirectExchange });
      return res.end();
    }
    if (cargoTrusted.rejectExchange)
      return json({ errors: [{ detail: 'ci-request-secret rejected' }] }, 403);
    if (cargoTrusted.badJSON) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('cargo-secret invalid JSON');
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { jwt } = JSON.parse(Buffer.concat(chunks));
    let claims;
    try {
      claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
    } catch {
      return json({}, 401);
    }
    const audience = `${base.replace(/^https?:\/\//, '')}/cargo`;
    if (
      !(
        claims?.aud === audience ||
        (Array.isArray(claims?.aud) && claims.aud.includes(audience))
      ) ||
      req.headers.authorization ||
      !req.headers['user-agent']?.includes('semantic-release-workspace')
    )
      return json({}, 401);
    state.cargoExchanges ??= [];
    if (state.cargoExchanges.some((entry) => entry.jwt === jwt))
      return json({ errors: [{ detail: 'JWT already used' }] }, 400);
    const token = `cargo-secret-${state.cargoExchanges.length + 1}`;
    state.cargoExchanges.push({
      token,
      jwt,
      revoked: false,
      expired: !!cargoTrusted.expired,
    });
    writeFileSync(stateFile, JSON.stringify(state));
    return json(cargoTrusted.emptyToken ? { token: '' } : { token });
  }
  if (req.method === 'PUT') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const control = existsSync(join(directory, 'control'))
      ? readFileSync(join(directory, 'control'), 'utf8')
      : '';
    if (control.startsWith('once-'))
      writeFileSync(join(directory, 'control'), '');
    if (
      control.includes('reject') &&
      (control !== 'reject-second' || state.uploads.length > 0)
    )
      return json({ error: 'injected rejection' }, 503);
    if (path.startsWith('/-/package/') && path.includes('/dist-tags/')) {
      const [name, tag] = path.slice('/-/package/'.length).split('/dist-tags/');
      if (
        trusted &&
        req.headers.authorization !==
          `Bearer ${state.exchanges?.filter((entry) => entry.name === name).at(-1)?.token}`
      )
        return json({}, 401);
      const version = JSON.parse(bytes);
      if (!state.npm[name]?.[version]) return json({}, 404);
      state.npmTags[name] ??= {};
      state.npmTags[name][tag] = version;
      state.channelUpdates ??= [];
      state.channelUpdates.push({ name, tag, version });
    } else if (path === '/cargo/api/v1/crates/new') {
      const length = bytes.readUInt32LE(0);
      const meta = JSON.parse(bytes.subarray(4, 4 + length));
      const artifact = bytes.subarray(8 + length);
      if (cargoTrusted) {
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        const credential = state.cargoExchanges?.find(
          (entry) => entry.token === token,
        );
        if (!credential || credential.revoked || credential.expired)
          return json({ errors: [{ detail: 'cargo-secret invalid' }] }, 401);
      }
      state.cargo[meta.name] ??= {};
      const versions = state.cargo[meta.name];
      if (versions[meta.vers])
        return json({ errors: [{ detail: 'exists' }] }, 409);
      versions[meta.vers] = {
        metadata: meta,
        artifact: artifact.toString('base64'),
        cksum: createHash('sha256').update(artifact).digest('hex'),
      };
      state.uploads.push(`cargo:${meta.name}@${meta.vers}`);
    } else {
      const data = JSON.parse(bytes);
      if (
        trusted &&
        req.headers.authorization !==
          `Bearer ${state.exchanges?.filter((entry) => entry.name === data.name).at(-1)?.token}`
      )
        return json({ error: 'package-scoped token required' }, 401);
      for (const [version, meta] of Object.entries(data.versions)) {
        state.npm[data.name] ??= {};
        const versions = state.npm[data.name];
        if (versions[version]) return json({ error: 'exists' }, 409);
        const attachment = Object.entries(data._attachments).find(([name]) =>
          name.endsWith('.tgz'),
        )[1];
        const provenance = Object.entries(data._attachments).find(([name]) =>
          name.endsWith('.sigstore'),
        );
        const bundle = provenance ? JSON.parse(provenance[1].data) : undefined;
        const artifact = Buffer.from(attachment.data, 'base64');
        meta.dist = {
          integrity: `sha512-${createHash('sha512').update(artifact).digest('base64')}`,
          shasum: createHash('sha1').update(artifact).digest('hex'),
          tarball: `${base}/npm-tar/${encodeURIComponent(data.name)}/${version}`,
        };
        if (bundle)
          meta.dist.attestations = {
            url: `${base}/-/npm/v1/attestations/${encodeURIComponent(data.name)}@${version}`,
          };
        versions[version] = {
          bundle,
          access: data.access,
          metadata: meta,
          artifact: artifact.toString('base64'),
        };
        state.npmTags ??= {};
        state.npmTags[data.name] = {
          ...state.npmTags[data.name],
          ...data['dist-tags'],
        };
        state.uploads.push(`npm:${data.name}@${version}`);
      }
    }
    writeFileSync(stateFile, JSON.stringify(state));
    if (control.includes('unreadable'))
      writeFileSync(join(directory, 'control'), 'get-fail');
    if (control.includes('drop')) return req.socket.destroy();
    return json({ ok: true, warnings: {} });
  }
  if (path === '/cargo/index/config.json')
    return json({
      dl: `${base}/cargo/api/v1/crates`,
      api: cargoTrusted?.api ?? `${base}/cargo`,
    });
  if (path.startsWith('/cargo/index/')) {
    const name = path.split('/').at(-1);
    const versions = state.cargo[name];
    if (!versions) return json({ error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(
      `${Object.entries(versions)
        .map(([version, entry]) =>
          JSON.stringify({
            name,
            vers: version,
            cksum: entry.cksum,
            yanked: false,
            features: entry.metadata.features,
            features2: entry.metadata.features,
            v: 2,
            deps: entry.metadata.deps.map((dep) => ({
              name: dep.explicit_name_in_toml ?? dep.name,
              package: dep.explicit_name_in_toml ? dep.name : undefined,
              req: dep.version_req,
              features: dep.features,
              optional: dep.optional,
              default_features: dep.default_features,
              target: dep.target,
              kind: dep.kind,
              registry:
                dep.registry === `sparse+${base}/cargo/index/`
                  ? null
                  : dep.registry,
            })),
          }),
        )
        .join('\n')}\n`,
    );
  }
  if (path.startsWith('/cargo/api/v1/crates/') && path.endsWith('/download')) {
    const [, name, version] =
      path.match(/\/crates\/([^/]+)\/([^/]+)\/download/) ?? [];
    const entry = state.cargo[name]?.[version];
    if (!entry) return json({}, 404);
    return res.end(Buffer.from(entry.artifact, 'base64'));
  }
  if (path.startsWith('/npm-tar/')) {
    const name = path.slice(9, path.lastIndexOf('/'));
    const version = path.split('/').at(-1);
    return res.end(Buffer.from(state.npm[name][version].artifact, 'base64'));
  }
  if (path.startsWith('/-/package/') && path.endsWith('/visibility'))
    return json({ public: trusted?.publicPackage === true });
  if (path.startsWith('/-/npm/v1/attestations/')) {
    const spec = path.slice('/-/npm/v1/attestations/'.length);
    const at = spec.lastIndexOf('@');
    const entry = state.npm[spec.slice(0, at)]?.[spec.slice(at + 1)];
    if (controlValue === 'attestation-404') return json({}, 404);
    if (controlValue === 'attestation-missing')
      return json({ attestations: [] });
    if (controlValue.startsWith('attestation-redirect:')) {
      res.writeHead(307, {
        location: controlValue.slice('attestation-redirect:'.length),
      });
      return res.end();
    }
    const bundle =
      controlValue === 'attestation-corrupt'
        ? {
            ...entry?.bundle,
            dsseEnvelope: { ...entry?.bundle.dsseEnvelope, payload: 'e30=' },
          }
        : entry?.bundle;
    return json({
      attestations: bundle
        ? [
            {
              predicateType: 'https://slsa.dev/provenance/v1',
              bundle,
            },
          ]
        : [],
    });
  }
  if (path.startsWith('/-/package/') && path.endsWith('/dist-tags'))
    return json(
      state.npmTags[path.slice('/-/package/'.length, -'/dist-tags'.length)] ??
        {},
    );
  const name = path.slice(1);
  const versions = state.npm[name];
  if (!versions) return json({ error: 'not found' }, 404);
  return json({
    name,
    'dist-tags': state.npmTags[name],
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, entry]) => [
        version,
        entry.metadata,
      ]),
    ),
  });
};
const secure = process.argv[3] === 'tls';
const server = secure
  ? createTlsServer(
      {
        key: readFileSync(join(directory, 'server.key')),
        cert: readFileSync(join(directory, 'server.crt')),
        ca: readFileSync(join(directory, 'server.crt')),
        requestCert: true,
        rejectUnauthorized: true,
      },
      handler,
    )
  : createServer(handler);
server.listen(0, '127.0.0.1', () => {
  base = `${secure ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  process.send(base);
});
process.on('disconnect', () => server.close());
