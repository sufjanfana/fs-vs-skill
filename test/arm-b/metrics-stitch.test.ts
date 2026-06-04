import { describe, it, expect } from 'vitest';
import { stitchSidecar, countSqlInvocations, type SidecarLine } from '../../src/arm-b/metrics-stitch.js';
import type { TurnRecord } from '../../src/shared/jsonl.js';

const SCRIPT = '.claude/skills/sql-skill/sql';

function turn(tool_calls: TurnRecord['tool_calls']): TurnRecord {
  return {
    turn: 1, model_ms: 100, tool_ms: 0, in_tokens: 0, out_tokens: 0,
    stop_reason_raw: 'tool_use', tool_calls,
  };
}

function line(over: Partial<SidecarLine> = {}): SidecarLine {
  return {
    t_start_ms: 1000, t_end_ms: 1050,
    db_ms: 12,
    row_count: 5, mode: 'inline', result_path: null,
    ...over,
  };
}

describe('stitchSidecar', () => {
  it('pairs sidecar lines 1:1 with ./sql Bash calls', () => {
    const turns = [turn([
      { tool_use_id: 't1', name: 'Bash', input: { command: `${SCRIPT} 'SELECT 1'` } },
      { tool_use_id: 't2', name: 'Bash', input: { command: `cat result_1.ndjson | jq .` } },
      { tool_use_id: 't3', name: 'Bash', input: { command: `${SCRIPT} 'SELECT 2'` } },
    ])];
    const lines = [line({ db_ms: 10 }), line({ db_ms: 20 })];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(r.warnings).toEqual([]);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBe(10);
    expect(turns[0]!.tool_calls[1]!.db_ms).toBeUndefined();
    expect(turns[0]!.tool_calls[2]!.db_ms).toBe(20);
  });

  it('aggregates db_ms when one Bash call chains multiple ./sql invocations', () => {
    const turns = [turn([
      { tool_use_id: 't1', name: 'Bash', input: { command: `${SCRIPT} 'q1' && ${SCRIPT} 'q2'` } },
    ])];
    const lines = [
      line({ db_ms: 10 }),
      line({ db_ms: 30 }),
    ];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(r.warnings).toEqual([]);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBe(40);
  });

  it('advances sidecar pointer across multiple turns (cross-turn stitch)', () => {
    const turns: TurnRecord[] = [
      turn([{ tool_use_id: 't1', name: 'Bash', input: { command: `${SCRIPT} 'q1'` } }]),
      // turn 2 has no ./sql call
      { turn: 2, model_ms: 50, tool_ms: 0, in_tokens: 0, out_tokens: 0, stop_reason_raw: 'tool_use',
        tool_calls: [{ tool_use_id: 't2', name: 'Bash', input: { command: 'cat result_1.ndjson' } }] },
      // turn 3 has another ./sql call — pointer must advance to second sidecar line
      { turn: 3, model_ms: 50, tool_ms: 0, in_tokens: 0, out_tokens: 0, stop_reason_raw: 'tool_use',
        tool_calls: [{ tool_use_id: 't3', name: 'Bash', input: { command: `${SCRIPT} 'q2'` } }] },
    ];
    const lines = [line({ db_ms: 10 }), line({ db_ms: 99 })];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(r.warnings).toEqual([]);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBe(10);
    expect(turns[2]!.tool_calls[0]!.db_ms).toBe(99);
  });

  it('warns when sidecar has fewer lines than ./sql Bash calls', () => {
    const turns = [turn([
      { tool_use_id: 't1', name: 'Bash', input: { command: `${SCRIPT} 'q1'` } },
      { tool_use_id: 't2', name: 'Bash', input: { command: `${SCRIPT} 'q2'` } },
    ])];
    const lines = [line({ db_ms: 10 })];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/sidecar exhausted/);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBe(10);
    expect(turns[0]!.tool_calls[1]!.db_ms).toBeUndefined();
  });

  it('warns when sidecar has more lines than the trajectory consumes', () => {
    const turns = [turn([
      { tool_use_id: 't1', name: 'Bash', input: { command: `${SCRIPT} 'q1'` } },
    ])];
    const lines = [line({ db_ms: 10 }), line({ db_ms: 20 })];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/unmatched line/);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBe(10);
  });

  it('is a no-op when sidecar is empty and no ./sql calls happened', () => {
    const turns = [turn([
      { tool_use_id: 't1', name: 'Bash', input: { command: 'echo hello' } },
    ])];
    const r = stitchSidecar(turns, [], SCRIPT);
    expect(r.warnings).toEqual([]);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBeUndefined();
  });

  it('ignores non-Bash tool calls', () => {
    const turns = [turn([
      { tool_use_id: 't1', name: 'Skill', input: { name: 'sql-skill' } },
      { tool_use_id: 't2', name: 'Bash', input: { command: `${SCRIPT} 'q'` } },
    ])];
    const lines = [line({ db_ms: 7 })];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(r.warnings).toEqual([]);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBeUndefined();
    expect(turns[0]!.tool_calls[1]!.db_ms).toBe(7);
  });

  it("matches the `cd <bundle> && ./sql 'q'` cd-then-bare pattern", () => {
    // Without the cd-gated regex, the literal substring `.claude/skills/sql-skill/sql`
    // never appears (the cd target ends at `sql-skill && ./sql` — no second `/sql`).
    const turns = [turn([
      { tool_use_id: 't1', name: 'Bash', input: {
        command: `cd /tmp/armb_run_xyz/.claude/skills/sql-skill && ./sql 'SELECT 1'`,
      } },
    ])];
    const lines = [line({ db_ms: 13 })];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(r.warnings).toEqual([]);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBe(13);
  });

  it('aggregates db_ms for chained `cd && ./sql A && ./sql B`', () => {
    const turns = [turn([
      { tool_use_id: 't1', name: 'Bash', input: {
        command: `cd /tmp/armb_run_xyz/.claude/skills/sql-skill && ./sql 'A' && ./sql 'B'`,
      } },
    ])];
    const lines = [line({ db_ms: 5 }), line({ db_ms: 8 })];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(r.warnings).toEqual([]);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBe(13);
  });

  // q7/q10/q8 pre-flight pattern: agent does
  //   turn-N:   `cd <bundle> && ./sql 'A'`   (cwd is now sql-skill dir)
  //   turn-N+1: `./sql 'B'`                  (cwd persisted across exec()s)
  // Both invocations are the bundled script — bare `./sql` matches BARE_REL_RE
  // unconditionally so per-call attribution lands on every turn.
  it('stitches sidecar across cd-then-bare-./sql multi-turn pattern', () => {
    const turns: TurnRecord[] = [
      { turn: 1, model_ms: 100, tool_ms: 0, in_tokens: 0, out_tokens: 0, stop_reason_raw: 'tool_use',
        tool_calls: [{ tool_use_id: 't1', name: 'Bash', input: {
          command: `cd /tmp/armb_run_xyz/.claude/skills/sql-skill && ./sql 'A'`,
        } }] },
      { turn: 2, model_ms: 100, tool_ms: 0, in_tokens: 0, out_tokens: 0, stop_reason_raw: 'tool_use',
        tool_calls: [{ tool_use_id: 't2', name: 'Bash', input: { command: `./sql 'B'` } }] },
    ];
    const lines = [line({ db_ms: 30 }), line({ db_ms: 70 })];
    const r = stitchSidecar(turns, lines, SCRIPT);
    expect(turns[0]!.tool_calls[0]!.db_ms).toBe(30);
    expect(turns[1]!.tool_calls[0]!.db_ms).toBe(70);
    expect(r.db_ms_total).toBe(100);
    expect(r.warnings).toEqual([]);
  });
});

describe('countSqlInvocations', () => {
  it('counts canonical full-path invocations (current + legacy recovery shape)', () => {
    expect(countSqlInvocations(`${SCRIPT} 'SELECT 1'`)).toBe(1);
    expect(countSqlInvocations(`cd /tmp && /abs/path/${SCRIPT} 'A'`)).toBe(1);
    expect(countSqlInvocations(`${SCRIPT} 'A' && ${SCRIPT} 'B'`)).toBe(2);
  });

  it('counts `cd <bundle> && ./sql ...` (natural cd-then-bare pattern)', () => {
    expect(countSqlInvocations(`cd /tmp/foo/sql-skill && ./sql 'A'`)).toBe(1);
    expect(countSqlInvocations(`cd /tmp/foo/sql-skill && ./sql 'A' && ./sql 'B'`)).toBe(2);
  });

  it('counts mixed forms', () => {
    expect(countSqlInvocations(`${SCRIPT} 'A' && ./sql 'B'`)).toBe(2);
  });

  it('does not false-positive on bare `mysql` / `psql`', () => {
    expect(countSqlInvocations(`mysql -u root -e 'SELECT'`)).toBe(0);
    expect(countSqlInvocations(`psql -c 'SELECT'`)).toBe(0);
  });

  it('counts bare `./sql` unconditionally (workdir contains only the bundled script)', () => {
    // Arm B's workdir contains exactly one ./sql script (the sql-skill bundle).
    // A bare `./sql` from any other cwd would fail at exec time and write no
    // sidecar line; that surfaces as the existing "sidecar exhausted" warning
    // rather than a silent drop of legitimate cd-then-bare attribution.
    expect(countSqlInvocations(`cd /tmp && ./sql 'foo'`)).toBe(1);
    expect(countSqlInvocations(`./sql 'bare'`)).toBe(1);
  });
});
