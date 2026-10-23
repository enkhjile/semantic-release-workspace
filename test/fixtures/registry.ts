import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roots } from './repository.js';
export const servers: ChildProcess[] = [];
export async function registry(tls = false) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-registry-'));
  roots.push(root);
  if (tls) {
    const openssl = (...args: string[]) =>
      execFileSync('openssl', args, { cwd: root, stdio: 'ignore' });
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'server.key',
      '-out',
      'server.crt',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    );
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'client.key',
      '-out',
      'client.csr',
      '-subj',
      '/CN=fixture-client',
    );
    openssl(
      'x509',
      '-req',
      '-in',
      'client.csr',
      '-CA',
      'server.crt',
      '-CAkey',
      'server.key',
      '-CAcreateserial',
      '-out',
      'client.crt',
      '-days',
      '1',
    );
  }
  const server = fork(
    fileURLToPath(new URL('./registry.mjs', import.meta.url)),
    [root, ...(tls ? ['tls'] : [])],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  servers.push(server);
  const url = await new Promise<string>((resolve, reject) => {
    server.once('message', (message) => resolve(String(message)));
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Registry exited ${code}`)));
  });
  const npmrc = join(root, 'npmrc');
  writeFileSync(
    npmrc,
    `//127.0.0.1:${new URL(url).port}/:_authToken=fixture-token\nfetch-retries=0\n${tls ? `cafile=${join(root, 'server.crt')}\n//127.0.0.1:${new URL(url).port}/:certfile=${join(root, 'client.crt')}\n//127.0.0.1:${new URL(url).port}/:keyfile=${join(root, 'client.key')}\n` : ''}`,
  );
  return {
    url,
    root,
    env: {
      npm_config_userconfig: npmrc,
      npm_config_fetch_retries: '0',
      CARGO_HOME: join(root, 'cargo-home'),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
      CARGO_REGISTRIES_FIXTURE_TOKEN: 'fixture-token',
      CARGO_NET_RETRY: '0',
    },
    state: () => JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')),
    trusted: (settings: Record<string, unknown> = {}) =>
      writeFileSync(join(root, 'oidc.json'), JSON.stringify(settings)),
    cargoTrusted: (settings: Record<string, unknown> = {}) =>
      writeFileSync(join(root, 'cargo-oidc.json'), JSON.stringify(settings)),
    control: (value: string) => writeFileSync(join(root, 'control'), value),
  };
}
