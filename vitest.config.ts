import { configDefaults, defineConfig } from 'vitest/config';

// Pure in-memory tests. Files using Git, filesystem fixtures, native tools or
// local services belong to integration. New tests default to integration.
const unit = ['test/coordination.test.ts', 'test/manifests.test.ts'];

export default defineConfig({
  test: {
    maxWorkers: 4,
    projects: [
      { test: { name: 'unit', include: unit } },
      {
        test: {
          name: 'integration',
          include: configDefaults.include,
          exclude: [...configDefaults.exclude, ...unit],
        },
      },
    ],
  },
});
