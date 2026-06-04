import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../../src/shared/empty-config-dir.js';
import { runCalibration } from '../../src/eval/calibrate.js';

const REPO_ROOT = path.resolve(process.cwd());

describe('Phase 2 skill-trigger calibration', () => {
  let pool: Pool;
  let emptyConfigDir: string;
  let logsDir: string;
  beforeAll(async () => {
    pool = getPool();
    emptyConfigDir = await makeEmptyConfigDir();
    logsDir = await mkdtemp(path.join(tmpdir(), 'calibrate-e2e-'));
  });
  afterAll(async () => {
    await closePool();
    await removeEmptyConfigDir(emptyConfigDir);
    await rm(logsDir, { recursive: true, force: true });
  });

  it('skill description fires the Skill tool on all 10 questions', async () => {
    const out = await runCalibration({ emptyConfigDir, pool, repoRoot: REPO_ROOT, logsDir });
    expect(out.trigger_rate).toBe(1.0);
    expect(out.failures).toEqual([]);
  });
});
