// Single renderer for all eval commands. Reads cells from .jsonl, runs P-grader
// inline and optionally L-grader (Anthropic judge), writes a side-by-side .md.

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { RunRecord, TurnRecord, ToolCall } from '../shared/jsonl.js';
import { QUESTIONS, isLGradedQuestion, type PGraderResult, type ComplexityTier } from './questions.js';
import { JUDGE_MODEL, MODEL } from '../shared/config.js';
import { verifyCites } from './verify-cites.js';
import { classifyFail, type FailClassification } from './classify-fail.js';
import { type ConsistencyReport } from './judge-consistency.js';

export interface CellLine { turns: TurnRecord[]; run: RunRecord }

export function parseCellLines(text: string, source: string): CellLine[] {
  const out: CellLine[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as CellLine);
    } catch {
      throw new Error(`malformed JSON at ${source}:${i + 1}`);
    }
  }
  return out;
}

// Binary L-judge result. corpus_integrity_fail + cite_misses are set by the
// cite pre-gate so classify-fail can demote to CI without re-running the judge.
export interface LGrade {
  pass: boolean;
  reason: string;
  item_evaluations?: Array<{ item: string; verdict: 'pass' | 'fail'; reason: string }>;
  cite_misses?: number;
  corpus_integrity_fail?: boolean;
  judge_error?: boolean;
}

export interface CellGrades {
  p?: PGraderResult;
  l?: LGrade;
  // 4-category failure taxonomy + sub-counts. Populated by gradeCells after
  // P/L grades land.
  fail?: FailClassification;
}

export interface RenderOpts {
  jsonlPath: string;
  outPath: string;
  // Rendered only when set (header line). Not derived from cells.
  n_per_cell?: number;
  // Skip the judge (L-grader) Anthropic API call.
  skipJudgeGrading?: boolean;
  // Live corpus pool for programmatic cite verification. When omitted, the
  // cite pre-gate is skipped and a warning is logged — the judge runs without
  // short-circuiting on bad cites.
  pool?: Pool;
}

export async function readCells(jsonlPath: string): Promise<CellLine[]> {
  let text: string;
  try {
    text = await readFile(jsonlPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l) as CellLine);
}

export async function appendCell(jsonlPath: string, payload: CellLine): Promise<void> {
  await mkdir(path.dirname(jsonlPath), { recursive: true });
  await appendFile(jsonlPath, JSON.stringify(payload) + '\n', 'utf8');
}

export async function renderRun(opts: RenderOpts): Promise<string> {
  const cells = await readCells(opts.jsonlPath);
  if (cells.length === 0) {
    const empty = `# Eval Run (empty)\n\nNo cells found at ${opts.jsonlPath}.\n`;
    await writeFile(opts.outPath, empty, 'utf8');
    return empty;
  }
  const grades = await gradeCells(cells, {
    skipJudge: opts.skipJudgeGrading ?? false,
    ...(opts.pool ? { pool: opts.pool } : {}),
  });
  // Judge runs exactly once per L-cell (gradeCells → judgeOne); no
  // self-consistency re-judging.
  const consistency: ConsistencyReport | null = null;
  const md = buildMarkdown(cells, grades, opts, consistency);
  await mkdir(path.dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, md, 'utf8');
  return md;
}

async function gradeCells(
  cells: ReadonlyArray<CellLine>,
  opts: { skipJudge: boolean; pool?: Pool },
): Promise<CellGrades[]> {
  const out: CellGrades[] = [];
  for (const c of cells) {
    const g: CellGrades = {};
    const q = QUESTIONS.find((x) => x.prompt === c.run.question);
    if (q && c.run.final_answer_source === 'result' && c.run.final_answer != null) {
      g.p = q.p_grader(c.run.final_answer);
    }
    out.push(g);
  }
  if (opts.skipJudge) {
    // skipJudge still classifies P-only categories from terminate_reason + P-grade.
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const g = out[i]!;
      const q = QUESTIONS.find((x) => x.prompt === c.run.question);
      g.fail = classifyFail(c.run, q, g.p, undefined);
    }
    return out;
  }

  if (!opts.pool) {
    // pool absent → judge sees raw answer; warn, don't crash.
    console.warn('[render] pool not provided — skipping programmatic cite pre-gate.');
  }

  const { judgeOne, isTransient } = await import('./grade-judge.js');
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const g = out[i]!;
    const q = QUESTIONS.find((x) => x.prompt === c.run.question);
    if (!q) continue;
    if (c.run.final_answer_source !== 'result' || c.run.final_answer == null) continue;
    // Only L-graded questions get the judge call; the rest have empty rubrics
    // and are scored fully by the P-grader.
    if (!isLGradedQuestion(q)) continue;

    // cite pre-gate: misses short-circuit to corpus_integrity_fail without paying for a judge call.
    if (opts.pool) {
      const cite = await verifyCites(c.run.final_answer, opts.pool);
      if (cite.misses.length > 0) {
        g.l = {
          pass: false,
          reason: `corpus_integrity_fail: ${cite.misses.length}/${cite.total} cited slug(s) not in doc_paths (${cite.misses.join(', ')})`,
          cite_misses: cite.misses.length,
          corpus_integrity_fail: true,
        };
        continue;
      }
    }

    try {
      g.l = await judgeOne(q.l_grader_rubric, c.run.question, c.run.final_answer);
    } catch (err) {
      if (isTransient(err)) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          g.l = await judgeOne(q.l_grader_rubric, c.run.question, c.run.final_answer);
        } catch (err2) {
          g.l = { pass: false, reason: `judge error after retry: ${(err2 as Error).message}`, judge_error: true };
        }
      } else {
        g.l = { pass: false, reason: `judge error: ${(err as Error).message}`, judge_error: true };
      }
    }
  }

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const g = out[i]!;
    const q = QUESTIONS.find((x) => x.prompt === c.run.question);
    g.fail = classifyFail(c.run, q, g.p, g.l);
  }
  return out;
}

function buildMarkdown(
  cells: ReadonlyArray<CellLine>,
  grades: ReadonlyArray<CellGrades>,
  opts: RenderOpts,
  consistency: ConsistencyReport | null,
): string {
  // cells.length > 0 is guaranteed by renderRun's early-return on empty.
  const first = cells[0]!.run;
  const totalWall = cells.reduce((s, c) => s + c.run.wallclock_ms, 0);
  const attempted = cells.length;
  const completed = cells.filter((c) => c.run.terminate_reason === 'end_turn').length;
  const failed = attempted - completed;

  // Header
  const lines: string[] = [];
  lines.push(`# Eval Run — ${first.run_id}`);
  lines.push('');
  lines.push('## Configuration');
  lines.push('');
  lines.push(`- Run ID: ${first.run_id}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Fixture SHA: ${first.fixture_sha256 || '(unknown)'}`);
  lines.push(`- Seed: ${first.seed}`);
  lines.push(`- Model: ${first.model || MODEL}`);
  lines.push(`- Judge model: ${opts.skipJudgeGrading ? '(skipped)' : JUDGE_MODEL}`);
  if (opts.n_per_cell !== undefined) lines.push(`- N per cell: ${opts.n_per_cell}`);
  lines.push(`- Attempted: ${attempted}   Completed: ${completed}   Failed: ${failed}`);
  lines.push(`- Total wallclock: ${(totalWall / 1000).toFixed(1)}s`);
  if (consistency) {
    const pct = consistency.total > 0 ? (consistency.agreements / consistency.total * 100).toFixed(0) : '—';
    lines.push(
      `- Judge self-consistency: ${consistency.agreements}/${consistency.total} agreement (${pct}%) on held-out subset of ${consistency.held_out} L-cells`,
    );
  }
  lines.push('');

  // Per-(arm,question) summary
  const buckets = bucketCells(cells, grades);
  lines.push('## Aggregate (median over reps)');
  lines.push('');
  lines.push(
    '| Q | Arm | n | done | median P | L pass | wallclock_ms (median, IQR) | wallclock_ex_skill_ms (median, IQR) | post_orientation_wallclock_ms (median, IQR) | model_total_ms (median, IQR) | tool_total_ms (median, IQR) | db_ms_total (median, IQR) | turns (median, IQR) | tokens (median, IQR) | terminate dist | fail_breakdown | stitch warns |',
  );
  lines.push(
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (let qi = 0; qi < QUESTIONS.length; qi++) {
    const q = QUESTIONS[qi]!;
    const isLGraded = q.l_grader_rubric.required.length > 0 || q.l_grader_rubric.disqualifying.length > 0;
    for (const arm of ['a', 'b'] as const) {
      const b = buckets.get(bucketKey(arm, q.prompt));
      const n = b?.cells.length ?? 0;
      // Timing medians filter to end_turn cells — non-end_turn cells pin
      // wallclock_ms at the per-question cap and turn_count at MAX_TURNS,
      // which silently inflates the median. `done` shows the filter
      // denominator; the [N/M] annotation makes the inclusion explicit.
      const endTurnCells = (b?.cells ?? []).filter((c) => c.run.terminate_reason === 'end_turn');
      const done = endTurnCells.length;
      const pVals = (b?.grades ?? []).map((g) => g.p?.score).filter((v): v is number => typeof v === 'number');
      const lVals = (b?.grades ?? []).map((g) => g.l?.pass).filter((v): v is boolean => typeof v === 'boolean');
      const wallVals = endTurnCells.map((c) => c.run.wallclock_ms);
      const wallExSkillVals = endTurnCells.map((c) => c.run.wallclock_ex_skill_ms);
      const postOrientationVals = endTurnCells.map((c) => postOrientationWallclock(c.run));
      const modelVals = endTurnCells.map((c) => c.run.model_total_ms);
      const toolVals = endTurnCells.map((c) => c.run.tool_total_ms);
      const dbVals = endTurnCells.map((c) => c.run.db_ms_total);
      const turnVals = endTurnCells.map((c) => c.run.turn_count);
      const tokVals = endTurnCells.map((c) => c.run.input_tokens_total + c.run.output_tokens_total);
      const dist = termDistribution(b?.cells ?? []);
      const warns = (b?.cells ?? []).filter((c) => (c.run.metrics_stitch_warnings ?? []).length > 0).length;
      const failBreakdown = failBreakdownColumn(b?.grades ?? []);
      const pCol = isLGraded ? '—' : formatMedianWithDenominator(pVals, n);
      const lCol = formatPassRate(lVals, n);
      lines.push(
        `| Q${qi + 1} | ${arm.toUpperCase()} | ${n} | ${done} | ${pCol} | ${lCol} | ${formatMedianIQRWithDenominator(wallVals, n)} | ${formatMedianIQRWithDenominator(wallExSkillVals, n)} | ${formatMedianIQRWithDenominator(postOrientationVals, n)} | ${formatMedianIQRWithDenominator(modelVals, n)} | ${formatMedianIQRWithDenominator(toolVals, n)} | ${formatMedianIQRWithDenominator(dbVals, n)} | ${formatMedianIQRWithDenominator(turnVals, n)} | ${formatMedianIQRWithDenominator(tokVals, n)} | ${dist} | ${failBreakdown} | ${warns} |`,
      );
    }
  }
  lines.push('');

  const tierBuckets = bucketCellsByTier(cells, grades);
  const promptIsLOnly = new Map<string, boolean>();
  for (const q of QUESTIONS) {
    promptIsLOnly.set(
      q.prompt,
      q.l_grader_rubric.required.length > 0 || q.l_grader_rubric.disqualifying.length > 0,
    );
  }
  lines.push('## Accuracy by complexity tier');
  lines.push('');
  lines.push('| Tier | Arm | n | done | median P (P-only Qs) | L pass | fail_breakdown |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const tier of TIER_ORDER) {
    for (const arm of ['a', 'b'] as const) {
      const b = tierBuckets.get(tierKey(tier, arm));
      const n = b?.cells.length ?? 0;
      const done = b ? b.cells.filter((c) => c.run.terminate_reason === 'end_turn').length : 0;
      // Exclude L-only questions; their inert P-grader returns 0.
      const pVals = (b?.grades ?? []).map((g, i) => {
        const cell = b!.cells[i]!;
        if (promptIsLOnly.get(cell.run.question) === true) return undefined;
        return g.p?.score;
      }).filter((v): v is number => typeof v === 'number');
      const lVals = (b?.grades ?? []).map((g) => g.l?.pass).filter((v): v is boolean => typeof v === 'boolean');
      const pCol = formatMedianWithDenominator(pVals, n);
      const lCol = formatPassRate(lVals, n);
      const failBreakdown = failBreakdownColumn(b?.grades ?? []);
      lines.push(`| ${tier} | ${arm.toUpperCase()} | ${n} | ${done} | ${pCol} | ${lCol} | ${failBreakdown} |`);
    }
  }
  lines.push('');
  lines.push('## Effort by complexity tier');
  lines.push('');
  lines.push('| Tier | Arm | n | first_tool_call_ms (median, IQR) | wallclock_ms (median, IQR) | wallclock_ex_skill_ms (median, IQR) | post_orientation_wallclock_ms (median, IQR) | model_total_ms (median, IQR) | tool_total_ms (median, IQR) | db_ms_total (median, IQR) | turns (median, IQR) | tool calls (median, IQR) | tokens (median, IQR) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const tier of TIER_ORDER) {
    for (const arm of ['a', 'b'] as const) {
      const b = tierBuckets.get(tierKey(tier, arm));
      const n = b?.cells.length ?? 0;
      // Effort medians filter to end_turn cells — see Aggregate-table comment.
      const endTurnCells = (b?.cells ?? []).filter((c) => c.run.terminate_reason === 'end_turn');
      const firstToolVals = endTurnCells.map((c) => c.run.first_tool_call_ms);
      const wallVals = endTurnCells.map((c) => c.run.wallclock_ms);
      const wallExSkillVals = endTurnCells.map((c) => c.run.wallclock_ex_skill_ms);
      const postOrientationVals = endTurnCells.map((c) => postOrientationWallclock(c.run));
      const modelVals = endTurnCells.map((c) => c.run.model_total_ms);
      const tTotalVals = endTurnCells.map((c) => c.run.tool_total_ms);
      const dbVals = endTurnCells.map((c) => c.run.db_ms_total);
      const turnVals = endTurnCells.map((c) => c.run.turn_count);
      const toolVals = endTurnCells.map((c) => c.run.tool_call_count);
      const tokVals = endTurnCells.map((c) => c.run.input_tokens_total + c.run.output_tokens_total);
      lines.push(
        `| ${tier} | ${arm.toUpperCase()} | ${n} | ${formatMedianIQRWithDenominator(firstToolVals, n)} | ${formatMedianIQRWithDenominator(wallVals, n)} | ${formatMedianIQRWithDenominator(wallExSkillVals, n)} | ${formatMedianIQRWithDenominator(postOrientationVals, n)} | ${formatMedianIQRWithDenominator(modelVals, n)} | ${formatMedianIQRWithDenominator(tTotalVals, n)} | ${formatMedianIQRWithDenominator(dbVals, n)} | ${formatMedianIQRWithDenominator(turnVals, n)} | ${formatMedianIQRWithDenominator(toolVals, n)} | ${formatMedianIQRWithDenominator(tokVals, n)} |`,
      );
    }
  }
  lines.push('');

  // Per-question detail
  for (let qi = 0; qi < QUESTIONS.length; qi++) {
    const q = QUESTIONS[qi]!;
    lines.push(`## Q${qi + 1}: ${q.prompt}`);
    lines.push('');
    lines.push(`- Shape: ${q.shape}`);
    lines.push('');
    for (const arm of ['a', 'b'] as const) {
      const b = buckets.get(bucketKey(arm, q.prompt));
      lines.push(`### Arm ${arm.toUpperCase()} (${b?.cells.length ?? 0} cells)`);
      lines.push('');
      if (!b || b.cells.length === 0) { lines.push('_no cells_'); lines.push(''); continue; }
      lines.push('| rep | terminate | wallclock_ms | wallclock_ex_skill_ms | post_orientation_wallclock_ms | skill_overhead_ms | first_tool_call_ms | model_total_ms | tool_total_ms | synthesis_ms | db_ms_total | turns | tools | P | P reason | L | L reason | trajectory | final answer |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      const isLOnly = q.l_grader_rubric.required.length > 0 || q.l_grader_rubric.disqualifying.length > 0;
      for (let i = 0; i < b.cells.length; i++) {
        const c = b.cells[i]!;
        const g = b.grades[i]!;
        const trajectory = trajectorySummary(c.turns);
        const finalAns = mdEscape(truncate(c.run.final_answer ?? '', 200));
        const pCell = isLOnly ? '—' : (g.p ? `${g.p.score}` : '—');
        const pReason = (isLOnly || !g.p) ? '' : mdEscape(g.p.reason);
        const lCell = g.l ? (g.l.pass ? 'pass' : 'fail') : '—';
        const lReason = g.l ? mdEscape(g.l.reason) : '';
        lines.push(
          `| ${c.run.rep} | ${c.run.terminate_reason} | ${c.run.wallclock_ms} | ${c.run.wallclock_ex_skill_ms} | ${postOrientationWallclock(c.run)} | ${c.run.skill_overhead_ms} | ${c.run.first_tool_call_ms} | ${c.run.model_total_ms} | ${c.run.tool_total_ms} | ${c.run.synthesis_ms} | ${c.run.db_ms_total} | ${c.run.turn_count} | ${c.run.tool_call_count} | ${pCell} | ${pReason} | ${lCell} | ${lReason} | ${mdEscape(trajectory)} | ${finalAns} |`,
        );
      }
      lines.push('');
    }
  }

  // Stitch warnings appendix
  const warnedCells = cells
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.run.metrics_stitch_warnings ?? []).length > 0);
  if (warnedCells.length > 0) {
    lines.push('## Metrics-stitch warnings');
    lines.push('');
    for (const { c, i } of warnedCells) {
      lines.push(`- Cell ${i}: arm=${c.run.arm} rep=${c.run.rep} Q="${truncate(c.run.question, 60)}"`);
      for (const w of c.run.metrics_stitch_warnings ?? []) lines.push(`    - ${w}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

interface Bucket { cells: CellLine[]; grades: CellGrades[] }

function bucketCells(cells: ReadonlyArray<CellLine>, grades: ReadonlyArray<CellGrades>): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const k = bucketKey(c.run.arm, c.run.question);
    if (!out.has(k)) out.set(k, { cells: [], grades: [] });
    const b = out.get(k)!;
    b.cells.push(c);
    b.grades.push(grades[i]!);
  }
  return out;
}

function bucketKey(arm: 'a' | 'b', question: string): string { return `${arm}::${question}`; }

// simple → mid → complex.
const TIER_ORDER: readonly ComplexityTier[] = ['simple', 'mid', 'complex'];
function tierKey(tier: ComplexityTier, arm: 'a' | 'b'): string { return `${tier}::${arm}`; }

function bucketCellsByTier(
  cells: ReadonlyArray<CellLine>,
  grades: ReadonlyArray<CellGrades>,
): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const k = tierKey(c.run.complexity_tier, c.run.arm);
    if (!out.has(k)) out.set(k, { cells: [], grades: [] });
    const b = out.get(k)!;
    b.cells.push(c);
    b.grades.push(grades[i]!);
  }
  return out;
}

function trajectorySummary(turns: ReadonlyArray<TurnRecord>): string {
  const names: string[] = [];
  for (const t of turns) for (const c of t.tool_calls) names.push(shortToolName(c));
  return names.join(' → ');
}

function shortToolName(c: ToolCall): string {
  if (c.name === 'mcp__postgresfs__bash') return 'bash';
  return c.name;
}

function termDistribution(cells: ReadonlyArray<CellLine>): string {
  const counts = new Map<string, number>();
  for (const c of cells) counts.set(c.run.terminate_reason, (counts.get(c.run.terminate_reason) ?? 0) + 1);
  return Array.from(counts.entries()).map(([k, v]) => `${k}:${v}`).join(', ');
}

// post_orientation_wallclock_ms = max(0, wallclock_ms − first_tool_call_ms − skill_overhead_ms).
// The cross-arm "composition + synthesis only" view. Subtracts both orientation
// channels:
//   first_tool_call_ms — always-on T1 cost (model digests systemPrompt /
//   description and decides to call any tool). On Arm A: time spent reading
//   the ~5KB orientation.md. On Arm B: time spent reading the 1-line
//   systemPrompt + ~280-char Skill description before deciding to invoke
//   Skill.
//   skill_overhead_ms — on-trigger Skill body cost (Skill region: Skill call
//   + post-Skill planning until first substrate tool call). 0 on Arm A.
// What remains is what each architecture spent ON ACTUAL WORK (substrate calls,
// model synthesis). max(0, ...) guards the abort path where wallclock_ms is 0
// but first_tool_call_ms / skill_overhead_ms may be recorded.
function postOrientationWallclock(run: RunRecord): number {
  return Math.max(0, run.wallclock_ms - run.first_tool_call_ms - run.skill_overhead_ms);
}

function median(ns: ReadonlyArray<number>): number {
  if (ns.length === 0) return NaN;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 0) return (s[mid - 1]! + s[mid]!) / 2;
  return s[mid]!;
}

// R-7 / Excel linear-interpolated percentile.
function percentile(ns: ReadonlyArray<number>, p: number): number {
  if (ns.length === 0) return NaN;
  const s = [...ns].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const w = idx - lo;
  return s[lo]! * (1 - w) + s[hi]! * w;
}

// Median (IQR: q1–q3); rounded to integers for downstream readability.
function formatMedianIQR(values: ReadonlyArray<number>): string {
  if (values.length === 0) return '—';
  const m = percentile(values, 0.5);
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  return `${m.toFixed(0)} (${q1.toFixed(0)}–${q3.toFixed(0)})`;
}

// Like formatMedianIQR but annotates with `[N/M]` when some cells in the
// bucket weren't `end_turn` (max_iterations / question_timeout pin wallclock_ms
// at the per-question cap, pin turns at MAX_TURNS, etc. — including those in
// the median misleads). Used for timing/effort medians.
function formatMedianIQRWithDenominator(values: ReadonlyArray<number>, total: number): string {
  if (values.length === 0) return total > 0 ? `— [0/${total}]` : '—';
  const body = formatMedianIQR(values);
  if (values.length < total) return `${body} [${values.length}/${total}]`;
  return body;
}

// Abbreviations: P=parse_fail, CW=content_wrong, CI=corpus_integrity_fail, TF=trajectory_fail. Zero bins omitted.
function failBreakdownColumn(grades: ReadonlyArray<CellGrades>): string {
  const tally: Record<string, number> = { P: 0, CW: 0, CI: 0, TF: 0 };
  for (const g of grades) {
    const cat = g.fail?.fail_category;
    if (cat === 'parse_fail') tally['P']!++;
    else if (cat === 'content_wrong') tally['CW']!++;
    else if (cat === 'corpus_integrity_fail') tally['CI']!++;
    else if (cat === 'trajectory_fail') tally['TF']!++;
  }
  const parts = Object.entries(tally)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`);
  return parts.length === 0 ? '—' : parts.join(' ');
}

// N/M denominator when some cells weren't gradeable (e.g. terminate ≠ end_turn).
function formatMedianWithDenominator(values: ReadonlyArray<number>, total: number): string {
  if (values.length === 0) return total > 0 ? `— (0/${total})` : '—';
  const m = median(values);
  if (values.length < total) return `${m.toFixed(2)} (${values.length}/${total})`;
  return m.toFixed(2);
}

// pass rate; matches P's N/M denominator.
function formatPassRate(values: ReadonlyArray<boolean>, total: number): string {
  if (values.length === 0) return total > 0 ? `— (0/${total})` : '—';
  const passes = values.filter(Boolean).length;
  if (values.length < total) return `${passes}/${values.length} (${values.length}/${total} judged)`;
  return `${passes}/${values.length}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
