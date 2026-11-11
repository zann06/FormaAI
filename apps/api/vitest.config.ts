import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every test file builds a real Fastify app, a real Postgres schema and (for
    // pipeline tests) parses real PDFs/DOCX files. Those operations routinely
    // exceed the 5s default when the whole suite runs in parallel.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each file owns its own throwaway schema, so parallel files are safe.
    pool: 'forks',
  },
});
