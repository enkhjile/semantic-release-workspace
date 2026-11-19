import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servers } from './registry.js';
import { roots } from './repository.js';

interface PythonRegistryState {
  requests: { path: string; method: string; authorization: string | null }[];
  files: Record<
    string,
    { name: string; version: string; sha256: string; bytes: string }
  >;
  uploads: string[];
  exchanges: number;
  revocations: number;
}
export async function pythonRegistry() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-python-registry-'));
  roots.push(root);
  const control = (settings: Record<string, unknown>) =>
    writeFileSync(join(root, 'control.json'), JSON.stringify(settings));
  control({});
  const server = fork(
    fileURLToPath(new URL('./python-registry.mjs', import.meta.url)),
    [root],
    {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  servers.push(server);
  const url = await new Promise<string>((resolve, reject) => {
    server.once('message', (value) => resolve(String(value)));
    server.once('error', reject);
    server.once('exit', (code) =>
      reject(new Error(`Python registry exited ${code}`)),
    );
  });
  return {
    url,
    root,
    control,
    state: (): PythonRegistryState =>
      JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')),
    config: {
      trustedPublishing: true,
      uploadUrl: `${url}/legacy/`,
      indexUrl: `${url}/simple/`,
    },
    env: {
      GITHUB_ACTIONS: 'true',
      ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/oidc`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-ci-secret',
    },
  };
}
