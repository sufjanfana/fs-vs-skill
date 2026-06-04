/**
 * bin/eval.ts — fs-vs-skill batch runner entry point.
 *
 * Every invocation is fresh by default: a new timestamp+uuid suffixed
 * `logs/run-<id>.{md,jsonl}` pair is produced. Within-run resume is handled by
 * a transient `logs/run-<id>.progress.json` (deleted on success). There is no
 * cross-run `progress.json`.
 *
 * Flags:
 *   --n <int>          Reps per (arm, question). Default 5.
 *                      Total cells = N × 10 questions × 2 arms.
 *   --skip-grading     Skip the post-batch L-grader (Anthropic judge call).
 *                      P-grader still runs (it's pure).
 *
 * Seed: hardcoded to 42; controls the cell-ordering shuffle only. The SDK
 * exposes no request-level seed/temperature, so seed scope is intentionally
 * just the harness-side ordering.
 *
 * Required env vars (see .env.example):
 *   ANTHROPIC_API_KEY
 *   PG_CONNECTION_STRING   (point at the read-only docs_ro role)
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runBatch } from '../src/eval/eval.js';

async function main() {
  if (!process.env['ANTHROPIC_API_KEY']) {
    throw new Error('ANTHROPIC_API_KEY required.');
  }
  if (!process.env['PG_CONNECTION_STRING']) {
    throw new Error('PG_CONNECTION_STRING required (point at the docs_ro role).');
  }
  const { values } = parseArgs({
    options: {
      'skip-grading': { type: 'boolean', default: false },
      n:              { type: 'string',  default: '5' },
    },
  });
  const nPerCell = Number.parseInt(values.n, 10);
  if (!Number.isInteger(nPerCell) || nPerCell < 1) {
    throw new Error(`--n must be a positive integer (got '${values.n}')`);
  }
  const repoRoot = path.resolve(process.cwd());
  const r = await runBatch({
    n_per_cell: nPerCell,
    logsDir: path.join(repoRoot, 'logs'),
    crashesDir: path.join(repoRoot, 'crashes'),
    repoRoot,
    seed: 42,
    skipGrading: values['skip-grading'],
  });
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
