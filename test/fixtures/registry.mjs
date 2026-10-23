import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';

const directory = process.argv[2];
const stateFile = join(directory, 'registry.json');
writeFileSync(
  stateFile,
  JSON.stringify({ npm: {}, cargo: {}, uploads: [], requests: [] }),
);
let base;
const handler = async (req, res) => {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.requests ??= [];
  state.requests.push({
    method: req.method,
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
    if (path === '/cargo/api/v1/crates/new') {
      const length = bytes.readUInt32LE(0);
      const meta = JSON.parse(bytes.subarray(4, 4 + length));
      const artifact = bytes.subarray(8 + length);
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
      for (const [version, meta] of Object.entries(data.versions)) {
        state.npm[data.name] ??= {};
        const versions = state.npm[data.name];
        if (versions[version]) return json({ error: 'exists' }, 409);
        const attachment = Object.values(data._attachments)[0];
        const artifact = Buffer.from(attachment.data, 'base64');
        meta.dist = {
          integrity: `sha512-${createHash('sha512').update(artifact).digest('base64')}`,
          shasum: createHash('sha1').update(artifact).digest('hex'),
          tarball: `${base}/npm-tar/${encodeURIComponent(data.name)}/${version}`,
        };
        versions[version] = {
          access: data.access,
          metadata: meta,
          artifact: artifact.toString('base64'),
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
    return json({ dl: `${base}/cargo/api/v1/crates`, api: `${base}/cargo` });
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
  const name = path.slice(1);
  const versions = state.npm[name];
  if (!versions) return json({ error: 'not found' }, 404);
  return json({
    name,
    'dist-tags': { latest: Object.keys(versions).at(-1) },
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
