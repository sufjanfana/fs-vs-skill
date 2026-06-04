import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import type { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../../src/shared/empty-config-dir.js';
import { runAchievabilityProbe } from '../../src/eval/smoke.js';

const REPO_ROOT = path.resolve(process.cwd());

describe('Phase 1.5 achievability (observation-only)', () => {
  let pool: Pool;
  let emptyConfigDir: string;
  beforeAll(async () => {
    pool = getPool();
    emptyConfigDir = await makeEmptyConfigDir();
  });
  afterAll(async () => {
    await closePool();
    await removeEmptyConfigDir(emptyConfigDir);
  });

  it('records trajectory for both arms (no enforcement)', async () => {
    const out = await runAchievabilityProbe({ emptyConfigDir, pool, repoRoot: REPO_ROOT });
    expect(out.a.arm).toBe('a');
    expect(out.b.arm).toBe('b');
    expect(Array.isArray(out.a.trajectory)).toBe(true);
    expect(Array.isArray(out.b.trajectory)).toBe(true);
    expect(out.a.tool_call_count).toBe(out.a.trajectory.length);
    expect(out.b.tool_call_count).toBe(out.b.trajectory.length);
  });
});
