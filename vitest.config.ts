import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // DB-backed tests do real round trips against a local Postgres.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    setupFiles: ['./test/setup.ts'],
    // All DB-backed test files share one physical test database (see
    // test/db.ts). Running files in parallel lets one file's
    // `resetDb()` TRUNCATE race another file's in-flight assertions —
    // observed as flaky failures. Serialize file execution instead.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Coverage measurement (#79). `npm run test:coverage` writes a per-file
    // report; CI enforces the thresholds below and prints the summary to the
    // job output. v8 instrumentation adds little here because the tests are
    // already run once — with `fileParallelism: false` the observed CI delta
    // is small (see PR).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // process bootstrap, no logic
        'src/worker.ts', // process bootstrap, no logic
        '**/*.config.*',
        'dist/**',
      ],
      // PROVISIONAL — deliberately set a few points below what a
      // "test every route and handler against real Postgres" suite is
      // expected to reach, so this ratchets against regressions without
      // failing on day one. Run `npm run test:coverage` once and raise each
      // number to (measured − ~2%). The per-file report is the real
      // deliverable; this is just the floor.
      thresholds: {
        lines: 60,
        functions: 55,
        branches: 70,
        statements: 60,
      },
    },
  },
})
