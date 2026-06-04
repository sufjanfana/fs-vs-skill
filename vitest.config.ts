import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.it.test.ts', 'test/**/*.e2e.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/**/*.it.test.ts'],
          testTimeout: 30_000,
          // IT hooks running the real smoke gate (~30s for the per-arm probes
          // Arm A + Arm B) exceed vitest's 10s default. Bump to 120s.
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e.test.ts'],
          testTimeout: 10 * 60_000,
          // E2E hooks run the real smoke gate (~30s for Arm A + Arm B probes).
          hookTimeout: 5 * 60_000,
          // Each e2e file spawns Claude Code subprocesses (Anthropic API +
          // CLI process). Full parallelism on an 18-core box = 7 concurrent
          // agents hammering the API; observed deterministic api_error at
          // 30s under that pressure. Cap workers to bound API/DB contention.
          maxWorkers: 2,
          minWorkers: 1,
        },
      },
    ],
  },
});
