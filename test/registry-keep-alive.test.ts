import { afterEach, expect, test } from 'vitest';
import { cleanupFixtures } from './fixtures/cleanup.js';
import { registry } from './fixtures/registry.js';

afterEach(cleanupFixtures);

test('keeps registry HTTP connections alive through release lifecycle gaps', async () => {
  const service = await registry();
  const response = await fetch(`${service.url}/cargo/index/config.json`);

  expect(response.status).toBe(200);
  expect(response.headers.get('keep-alive')).toBe('timeout=120');
});
