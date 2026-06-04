import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, unlink, readFile, rename, glob } from 'node:fs/promises';
import { getPool, closePool } from '../shared/db.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../shared/empty-config-dir.js';
import { runCell, type CellContext } from '../shared/run-cell.js';
import { attachCrashHook, type JsonlBuilder } from '../shared/jsonl.js';
import { sweepStaleWorkdirs } from '../arm-b/workdir.js';
import { QUESTIONS } from './questions.js';
import { runSmokeGate, SmokeGateFailure, runAchievabilityProbe } from './smoke.js';
import { runCalibration } from './calibrate.js';
import { renderRun, appendCell } from './render.js';
import { MODEL, TRANSIENT_RETRY_SLEEP_MS } from '../shared/config.js';
import { isTransient as isTransientShared } from '../shared/transient.js';

// SmokeGateFailure short-circuits the retry-once policy: misconfig isn't transient.
function isTransient(err: unknown): boolean {
  if (err instanceof SmokeGateFailure) return false;
  return isTransientShared(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface BatchReport {
  run_id: string;
  jsonl_path: string;
  md_path: string;
  cells_attempted: number;
  cells_recorded: number;
  cells_completed: number;
  cells_skipped_resumed: number;
  crashed: boolean;
}

export async function runBatch(opts: {
  n_per_cell: number;
  logsDir: string;
  crashesDir: string;
  repoRoot: string;
  seed: number;
  skipGrading?: boolean;
}): Promise<BatchReport> {
  await sweepStaleWorkdirs('/tmp/armb_run_');
  const emptyConfigDir = await makeEmptyConfigDir();
  const pool = getPool();

  // uuid suffix avoids same-ms collision when batches start in parallel.
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const runId = `${ts}_${randomUUID().slice(0, 8)}`;
  const jsonlPath = path.join(opts.logsDir, `run-${runId}.jsonl`);
  const mdPath    = path.join(opts.logsDir, `run-${runId}.md`);
  const progressPath = path.join(opts.logsDir, `run-${runId}.progress.json`);

  let attempted = 0;
  let recorded = 0;
  let completed = 0;
  let skippedResumed = 0;
  let crashed = false;

  let activeBuilder: JsonlBuilder | undefined;
  const detachCrash = attachCrashHook(() => activeBuilder, opts.crashesDir);

  try {
    await runSmokeGate({ emptyConfigDir, pool, repoRoot: opts.repoRoot });
    const achievability = await runAchievabilityProbe({ emptyConfigDir, pool, repoRoot: opts.repoRoot });
    for (const arm of ['a', 'b'] as const) {
      const r = achievability[arm];
      console.error(`[achievability] arm ${arm.toUpperCase()}: trajectory=[${r.trajectory.join(', ')}] | tool_calls=${r.tool_call_count} | terminate=${r.terminate_reason}`);
    }
    const calibration = await runCalibration({ emptyConfigDir, pool, repoRoot: opts.repoRoot, logsDir: opts.logsDir });

    const cells = interleaved(QUESTIONS.map((q) => q.prompt), ['a', 'b'], opts.n_per_cell, opts.seed);

    const done = await readTransientProgress(progressPath);

    for (const { arm, question, rep } of cells) {
      const key = cellKey(arm, question, rep);
      if (done.has(key)) { skippedResumed++; continue; }

      attempted++;
      await assertCleanState(pool);

      const ctx: CellContext = {
        run_id: runId,
        fixture_sha256: calibration.fixture_sha256,
        seed: opts.seed,
        model: MODEL,
        rep,
      };

      let payload;
      try {
        payload = await runCell({ arm, question, emptyConfigDir, pool, repoRoot: opts.repoRoot,
                                  cellContext: ctx,
                                  onBuilderReady: (b) => { activeBuilder = b; } });
      } catch (err) {
        if (isTransient(err)) {
          console.error(`[transient ${arm}::${question}::${rep}] ${(err as Error).message ?? err}; retrying once after ${TRANSIENT_RETRY_SLEEP_MS}ms`);
          await sleep(TRANSIENT_RETRY_SLEEP_MS);
          try {
            payload = await runCell({ arm, question, emptyConfigDir, pool, repoRoot: opts.repoRoot,
                                      cellContext: ctx,
                                      onBuilderReady: (b) => { activeBuilder = b; } });
          } catch (err2) {
            crashed = true;
            const snap = activeBuilder?.snapshot();
            activeBuilder = undefined;
            await writeCrashPostmortem(opts.crashesDir, arm, question, rep, err2, snap, 'transient-retry-exhausted');
            throw err2;
          }
        } else {
          crashed = true;
          const snap = activeBuilder?.snapshot();
          activeBuilder = undefined;
          await writeCrashPostmortem(opts.crashesDir, arm, question, rep, err, snap, 'harness-bug-or-fatal');
          throw err;
        }
      }

      await appendCell(jsonlPath, payload);
      await recordTransientProgress(progressPath, key);
      recorded++;
      if (payload.run.terminate_reason === 'end_turn') completed++;
      activeBuilder = undefined;
    }

    await renderRun({
      jsonlPath, outPath: mdPath,
      n_per_cell: opts.n_per_cell,
      skipJudgeGrading: opts.skipGrading ?? false,
      pool,
    });

    try { await unlink(progressPath); } catch { /* best-effort */ }
  } finally {
    // Pool closes last so any in-flight handler shutdown releases its client first.
    detachCrash();
    await removeEmptyConfigDir(emptyConfigDir);
    await closePool();
  }

  return {
    run_id: runId,
    jsonl_path: jsonlPath,
    md_path: mdPath,
    cells_attempted: attempted,
    cells_recorded: recorded,
    cells_completed: completed,
    cells_skipped_resumed: skippedResumed,
    crashed,
  };
}

function cellKey(arm: 'a' | 'b', question: string, rep: number): string {
  return `${arm}::${question}::${rep}`;
}

async function readTransientProgress(p: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return new Set();
    throw err;
  }
  // Validate shape — a malformed progress file would silently resume from
  // zero and re-run every cell, doubling API spend without warning.
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`readTransientProgress: ${p} is not a JSON object`);
  }
  const done = (parsed as { done?: unknown }).done;
  if (!Array.isArray(done) || !done.every((x): x is string => typeof x === 'string')) {
    throw new Error(`readTransientProgress: ${p}.done is not a string array`);
  }
  return new Set(done);
}

async function recordTransientProgress(p: string, key: string): Promise<void> {
  const existing = await readTransientProgress(p);
  existing.add(key);
  const body = JSON.stringify({ done: [...existing].sort() }, null, 2) + '\n';
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, p);
}

function interleaved(
  questions: ReadonlyArray<string>,
  arms: ReadonlyArray<'a' | 'b'>,
  n: number,
  seed: number,
): Array<{ arm: 'a' | 'b'; question: string; rep: number }> {
  const cells: Array<{ arm: 'a' | 'b'; question: string; rep: number }> = [];
  for (const q of questions) {
    for (const arm of arms) {
      for (let rep = 0; rep < n; rep++) {
        cells.push({ arm, question: q, rep });
      }
    }
  }
  const rng = mulberry32(seed);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = cells[i]!;
    cells[i] = cells[j]!;
    cells[j] = tmp;
  }
  return cells;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Cross-cell-leakable state is only the shared pg pool + Arm B per-cell
// workdirs (disk-resident, can survive a crashed cell).
async function assertCleanState(pool: import('pg').Pool): Promise<void> {
  const borrowed = pool.totalCount - pool.idleCount;
  if (borrowed !== 0) {
    throw new Error(`cleanup-invariant: ${borrowed} pg clients borrowed at cell boundary`);
  }
  const orphans: string[] = [];
  for await (const p of glob('/tmp/armb_run_*')) orphans.push(p);
  if (orphans.length > 0) {
    throw new Error(`cleanup-invariant: ${orphans.length} orphaned workdirs at cell boundary: ${orphans.join(', ')}`);
  }
}

async function writeCrashPostmortem(
  crashesDir: string,
  arm: 'a' | 'b',
  question: string,
  rep: number,
  err: unknown,
  snapshot: ReturnType<JsonlBuilder['snapshot']> | undefined,
  classification: string,
): Promise<void> {
  await mkdir(crashesDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const errorFields = err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack ?? null }
    : { name: 'unknown', message: String(err), stack: null };
  await writeFile(
    path.join(crashesDir, `${ts}.json`),
    JSON.stringify({ arm, question, rep, classification, error: errorFields, partial_snapshot: snapshot ?? null }, null, 2),
  );
}
