import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBatch } from '../../src/eval/eval.js';
import { QUESTIONS } from '../../src/eval/questions.js';

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY'];

describe.skipIf(!HAS_KEY)('eval batch smoke (N=1, real LLM)', () => {
  it('runs full batch + writes the {run-<id>.md, run-<id>.jsonl} pair', async () => {
    const logs = await mkdtemp(path.join(tmpdir(), 'eval-it-'));
    const repoRoot = path.resolve(process.cwd());

    try {
      const report = await runBatch({
        n_per_cell: 1,
        logsDir: logs,
        crashesDir: path.join(logs, 'crashes'),
        repoRoot,
        seed: 42,
        skipGrading: true,
      });

      expect(report.cells_attempted).toBe(QUESTIONS.length * 2);
      expect(report.cells_recorded).toBeGreaterThan(0);
      expect(existsSync(report.jsonl_path)).toBe(true);
      expect(existsSync(report.md_path)).toBe(true);

      // .jsonl has one cell per recorded run.
      const jsonl = await readFile(report.jsonl_path, 'utf8');
      const lines = jsonl.trim().split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBe(report.cells_recorded);
      const first = JSON.parse(lines[0]!) as { run: { fixture_sha256: string } };
      expect(first.run.fixture_sha256).toMatch(/[0-9a-f]/);

      // .md header reflects the run.
      const md = await readFile(report.md_path, 'utf8');
      expect(md).toContain('# Eval Run');
      expect(md).toContain('Fixture SHA:');

      // Transient progress file should be cleaned up after success.
      expect(existsSync(path.join(logs, `run-${report.run_id}.progress.json`))).toBe(false);
    } finally {
      await rm(logs, { recursive: true, force: true });
    }
  }, 600_000);
});
