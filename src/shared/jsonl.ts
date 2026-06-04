import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

// Symmetric-only schema: every metric below is captured equivalently on both arms.
// Asymmetric metrics (cache_hits/misses, disk_ms, tool_handler_ms, exit_code) are
// excluded by design — they'd either be N/A on one arm or measure different things
// under the same name.

export interface ToolCall {
  tool_use_id: string;
  name: string;
  input: unknown;
  // tool_ms: end-to-end SDK-measured. db_ms: PostgresFS (A) or sql sidecar (B).
  tool_ms?: number;
  db_ms?: number;
  // Operator-only (Arm B); not aggregated.
  stdout?: string;
  stderr?: string;
  // Set when the SDK fired PostToolUseFailure (tool errored). stderr carries
  // the SDK-supplied error string in that case; flag distinguishes failure
  // from a success-path stderr.
  is_error?: boolean;
  // SDK persisted-output cliff fired on this call. Arm B: tool_response carried
  // `persistedOutputPath` (Bash 30 KB inline-truncate). Arm A: tool_response
  // was replaced with the "Error: result … exceeds maximum allowed tokens"
  // template (MCP 100 KB hard-replace).
  tool_output_truncated?: boolean;
}

export interface TurnRecord {
  turn: number;
  model_ms: number;
  tool_ms: number;
  db_ms?: number;
  in_tokens: number;
  out_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  stop_reason_raw: string;
  tool_calls: ToolCall[];
}

export interface PermissionDenialEvent {
  // SDK exposes only tool_name on permission_denials.
  tool_name: string;
}

export type TerminateReason =
  | 'end_turn' | 'max_tokens' | 'max_iterations'
  | 'api_error' | 'budget_exceeded'
  | 'structured_output_retry_exhausted'
  | 'question_timeout' | 'other';

// Top-level rollups computed once at finalize so renderer/rerun/combine don't
// reimplement summation.
export interface RunRecord {
  // Provenance — each cell line is self-describing across runs.
  run_id: string;
  fixture_sha256: string;
  seed: number;
  model: string;
  rep: number;

  // Preserved by eval-combine when this cell was carried in from another batch;
  // combine overwrites run_id + renumbers rep.
  source_run_id?: string;
  source_rep?: number;

  arm: 'a' | 'b';
  question: string;
  // Denormalized so each .jsonl line is self-describing (questions.ts is the
  // source of truth; field set at runCell finalize).
  complexity_tier: 'simple' | 'mid' | 'complex';

  // SDK `SDKResultMessage.duration_ms` on success; harness-measured elapsed
  // (T_finalize − T_userPromptSubmit) on the !result path so cap-hit cells
  // carry real elapsed time rather than 0.
  wallclock_ms: number;
  // T_first_PreToolUse - T_UserPromptSubmit. 0 when the cell terminated
  // without firing any tool calls (the agent answered directly).
  first_tool_call_ms: number;
  // Contiguous Skill-region cost: sum of (model_ms + tool_ms) for the run of
  // turns starting at the first turn that contains a `Skill` tool_call, up to
  // (but excluding) the first turn that contains a non-Skill tool_call.
  // Captures the published Skill-autotrigger round-trip — model decides to
  // call Skill → SDK resolves Skill → model digests SKILL.md body → first
  // substrate call. 0 on Arm A by construction (no Skill in surface) and 0
  // on Arm B cells where the agent never invoked Skill before substrate work.
  // Mid-trajectory re-invocations (Skill called after substrate work) are
  // NOT counted — those are substrate behavior, not session-start mechanism.
  skill_overhead_ms: number;
  // wallclock_ms − skill_overhead_ms. Models the long-lived-session regime
  // where the skill body persists across queries 2-N. = wallclock_ms on Arm A.
  wallclock_ex_skill_ms: number;
  // Symmetric timing rollups (sum across all turns / tool_calls).
  model_total_ms: number;
  tool_total_ms: number;
  // Last turn's model_ms IF the last turn has zero tool_calls (synthesis-shaped);
  // 0 otherwise. The structural proxy `last.tool_calls.length === 0` is
  // equivalent to "the last turn is a synthesis turn" — an end_turn synthesis
  // turn always has zero tool_calls; a cap-hitting (max_iterations /
  // question_timeout / api_error) last turn typically has ≥1. 0 on those paths
  // signals "no synthesis happened" rather than mislabeling deliberation-
  // before-tool as synthesis.
  synthesis_ms: number;
  // Aggregate of per-call db_ms across the whole cell.
  db_ms_total: number;

  // turns.length == buffered SDKAssistantMessage emits. Distinct from
  // SDKResultMessage.num_turns (coarser per-loop-iteration count).
  turn_count: number;
  tool_call_count: number;
  // Σ(tool_calls[].tool_output_truncated). Per-(question, arm) countable
  // surface for the SDK persisted-output cliff (asymmetric thresholds + recovery
  // mechanisms by arm).
  tool_output_truncated_count: number;
  permission_denials_count: number;
  terminate_reason: TerminateReason;
  final_answer: string | null;
  // 'none' means non-end_turn termination → cell contributes completion-rate only.
  final_answer_source: 'result' | 'none';
  permission_denials: PermissionDenialEvent[];

  input_tokens_total: number;
  output_tokens_total: number;
  cache_read_input_tokens_total: number;
  cache_creation_input_tokens_total: number;

  // Arm-B operator diagnostic; asymmetric → never aggregated cross-arm.
  metrics_stitch_warnings?: string[];

  // Reserved schema slots; renderer's classifyFail populates after grades.
  // Absent on freshly-appended JSONL lines.
  fail_category?: FailCategory | null;
  extras_count?: number;
  dups_count?: number;
  missing_count?: number;
  cite_misses?: number;
}

export type FailCategory =
  | 'parse_fail'
  | 'content_wrong'
  | 'corpus_integrity_fail'
  | 'trajectory_fail';

export class JsonlBuilder {
  private turns: TurnRecord[] = [];
  private finalized = false;

  constructor(private readonly arm: 'a' | 'b', private readonly question: string) {}

  appendTurn(turn: TurnRecord): void {
    if (this.finalized) throw new Error('JsonlBuilder already finalized; cannot appendTurn');
    this.turns.push(turn);
  }

  finalize(run: RunRecord): { turns: TurnRecord[]; run: RunRecord } {
    if (this.finalized) throw new Error('JsonlBuilder already finalized');
    this.finalized = true;
    return { turns: [...this.turns], run };
  }

  snapshot(): { turns: TurnRecord[]; partial: true; arm: 'a' | 'b'; question: string } {
    return { turns: [...this.turns], partial: true, arm: this.arm, question: this.question };
  }
}

// One JSONL line per cell: `{turns:[...], run:{...}}`. Pure cell data; the run
// header (counts, totals) lives in the companion .md.
export async function writeCellLine(opts: {
  outPath: string;
  payload: { turns: TurnRecord[]; run: RunRecord };
}): Promise<void> {
  await mkdir(path.dirname(opts.outPath), { recursive: true });
  const line = JSON.stringify(opts.payload) + '\n';
  await appendFile(opts.outPath, line, 'utf8');
}

export function attachCrashHook(
  currentBuilder: () => JsonlBuilder | undefined,
  crashesDir: string,
): () => void {
  const handler = (err: unknown) => {
    const b = currentBuilder();
    if (!b) { process.exit(1); return; }
    const snap = b.snapshot();
    const ts = new Date().toISOString().replace(/[:.]/g, '');
    const fname = path.join(crashesDir, `${ts}.json`);
    void mkdir(crashesDir, { recursive: true }).then(() =>
      writeFile(fname, JSON.stringify({ snapshot: snap, error: String(err) }, null, 2)),
    ).finally(() => process.exit(1));
  };
  process.on('unhandledRejection', handler);
  process.on('uncaughtException', handler);
  return () => {
    process.off('unhandledRejection', handler);
    process.off('uncaughtException', handler);
  };
}
