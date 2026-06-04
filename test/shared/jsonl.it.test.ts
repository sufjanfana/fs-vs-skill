import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeCellLine, type RunRecord } from '../../src/shared/jsonl.js';

function mkRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'test-run', fixture_sha256: 'sha', seed: 0, model: 'm', rep: 0,
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

describe('writeCellLine append-mode writer', () => {
  let logs: string;
  let outPath: string;

  beforeEach(async () => {
    logs = await mkdtemp(path.join(tmpdir(), 'logs-it-'));
    outPath = path.join(logs, 'run-test.jsonl');
  });
  afterEach(async () => { await rm(logs, { recursive: true, force: true }); });

  it('appends a single newline-terminated JSON line per call', async () => {
    await writeCellLine({ outPath, payload: { turns: [], run: mkRun() } });
    const body = await readFile(outPath, 'utf8');
    expect(body.endsWith('\n')).toBe(true);
    const lines = body.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { run: RunRecord; turns: unknown[] };
    expect(parsed.run.run_id).toBe('test-run');
    expect(parsed.turns).toEqual([]);
  });

  it('emits multiple cells across multiple calls (cells appear in call order)', async () => {
    await writeCellLine({ outPath, payload: { turns: [], run: mkRun({ rep: 0 }) } });
    await writeCellLine({ outPath, payload: { turns: [], run: mkRun({ rep: 1 }) } });
    const lines = (await readFile(outPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { run: RunRecord });
    expect(lines.map((l) => l.run.rep)).toEqual([0, 1]);
  });
});
