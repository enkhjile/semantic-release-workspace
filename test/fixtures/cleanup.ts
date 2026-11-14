import { rmSync } from 'node:fs';
import { servers } from './registry.js';
import { roots } from './repository.js';

export function cleanupFixtures(): void {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
}
