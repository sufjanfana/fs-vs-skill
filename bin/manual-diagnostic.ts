#!/usr/bin/env tsx
// Manual diagnostic for fs-vs-skill: run one question through both arms, persist
// trajectories + grader output, surface anomalies for the diagnose-arms skill.
// Bug-finding loop before the eval harness — single-cell-per-arm; no batch.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { QUESTIONS, PROBE_QUESTION, isLGradedQuestion, type QuestionEntry, type ComplexityTier } from '../src/eval/questions.js';
import { runSmokeGate, SmokeGateFailure } from '../src/eval/smoke.js';
import { runCell } from '../src/shared/run-cell.js';
import { getPool, closePool } from '../src/shared/db.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../src/shared/empty-config-dir.js';
import { judgeOne, type JudgeResult } from '../src/eval/grade-judge.js';
import type { RunRecord, TurnRecord } from '../src/shared/jsonl.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Resolved {
  id: string;
  prompt: string;
  complexity_tier: ComplexityTier;
  entry?: QuestionEntry;
  source: 'set' | 'probe' | 'freeform';
}

function resolveSpec(argv: string[]): Resolved {
  if (argv[0] === '--text') {
    const text = argv[1];
    if (!text) throw new Error('--text requires a quoted string argument');
    // complexity_tier:'simple' is a display-only placeholder on the --text path
    // (no `entry`, so grading is skipped and the tier never feeds a rollup).
    return { id: 'FREE', prompt: text, complexity_tier: 'simple', source: 'freeform' };
  }
  const spec = argv[0];
  if (!spec) {
    throw new Error('usage: npm run diagnose -- <q1|q2|q3|q4|q5|q6|q7|q8|q9|q10|probe> | --text "..."');
  }
  if (spec === 'probe') {
    const p = PROBE_QUESTION;
    return { id: p.id, prompt: p.prompt, complexity_tier: p.complexity_tier, entry: p, source: 'probe' };
  }
  const q = QUESTIONS.find((e) => e.id === spec);
  if (!q) throw new Error(`unknown spec ${spec} (expected one of q1|q2|q3|q4|q5|q6|q7|q8|q9|q10|probe or --text "...")`);
  return { id: q.id, prompt: q.prompt, complexity_tier: q.complexity_tier, entry: q, source: 'set' };
}

function renderTrajectory(turns: TurnRecord[]): string {
  const out: string[] = [];
  for (const t of turns) {
    out.push(`## turn ${t.turn} — model_ms=${t.model_ms} tool_ms=${t.tool_ms} db_ms=${t.db_ms ?? 'n/a'} stop=${t.stop_reason_raw}`);
    if (t.tool_calls.length === 0) out.push('(no tool calls)');
    for (const c of t.tool_calls) {
      const errMark = c.is_error ? ' [ERROR]' : '';
      out.push(`### ${c.name}${errMark} — tool_use_id=${c.tool_use_id}`);
      out.push(`- tool_ms: ${c.tool_ms ?? 'n/a'}`);
      out.push(`- db_ms: ${c.db_ms ?? 'n/a'}`);
      if (c.is_error) out.push('- is_error: true');
      const inputStr = typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 2);
      out.push(`- input:\n\`\`\`\n${inputStr.slice(0, 4096)}\n\`\`\``);
      if (c.stdout !== undefined) {
        // 32KB display cap for human readability; runrecord.json carries the full stdout.
        out.push(`- stdout (${Buffer.byteLength(c.stdout, 'utf8')} bytes; capped at 32KB below):`);
        out.push('```');
        out.push(c.stdout.slice(0, 32 * 1024));
        out.push('```');
      }
      if (c.stderr !== undefined && c.stderr.length > 0) {
        out.push(`- ${c.is_error ? 'error' : 'stderr'}:`);
        out.push('```');
        out.push(c.stderr.slice(0, 1024));
        out.push('```');
      }
    }
    out.push('');
  }
  return out.join('\n');
}

function summaryRow(label: string, run: RunRecord): string {
  return [
    `## Arm ${label}`,
    `- terminate_reason: ${run.terminate_reason}`,
    `- wallclock_ms: ${run.wallclock_ms}`,
    `- turns: ${run.turn_count}`,
    `- tool_calls: ${run.tool_call_count}`,
    `- model_total_ms: ${run.model_total_ms} / tool_total_ms: ${run.tool_total_ms} / synthesis_ms: ${run.synthesis_ms}`,
    `- tokens (in/out/cache_read/cache_create): ${run.input_tokens_total}/${run.output_tokens_total}/${run.cache_read_input_tokens_total}/${run.cache_creation_input_tokens_total}`,
    `- db_ms_total: ${run.db_ms_total}`,
    `- final_answer:`,
    '```',
    run.final_answer ?? '(none)',
    '```',
    ...((run.metrics_stitch_warnings ?? []).length > 0
      ? ['- metrics_stitch_warnings:', '```', ...(run.metrics_stitch_warnings ?? []), '```']
      : []),
  ].join('\n');
}

async function gradeArm(
  q: Resolved,
  run: RunRecord,
): Promise<{ p: unknown; l: JudgeResult | { error: string } | null }> {
  if (!q.entry) return { p: null, l: null };
  const answer = run.final_answer ?? '';
  const p = q.entry.p_grader(answer);
  // Only L-graded questions have non-empty rubrics; others are P-grader-only.
  if (!isLGradedQuestion(q.entry)) return { p, l: null };
  let l: JudgeResult | { error: string } | null = null;
  try {
    l = await judgeOne(q.entry.l_grader_rubric, q.prompt, answer);
  } catch (e) {
    l = { error: e instanceof Error ? e.message : String(e) };
  }
  return { p, l };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const q = resolveSpec(argv);

  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(REPO_ROOT, 'logs', `manual-diagnostic-${iso}`);
  await mkdir(logDir, { recursive: true });

  let emptyConfigDir: string | undefined;
  let pool: Pool | undefined;
  try {
    emptyConfigDir = await makeEmptyConfigDir();
    pool = getPool();

    // Smoke gate — halt on failure.
    try {
      await runSmokeGate({ emptyConfigDir, pool, repoRoot: REPO_ROOT });
    } catch (e) {
      const msg = e instanceof SmokeGateFailure ? e.message : (e instanceof Error ? e.stack ?? e.message : String(e));
      await writeFile(path.join(logDir, 'smoke-gate-failure.txt'), msg);
      console.error(`smoke gate failed:\n${msg}`);
      console.log(logDir);
      process.exitCode = 2;
      return;
    }

    await writeFile(
      path.join(logDir, 'meta.json'),
      JSON.stringify({ iso, argv, question: q, repoRoot: REPO_ROOT, seed: 42 }, null, 2),
    );

    // Arm A — runCell handles setup + dispose internally.
    const a = await runCell({ arm: 'a', question: q.prompt, emptyConfigDir, pool, repoRoot: REPO_ROOT });
    await writeFile(path.join(logDir, 'arm-a-runrecord.json'), JSON.stringify({ run: a.run, turns: a.turns }, null, 2));
    await writeFile(path.join(logDir, 'arm-a-trajectory.md'), renderTrajectory(a.turns));

    // Arm B — sequential after Arm A.
    const b = await runCell({ arm: 'b', question: q.prompt, emptyConfigDir, pool, repoRoot: REPO_ROOT });
    await writeFile(path.join(logDir, 'arm-b-runrecord.json'), JSON.stringify({ run: b.run, turns: b.turns }, null, 2));
    await writeFile(path.join(logDir, 'arm-b-trajectory.md'), renderTrajectory(b.turns));

    // Grade: P-grader directly; L-rubric via judgeOne. Skipped on free-form.
    const grader = { a: await gradeArm(q, a.run), b: await gradeArm(q, b.run) };
    await writeFile(path.join(logDir, 'grader.json'), JSON.stringify(grader, null, 2));

    const summary = [
      `# manual-diagnostic ${iso}`,
      ``,
      `- question: \`${q.id}\` (${q.complexity_tier}, source=${q.source})`,
      `- prompt: ${q.prompt}`,
      ``,
      summaryRow('A', a.run),
      ``,
      summaryRow('B', b.run),
      ``,
      `## Grader`,
      '```json',
      JSON.stringify(grader, null, 2),
      '```',
    ].join('\n');
    await writeFile(path.join(logDir, 'summary.md'), summary);

    console.log(logDir);
  } finally {
    if (emptyConfigDir) {
      try {
        await removeEmptyConfigDir(emptyConfigDir);
      } catch {
        /* operator diagnostic — never fails the run on cleanup */
      }
    }
    try {
      await closePool();
    } catch {
      /* operator diagnostic — never fails the run on cleanup */
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
