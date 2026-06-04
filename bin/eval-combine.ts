/**
 * bin/eval-combine.ts — concatenate multiple run JSONLs into one,
 * renumber reps across runs, re-render the aggregate .md.
 *
 * Usage:
 *   npm run eval:combine -- logs/run-A.jsonl logs/run-B.jsonl [logs/run-C.jsonl ...]
 *
 * Output: logs/combined-<ts>.{md,jsonl}. Original files untouched.
 *
 * Reps within each (arm, question) are renumbered 0..K-1 in source-file
 * concatenation order so the rendered .md treats them as a single batch.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendCell, renderRun, parseCellLines, type CellLine } from '../src/eval/render.js';

async function main() {
  if (!process.env['ANTHROPIC_API_KEY']) {
    throw new Error('ANTHROPIC_API_KEY required (combine re-runs the L-judge).');
  }
  const inputs = process.argv.slice(2);
  if (inputs.length < 2) {
    console.error('usage: eval-combine <run-A.jsonl> <run-B.jsonl> [...]');
    process.exit(2);
  }

  const all: CellLine[] = [];
  for (const f of inputs) {
    const text = await readFile(f, 'utf8');
    all.push(...parseCellLines(text, f));
  }
  console.log(`Loaded ${all.length} cells from ${inputs.length} files.`);

  const repoRoot = path.resolve(process.cwd());
  const logsDir = path.join(repoRoot, 'logs');
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const runId = `combined-${ts}_${randomUUID().slice(0, 8)}`;
  const outJsonl = path.join(logsDir, `${runId}.jsonl`);
  const outMd    = path.join(logsDir, `${runId}.md`);

  // Stamp source provenance BEFORE overwriting run_id / rep, then renumber
  // rep within each (arm, question) in source order.
  const counters = new Map<string, number>();
  for (const c of all) {
    c.run.source_run_id = c.run.run_id;
    c.run.source_rep = c.run.rep;
    c.run.run_id = runId;
    const k = `${c.run.arm}::${c.run.question}`;
    const next = counters.get(k) ?? 0;
    c.run.rep = next;
    counters.set(k, next + 1);
  }
  for (const c of all) await appendCell(outJsonl, c);

  await renderRun({ jsonlPath: outJsonl, outPath: outMd });
  console.log(JSON.stringify({ run_id: runId, jsonl: outJsonl, md: outMd, cells: all.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
