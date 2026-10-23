import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servers } from './registry.js';
import { roots } from './repository.js';
export async function sigstore() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-sigstore-'));
  roots.push(root);
  const server = fork(
    fileURLToPath(new URL('./sigstore.mjs', import.meta.url)),
    [root],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  servers.push(server);
  const url = await new Promise<string>((resolve, reject) => {
    server.once('message', (value) => resolve(String(value)));
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Sigstore exited ${code}`)));
  });
  return {
    url,
    config: {
      fulcioURL: url,
      rekorURL: url,
      tufMirrorURL: `${url}/tuf`,
      tufRootPath: join(root, 'root.json'),
    },
    events: (): string[] =>
      JSON.parse(readFileSync(join(root, 'events.json'), 'utf8')),
    control: (value: string) => writeFileSync(join(root, 'control'), value),
  };
}
