import { rmSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { registry, servers } from './fixtures/registry.js';
import { roots } from './fixtures/repository.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('keeps registry HTTP connections alive through release lifecycle gaps', async () => {
  const service = await registry();
  const response = await fetch(`${service.url}/cargo/index/config.json`);

  expect(response.status).toBe(200);
  expect(response.headers.get('keep-alive')).toBe('timeout=120');
});
