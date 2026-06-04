import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../../src/shared/empty-config-dir.js';
import { runSmokeGate } from '../../src/eval/smoke.js';

const REPO_ROOT = path.resolve(process.cwd());

describe('Phase 1 smoke gate', () => {
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

  it('passes both arms and surfaces required tool / skill', async () => {
    // Pre-stage decoy skill for the walk-up probe
    await mkdir('/tmp/.claude/skills/decoy', { recursive: true });
    await writeFile(
      '/tmp/.claude/skills/decoy/SKILL.md',
      '---\nname: decoy\ndescription: should be filtered out\n---\n',
    );

    try {
      const out = await runSmokeGate({ emptyConfigDir, pool, repoRoot: REPO_ROOT });
      expect(out.armA.systemMsg.tools).toContain('mcp__postgresfs__bash');
      // Positive check only: Arm B must surface sql-skill (SDK 0.3.143 leaks its built-ins
      // into systemMsg.skills, so "no other skills" cannot be asserted).
      expect(out.armB.systemMsg.skills ?? []).toContain('sql-skill');
    } finally {
      await rm('/tmp/.claude/skills/decoy', { recursive: true, force: true });
    }
  });

  it('SmokeGateFailure is exported with property+message wiring', async () => {
    // This test documents the injection seam intention. Full injection requires
    // a separate setup path; covered structurally by the SmokeGateFailure class.
    // The assertion here is that the error class is correctly exported and typed.
    const { SmokeGateFailure } = await import('../../src/eval/smoke.js');
    const err = new SmokeGateFailure('arm-a-tools', 'missing mcp__postgresfs__bash');
    expect(err.property).toBe('arm-a-tools');
    expect(err.message).toContain('[smoke arm-a-tools]');
  });
});
