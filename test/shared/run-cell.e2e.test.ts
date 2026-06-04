import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../../src/shared/empty-config-dir.js';
import { runCell } from '../../src/shared/run-cell.js';

const REPO_ROOT = path.resolve(process.cwd());

describe('runCell e2e (both arms)', () => {
  let pool: Pool;
  let emptyConfigDir: string;
  beforeAll(async () => {
    pool = getPool();
    emptyConfigDir = await makeEmptyConfigDir();
  });
  afterAll(async () => { await closePool(); await removeEmptyConfigDir(emptyConfigDir); });

  it('Arm A: completes a trivial question and produces a RunRecord', async () => {
    const out = await runCell({ arm: 'a', question: 'List the top-level sections.', emptyConfigDir, pool, repoRoot: REPO_ROOT });
    expect(out.run.arm).toBe('a');
    expect(out.run.terminate_reason).toBe('end_turn');
    expect(out.run.final_answer).not.toBeNull();
    expect(out.run.final_answer_source).toBe('result');
    expect(out.turns.length).toBeGreaterThan(0);
  });

  it('Arm B: completes via Skill -> sql() and produces a RunRecord', async () => {
    const out = await runCell({ arm: 'b', question: 'List the top-level sections.', emptyConfigDir, pool, repoRoot: REPO_ROOT });
    expect(out.run.arm).toBe('b');
    expect(out.run.terminate_reason).toBe('end_turn');
    expect(out.run.final_answer).not.toBeNull();
  });

  it('max_turns path: hitting maxTurns -> terminate_reason "max_iterations" + final_answer null', async () => {
    const out = await runCell({
      arm: 'a',
      question: 'List /, then list /ax, then summarize the corpus structure.',
      emptyConfigDir, pool, repoRoot: REPO_ROOT,
      maxTurns: 1,
    });
    expect(out.run.terminate_reason).toBe('max_iterations');
    expect(out.run.final_answer).toBeNull();
    expect(out.run.final_answer_source).toBe('none');
  });

  it('timeout path: AbortController fires -> terminate_reason "question_timeout" + final_answer null', async () => {
    const out = await runCell({
      arm: 'a',
      question: 'Use grep -r . / and write a detailed essay about every documentation page.',
      emptyConfigDir, pool, repoRoot: REPO_ROOT,
      abortAfterMs: 2000,
    });
    expect(out.run.terminate_reason).toBe('question_timeout');
    expect(out.run.final_answer).toBeNull();
    expect(out.run.final_answer_source).toBe('none');
  });
});
