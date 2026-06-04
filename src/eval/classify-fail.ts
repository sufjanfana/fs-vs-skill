// 4-category failure taxonomy:
//   parse_fail / content_wrong / corpus_integrity_fail / trajectory_fail.
// Sub-field counts flow through unchanged for fine-grained drill-downs.

import type { RunRecord, FailCategory } from '../shared/jsonl.js';
import { isLGradedQuestion, type PGraderResult, type QuestionEntry } from './questions.js';
import type { LGrade } from './render.js';

export interface FailClassification {
  fail_category: FailCategory | null;
  extras_count?: number;
  dups_count?: number;
  missing_count?: number;
  cite_misses?: number;
}

// end_turn / max_tokens are NOT trajectory_fail: end_turn is success; max_tokens
// still produces a final_answer that should be graded on content.
const TRAJECTORY_FAIL_REASONS: ReadonlyArray<RunRecord['terminate_reason']> = [
  'max_iterations',
  'api_error',
  'budget_exceeded',
  'structured_output_retry_exhausted',
  'question_timeout',
];

export function classifyFail(
  run: RunRecord,
  question: QuestionEntry | undefined,
  p: PGraderResult | undefined,
  l: LGrade | undefined,
): FailClassification {
  if (TRAJECTORY_FAIL_REASONS.includes(run.terminate_reason)) {
    return { fail_category: 'trajectory_fail' };
  }

  const isLGraded = question != null && isLGradedQuestion(question);

  if (isLGraded && l?.corpus_integrity_fail) {
    const out: FailClassification = { fail_category: 'corpus_integrity_fail' };
    if (typeof l.cite_misses === 'number') out.cite_misses = l.cite_misses;
    return out;
  }

  // A judge call that errored out (infra failure, not a content verdict) is not
  // a content_wrong — it's a trajectory failure like any other non-answer.
  if (isLGraded && l?.judge_error) {
    return { fail_category: 'trajectory_fail' };
  }

  if (isLGraded) {
    if (l && !l.pass) return { fail_category: 'content_wrong' };
    return { fail_category: null };
  }

  if (p && !p.passed) {
    const out: FailClassification = {
      fail_category: p.parsed ? 'content_wrong' : 'parse_fail',
    };
    if (typeof p.extras_count === 'number') out.extras_count = p.extras_count;
    if (typeof p.dups_count === 'number') out.dups_count = p.dups_count;
    if (typeof p.missing_count === 'number') out.missing_count = p.missing_count;
    return out;
  }

  return { fail_category: null };
}
