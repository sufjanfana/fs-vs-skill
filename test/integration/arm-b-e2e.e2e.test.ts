/**
 * Arm B end-to-end smoke: drives `runCell` against a real model and verifies
 * the agent loads sql-skill, invokes `.claude/skills/sql-skill/sql`, and uses
 * native bash to compose an answer. Confirms the metrics-stitch sidecar
 * populates `db_ms` on at least one Bash ToolCall.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../../src/shared/empty-config-dir.js';
import { runCell } from '../../src/shared/run-cell.js';

const REPO_ROOT = path.resolve(process.cwd());

describe('Arm B e2e', () => {
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

  it('agent loads sql-skill, invokes ./sql, composes via bash, sidecar stitches', async () => {
    const out = await runCell({
      arm: 'b',
      question: 'How many distinct top-level sections does the Arize docs corpus have?',
      emptyConfigDir, pool, repoRoot: REPO_ROOT,
    });

    expect(out.run.arm).toBe('b');
    expect(out.run.terminate_reason).toBe('end_turn');
    expect(out.run.final_answer).not.toBeNull();

    const allToolCalls = out.turns.flatMap((t) => t.tool_calls);
    const toolNames = allToolCalls.map((c) => c.name);
    // The agent should have loaded the skill (Skill tool) and run at least one bash call.
    expect(toolNames).toContain('Skill');
    expect(toolNames).toContain('Bash');

    // At least one Bash call invokes the bundled script.
    const sqlInvocations = allToolCalls.filter(
      (c) => c.name === 'Bash' && typeof c.input === 'object' && c.input !== null
        && typeof (c.input as { command?: string }).command === 'string'
        && (c.input as { command: string }).command.includes('.claude/skills/sql-skill/sql'),
    );
    expect(sqlInvocations.length).toBeGreaterThan(0);

    // Sidecar metrics should have been stitched onto at least one ./sql Bash call.
    const stitchedDbCalls = sqlInvocations.filter((c) => typeof c.db_ms === 'number');
    expect(stitchedDbCalls.length).toBeGreaterThan(0);

    // metrics_stitch_warnings is an array, empty on the happy path.
    expect(Array.isArray(out.run.metrics_stitch_warnings)).toBe(true);
    expect(out.run.metrics_stitch_warnings).toEqual([]);
  });
});
