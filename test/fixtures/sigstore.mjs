import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  fulcioHandler,
  initializeCA,
  initializeCTLog,
  initializeTLog,
  rekorHandler,
} from '@sigstore/mock';
import { initializeTUFRepo, tufHandlers } from '@tufjs/repo-mock';

const root = process.argv[2];
const key = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ct = await initializeCTLog(key());
const ca = await initializeCA(key(), ct);
const events = [];
let handlers = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  events.push(path);
  writeFileSync(join(root, 'events.json'), JSON.stringify(events));
  const control = existsSync(join(root, 'control'))
    ? readFileSync(join(root, 'control'), 'utf8')
    : '';
  if (control.startsWith('redirect:') && path === '/api/v2/signingCert') {
    res.writeHead(307, { location: control.slice(9) });
    return res.end();
  }
  const handler = handlers.find((h) => h.path === path);
  if (!handler) {
    res.writeHead(404);
    return res.end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks).toString();
  if (path === '/api/v1/log/entries') {
    const proposal = JSON.parse(body);
    if (proposal.kind === 'dsse') {
      // Rekor canonicalizes a DSSE proposal before signing its log entry.
      const proposed = proposal.spec.proposedContent;
      const envelope = JSON.parse(proposed.envelope);
      proposal.spec = {
        signatures: envelope.signatures.map((sig) => ({
          signature: sig.sig,
          verifier: proposed.verifiers[0],
        })),
        payloadHash: {
          algorithm: 'sha256',
          value: createHash('sha256')
            .update(Buffer.from(envelope.payload, 'base64'))
            .digest('hex'),
        },
      };
      body = JSON.stringify(proposal);
    }
  }
  const result = await handler.fn(body);
  if (control === 'bad-log' && path === '/api/v1/log/entries') {
    const data = JSON.parse(result.response);
    Object.values(data)[0].verification.signedEntryTimestamp = 'AAAA';
    result.response = JSON.stringify(data);
  }
  res.writeHead(result.statusCode, {
    'content-type': result.contentType || 'application/json',
  });
  res.end(
    typeof result.response === 'string'
      ? result.response
      : Buffer.from(
          result.response.buffer,
          result.response.byteOffset,
          result.response.byteLength,
        ),
  );
});
server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  const log = await initializeTLog(url, key());
  const raw = (value) =>
    Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
      'base64',
    );
  const validFor = {
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 86400000).toISOString(),
  };
  const trustedLog = (publicKey) => ({
    baseUrl: url,
    hashAlgorithm: 'SHA2_256',
    publicKey: {
      rawBytes: raw(publicKey),
      keyDetails: 'PKIX_ECDSA_P256_SHA_256',
      validFor,
    },
    logId: { keyId: createHash('sha256').update(publicKey).digest('base64') },
  });
  const trusted = {
    mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    tlogs: [trustedLog(log.publicKey)],
    ctlogs: [trustedLog(ct.publicKey)],
    certificateAuthorities: [
      {
        subject: { organization: 'fixture', commonName: 'fixture' },
        uri: url,
        certChain: { certificates: [{ rawBytes: raw(ca.rootCertificate) }] },
        validFor,
      },
    ],
    timestampAuthorities: [],
  };
  const repo = initializeTUFRepo([
    { name: 'trusted_root.json', content: JSON.stringify(trusted) },
  ]);
  writeFileSync(
    join(root, 'root.json'),
    JSON.stringify(repo.rootMeta.toJSON()),
  );
  handlers = [
    fulcioHandler(
      {
        rootCertificate: ca.rootCertificate,
        issueCertificate: async (options) => {
          if (
            options.extensions?.some(
              (ext) =>
                ext.oid === '1.3.6.1.4.1.57264.1.1' &&
                ext.value === 'https://gitlab.com',
            )
          ) {
            options.extensions = options.extensions.map((ext) =>
              ext.oid === '1.3.6.1.4.1.57264.1.12'
                ? {
                    ...ext,
                    value: ext.value.replace(
                      'https://github.com',
                      'https://gitlab.com',
                    ),
                  }
                : ext,
            );
          }
          return ca.issueCertificate(options);
        },
      },
      { subjectClaim: 'workflow_identity' },
    ),
    rekorHandler(log),
    ...tufHandlers(repo, {
      metadataPathPrefix: '/tuf',
      targetPathPrefix: '/tuf/targets',
    }),
  ];
  writeFileSync(join(root, 'events.json'), '[]');
  process.send(url);
});
process.on('disconnect', () => server.close());
