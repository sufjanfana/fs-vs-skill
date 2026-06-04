// Single-judge self-consistency probe. Re-calls the same Opus judge on a
// deterministic held-out subset (first cell, rep=0, per (arm, L-question))
// and reports inter-call agreement rate as defensible mitigation for the
// single-judge N=1 design. Cost: ~10 extra Opus calls per batch.

import type { CellLine, CellGrades } from './render.js';
import { QUESTIONS, isLGradedQuestion } from './questions.js';

export interface ConsistencyReport {
  // re-called cells that returned a boolean (transients dropped).
  total: number;
  // re-calls that agreed with the original judge verdict.
  agreements: number;
  // (arm, L-question) cells in the held-out set before re-call attempts.
  held_out: number;
}

export async function probeJudgeConsistency(
  cells: ReadonlyArray<CellLine>,
  grades: ReadonlyArray<CellGrades>,
): Promise<ConsistencyReport | null> {
  const heldOut: Array<{ cell: CellLine; grade: CellGrades; rubricKey: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const g = grades[i]!;
    const q = QUESTIONS.find((x) => x.prompt === c.run.question);
    if (!q || !isLGradedQuestion(q)) continue;
    if (c.run.rep !== 0) continue;
    if (!g.l || typeof g.l.pass !== 'boolean') continue;
    // Cite-pre-gate verdicts aren't judge verdicts; re-judging them would
    // measure something else and inflate the disagreement rate.
    if (g.l.corpus_integrity_fail === true) continue;
    const key = `${c.run.arm}::${q.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    heldOut.push({ cell: c, grade: g, rubricKey: q.id });
  }
  if (heldOut.length === 0) return null;

  const { judgeOne } = await import('./grade-judge.js');
  let agreements = 0;
  let total = 0;
  for (const { cell, grade, rubricKey } of heldOut) {
    if (cell.run.final_answer == null || grade.l == null) continue;
    const q = QUESTIONS.find((x) => x.id === rubricKey);
    if (!q) continue;
    try {
      const rerun = await judgeOne(q.l_grader_rubric, cell.run.question, cell.run.final_answer);
      total++;
      if (rerun.pass === grade.l.pass) agreements++;
    } catch {
      // transients dropped (skew worse than smaller N)
    }
  }
  if (total === 0) return null;
  return { agreements, total, held_out: heldOut.length };
}
