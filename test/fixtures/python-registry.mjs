import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const root = process.argv[2];
const state = {
  requests: [],
  files: {},
  uploads: [],
  exchanges: 0,
  revocations: 0,
};
const save = () =>
  writeFileSync(join(root, 'state.json'), JSON.stringify(state));
const controls = () =>
  JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'));
const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};
const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
function multipart(bytes, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
  if (!boundary) throw new Error('Missing multipart boundary');
  const delimiter = Buffer.from(`\r\n--${boundary[1] ?? boundary[2]}`);
  const fields = {};
  let file;
  let offset = 0;
  while (offset < bytes.length) {
    const headerEnd = bytes.indexOf('\r\n\r\n', offset);
    if (headerEnd < 0) break;
    const header = bytes.subarray(offset, headerEnd).toString();
    const end = bytes.indexOf(delimiter, headerEnd + 4);
    if (end < 0) break;
    const body = bytes.subarray(headerEnd + 4, end);
    const name = /name="([^"]+)"/.exec(header)?.[1];
    const filename = /filename="([^"]+)"/.exec(header)?.[1];
    if (filename) file = { filename, bytes: body };
    else if (name) fields[name] = body.toString();
    offset = end + delimiter.length;
  }
  return { fields, file };
}
let url;
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const path = new URL(request.url, 'http://fixture').pathname;
    const control = controls();
    state.requests.push({
      path,
      method: request.method,
      authorization: request.headers.authorization ?? null,
    });
    save();
    if (control.redirectPath === path) {
      response.writeHead(307, { location: control.redirectTo });
      response.end();
      return;
    }
    if (path === '/oidc') {
      if (request.headers.authorization !== 'Bearer fixture-ci-secret')
        return json(response, 401, {});
      const audience = new URL(request.url, url).searchParams.get('audience');
      return json(response, 200, {
        value: `header.${Buffer.from(JSON.stringify({ aud: audience })).toString('base64url')}.signature`,
      });
    }
    if (path === '/_/oidc/audience')
      return json(response, 200, { audience: 'fixture-pypi' });
    if (path === '/_/oidc/mint-token') {
      state.exchanges++;
      save();
      if (control.rejectExchange)
        return json(response, 403, { error: 'fixture-ci-secret' });
      const claims = JSON.parse(
        Buffer.from(
          JSON.parse(body).token.split('.')[1],
          'base64url',
        ).toString(),
      );
      if (claims.aud !== 'fixture-pypi') return json(response, 401, {});
      return json(response, 200, { token: 'fixture-pypi-secret' });
    }
    if (path === '/_/oidc/burn-token') {
      if (JSON.parse(body).token !== 'fixture-pypi-secret')
        return json(response, 403, {});
      state.revocations++;
      save();
      return json(response, control.rejectRevoke ? 500 : 202, {});
    }
    if (path.startsWith('/simple/')) {
      if (control.failReadsAfterUpload && state.uploads.length)
        return json(response, 503, {});
      const name = path.split('/')[2];
      const files = Object.entries(state.files).filter(
        ([, entry]) => normalize(entry.name) === name,
      );
      return json(response, 200, {
        meta: { 'api-version': '1.0' },
        name,
        files: files.map(([filename, entry]) => ({
          filename,
          url: `${url}/files/${filename}`,
          hashes: { sha256: control.conflict ? '0'.repeat(64) : entry.sha256 },
        })),
      });
    }
    if (path.startsWith('/files/')) {
      const file = state.files[path.slice('/files/'.length)];
      if (!file) return json(response, 404, {});
      response.end(Buffer.from(file.bytes, 'base64'));
      return;
    }
    if (path === '/legacy/') {
      const expected = `Basic ${Buffer.from('__token__:fixture-pypi-secret').toString('base64')}`;
      if (request.headers.authorization !== expected)
        return json(response, 403, {});
      const { fields, file } = multipart(
        body,
        request.headers['content-type'] ?? '',
      );
      if (!file || !fields.name || !fields.version)
        return json(response, 400, { error: 'Malformed upload' });
      if (
        control.partial &&
        state.uploads.length &&
        !state.files[file.filename]
      )
        return json(response, 400, { error: 'Injected second-file failure' });
      const hash = createHash('sha256').update(file.bytes).digest('hex');
      if (fields.sha256_digest !== hash)
        return json(response, 400, { error: 'Hash mismatch' });
      if (state.files[file.filename])
        return json(response, 400, { error: 'File already exists' });
      state.files[file.filename] = {
        name: fields.name,
        version: fields.version,
        sha256: hash,
        bytes: file.bytes.toString('base64'),
      };
      state.uploads.push(file.filename);
      save();
      if (control.loseResponse) {
        request.socket.destroy();
        return;
      }
      return json(response, 200, {});
    }
    return json(response, 404, {});
  } catch (error) {
    return json(response, 500, { error: String(error) });
  }
});
save();
server.listen(0, '127.0.0.1', () => {
  url = `http://127.0.0.1:${server.address().port}`;
  process.send(url);
});
