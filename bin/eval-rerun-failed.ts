/**
 * bin/eval-rerun-failed.ts — re-run failed cells from a prior run's .jsonl.
 *
 * A "failed cell" = any cell with `terminate_reason !== 'end_turn'` OR a
 * non-empty `metrics_stitch_warnings`. This script parses the source .jsonl,
 * collects passing cells, runs ONLY the failed cells fresh, and emits a new
 * `logs/run-<ts2>.{md,jsonl}` pair containing the original's passing cells
 * plus the fresh results. The source .jsonl/.md are untouched.
 *
 * Usage:
 *   npm run eval:rerun-failed -- logs/run-<ts>.jsonl
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPool, closePool } from '../src/shared/db.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../src/shared/empty-config-dir.js';
import { runCell, type CellContext } from '../src/shared/run-cell.js';
import { appendCell, renderRun, parseCellLines, type CellLine } from '../src/eval/render.js';
import { MODEL } from '../src/shared/config.js';
import { runSmokeGate, runAchievabilityProbe } from '../src/eval/smoke.js';
import { runCalibration } from '../src/eval/calibrate.js';

function isFailedCell(c: CellLine): boolean {
  if (c.run.terminate_reason !== 'end_turn') return true;
  if ((c.run.metrics_stitch_warnings ?? []).length > 0) return true;
  return false;
}

async function main() {
  if (!process.env['ANTHROPIC_API_KEY']) {
    throw new Error('ANTHROPIC_API_KEY required.');
  }
  if (!process.env['PG_CONNECTION_STRING']) {
    throw new Error('PG_CONNECTION_STRING required (point at the docs_ro role).');
  }
  const srcPath = process.argv[2];
  if (!srcPath) {
    console.error('usage: eval-rerun-failed <path-to-run-<ts>.jsonl>');
    process.exit(2);
  }
  const repoRoot = path.resolve(process.cwd());
  const logsDir = path.join(repoRoot, 'logs');

  const text = await readFile(srcPath, 'utf8');
  const cells = parseCellLines(text, srcPath);
  if (cells.length === 0) {
    console.error(`no cells found in ${srcPath}`);
    process.exit(1);
  }

  const failed = cells.filter(isFailedCell);
  const passing = cells.filter((c) => !isFailedCell(c));
  console.log(`Source: ${cells.length} cells (${passing.length} pass, ${failed.length} fail). Rerunning ${failed.length}.`);
  if (failed.length === 0) { console.log('Nothing to rerun.'); return; }

  // Output path: new run-id, but inherit fixture_sha256 + seed from the source.
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const runId = `${ts}_${randomUUID().slice(0, 8)}`;
  const outJsonl = path.join(logsDir, `run-${runId}.jsonl`);
  const outMd    = path.join(logsDir, `run-${runId}.md`);

  // Carry forward passing cells under the SAME run_id so the .md header reflects
  // the rerun (and the original's metadata stays on the original .md/.jsonl).
  const carried = passing.map((c) => ({
    ...c,
    run: { ...c.run, run_id: runId },
  }));

  const pool = getPool();
  const emptyConfigDir = await makeEmptyConfigDir();
  try {
    // Run the same three pre-gates as a fresh batch (eval.ts) so rerun cells
    // are measured against an identical pre-flight contract: smoke gate
    // verifies docs_ro role / script file / per-arm probes, achievability
    // probe catches upstream API-path regressions, calibration verifies
    // Skill trigger rate AND captures the current fixture_sha256.
    await runSmokeGate({ emptyConfigDir, pool, repoRoot });
    await runAchievabilityProbe({ emptyConfigDir, pool, repoRoot });
    const calibration = await runCalibration({ emptyConfigDir, pool, repoRoot, logsDir });

    // Refuse to rerun if the bundle changed between the source run and now.
    // Mixing carried-forward cells (measured under the original bundle) with
    // freshly-rerun cells (measured under a drifted bundle) would silently
    // compare apples to oranges.
    const firstFailed = failed[0]!;
    if (calibration.fixture_sha256 !== firstFailed.run.fixture_sha256) {
      throw new Error(
        `fixture_sha256 mismatch: source run was ${firstFailed.run.fixture_sha256}, ` +
        `current bundle is ${calibration.fixture_sha256}. ` +
        `The skill bundle changed since the source run; rerun comparisons would not be like-for-like. ` +
        `Run a fresh batch (npm run eval) instead.`,
      );
    }

    // Gates + fixture check passed — write the carried-forward passing cells now,
    // so a gate failure can't leave an orphan half-file under a fresh run-id.
    for (const c of carried) await appendCell(outJsonl, c);

    for (const failedCell of failed) {
      const ctx: CellContext = {
        run_id: runId,
        fixture_sha256: calibration.fixture_sha256,
        seed: firstFailed.run.seed,
        model: failedCell.run.model ?? MODEL,
        rep: failedCell.run.rep,
      };
      const payload = await runCell({
        arm: failedCell.run.arm, question: failedCell.run.question,
        emptyConfigDir, pool, repoRoot, cellContext: ctx,
      });
      await appendCell(outJsonl, payload);
      console.log(`re-ran arm=${failedCell.run.arm} rep=${failedCell.run.rep} terminate=${payload.run.terminate_reason}`);
    }

    await renderRun({ jsonlPath: outJsonl, outPath: outMd, pool });
  } finally {
    await removeEmptyConfigDir(emptyConfigDir);
    await closePool();
  }

  console.log(JSON.stringify({ run_id: runId, jsonl: outJsonl, md: outMd }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
