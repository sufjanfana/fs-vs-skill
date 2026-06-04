import { describe, it, expect } from 'vitest';
import { classifyFail } from '../../src/eval/classify-fail.js';
import { QUESTIONS } from '../../src/eval/questions.js';
import type { RunRecord } from '../../src/shared/jsonl.js';

function findQ(id: string) {
  const q = QUESTIONS.find((x) => x.id === id);
  if (!q) throw new Error(`Question ${id} not found`);
  return q;
}

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 't', fixture_sha256: '', seed: 0, model: '', rep: 0,
    arm: 'a', question: 'q', complexity_tier: 'simple', wallclock_ms: 0,
    wallclock_ex_skill_ms: 0, skill_overhead_ms: 0,
    first_tool_call_ms: 0, model_total_ms: 0,
    tool_total_ms: 0, synthesis_ms: 0, db_ms_total: 0,
    turn_count: 0, tool_call_count: 0, tool_output_truncated_count: 0, permission_denials_count: 0,
    terminate_reason: 'end_turn',
    final_answer: 'answer', final_answer_source: 'result',
    permission_denials: [],
    input_tokens_total: 0, output_tokens_total: 0,
    cache_read_input_tokens_total: 0, cache_creation_input_tokens_total: 0,
    ...over,
  };
}

describe('classifyFail', () => {
  it('trajectory_fail: max_iterations short-circuits all grade considerations', () => {
    const run = makeRun({ terminate_reason: 'max_iterations' });
    const r = classifyFail(run, findQ('q4'), { score: 1, passed: true, parsed: true, reason: '' }, undefined);
    expect(r.fail_category).toBe('trajectory_fail');
  });

  it('trajectory_fail: question_timeout, api_error, budget_exceeded', () => {
    for (const reason of ['question_timeout', 'api_error', 'budget_exceeded'] as const) {
      const r = classifyFail(makeRun({ terminate_reason: reason }), findQ('q4'), undefined, undefined);
      expect(r.fail_category).toBe('trajectory_fail');
    }
  });

  it('parse_fail: P-grader failed to extract a value (parsed=false)', () => {
    const r = classifyFail(
      makeRun(), findQ('q4'),
      { score: 0, passed: false, parsed: false, reason: 'no number' },
      undefined,
    );
    expect(r.fail_category).toBe('parse_fail');
  });

  it('content_wrong: P-grader parsed but result mismatches', () => {
    const r = classifyFail(
      makeRun(), findQ('q8'),
      { score: 0, passed: false, parsed: true, reason: 'extras', extras_count: 3 },
      undefined,
    );
    expect(r.fail_category).toBe('content_wrong');
    expect(r.extras_count).toBe(3);
  });

  it('corpus_integrity_fail beats content_wrong on L-graded cells', () => {
    const r = classifyFail(
      makeRun(), findQ('q1'), undefined,
      { pass: false, reason: 'cite miss', cite_misses: 2, corpus_integrity_fail: true },
    );
    expect(r.fail_category).toBe('corpus_integrity_fail');
    expect(r.cite_misses).toBe(2);
  });

  it('L-graded content_wrong when judge returned !pass and no integrity flag', () => {
    const r = classifyFail(
      makeRun(), findQ('q7'), undefined,
      { pass: false, reason: 'missed required item' },
    );
    expect(r.fail_category).toBe('content_wrong');
  });

  it('judge infrastructure error is trajectory_fail, not content_wrong', () => {
    const r = classifyFail(
      makeRun(), findQ('q7'), undefined,
      { pass: false, reason: 'judge error: network blip', judge_error: true },
    );
    expect(r.fail_category).toBe('trajectory_fail');
  });

  it('passing P-graded cell yields fail_category: null', () => {
    const r = classifyFail(
      makeRun(), findQ('q4'),
      { score: 1, passed: true, parsed: true, reason: 'ok' },
      undefined,
    );
    expect(r.fail_category).toBeNull();
  });

  it('passing L-graded cell yields fail_category: null', () => {
    const r = classifyFail(
      makeRun(), findQ('q1'), undefined,
      { pass: true, reason: 'ok' },
    );
    expect(r.fail_category).toBeNull();
  });
});
