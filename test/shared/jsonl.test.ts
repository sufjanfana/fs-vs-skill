import { describe, it, expect } from 'vitest';
import { JsonlBuilder, type TurnRecord, type RunRecord } from '../../src/shared/jsonl.js';

function mkRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'test', fixture_sha256: '', seed: 0, model: 'm', rep: 0,
    arm: 'a', question: 'q', complexity_tier: 'simple', wallclock_ms: 0,
    wallclock_ex_skill_ms: 0, skill_overhead_ms: 0,
    first_tool_call_ms: 0,
    model_total_ms: 0, tool_total_ms: 0, synthesis_ms: 0, db_ms_total: 0,
    turn_count: 0, tool_call_count: 0, tool_output_truncated_count: 0, permission_denials_count: 0,
    terminate_reason: 'end_turn', final_answer: null, final_answer_source: 'none',
    permission_denials: [],
    input_tokens_total: 0, output_tokens_total: 0,
    cache_read_input_tokens_total: 0, cache_creation_input_tokens_total: 0,
    ...over,
  };
}

describe('JsonlBuilder', () => {
  it('accumulates turns in order and finalizes with the run record', () => {
    const b = new JsonlBuilder('a', 'how many auth docs');
    const t1: TurnRecord = { turn: 1, model_ms: 100, tool_ms: 50, in_tokens: 10, out_tokens: 20, stop_reason_raw: 'tool_use', tool_calls: [] };
    const t2: TurnRecord = { turn: 2, model_ms: 80,  tool_ms: 0,  in_tokens: 5,  out_tokens: 30, stop_reason_raw: 'end_turn', tool_calls: [] };
    b.appendTurn(t1); b.appendTurn(t2);
    const run = mkRun({
      arm: 'a', question: 'how many auth docs',
      wallclock_ms: 230, turn_count: 2, model_total_ms: 180, tool_total_ms: 50,
      final_answer: '2', final_answer_source: 'result',
    });
    const out = b.finalize(run);
    expect(out.turns).toEqual([t1, t2]);
    expect(out.run).toEqual(run);
  });

  it('refuses to append after finalize', () => {
    const b = new JsonlBuilder('b', 'q');
    b.finalize(mkRun({ arm: 'b' }));
    expect(() => b.appendTurn({ turn: 1, model_ms: 0, tool_ms: 0, in_tokens: 0, out_tokens: 0, stop_reason_raw: 'end_turn', tool_calls: [] })).toThrow(/finalized/);
  });

  it('refuses to finalize twice', () => {
    const b = new JsonlBuilder('a', 'q');
    const run = mkRun();
    b.finalize(run);
    expect(() => b.finalize(run)).toThrow(/already finalized/);
  });

  it('snapshot returns a partial view without finalizing', () => {
    const b = new JsonlBuilder('a', 'q');
    b.appendTurn({ turn: 1, model_ms: 0, tool_ms: 0, in_tokens: 0, out_tokens: 0, stop_reason_raw: 'tool_use', tool_calls: [] });
    const s = b.snapshot();
    expect(s.partial).toBe(true);
    expect(s.turns.length).toBe(1);
    b.appendTurn({ turn: 2, model_ms: 0, tool_ms: 0, in_tokens: 0, out_tokens: 0, stop_reason_raw: 'end_turn', tool_calls: [] });
    expect(b.snapshot().turns.length).toBe(2);
  });
});
