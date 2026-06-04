import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  query, AbortError, type Options, type SDKResultMessage, type SDKAssistantMessage,
  type PreToolUseHookInput, type PostToolUseHookInput, type PostToolUseFailureHookInput,
  type UserPromptSubmitHookInput, type SessionEndHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Pool } from 'pg';
import { buildArmAMcpServer, type BuiltArmA } from '../arm-a/mcp-server.js';
import { createWorkdir, removeWorkdir, ARM_B_SKILL_BUNDLE_REL } from '../arm-b/workdir.js';
import { stitchSidecar, countSqlInvocations, type SidecarLine } from '../arm-b/metrics-stitch.js';
import {
  JsonlBuilder, type RunRecord, type TerminateReason, type ToolCall, type TurnRecord,
  type PermissionDenialEvent,
} from './jsonl.js';
import {
  makeHookCtx, recordT0, recordPreTool, recordPostTool, recordPostToolFailure, recordSessionEnd,
} from './hooks.js';
import {
  MAX_TURNS, MAX_QUESTION_MS, MAX_QUESTION_ABORT_GRACE_MS, MODEL,
  STATEMENT_TIMEOUT_MS, baseAgentEnv,
} from './config.js';
import { isTransient } from './transient.js';
import { QUESTIONS, PROBE_QUESTION, type ComplexityTier } from '../eval/questions.js';

// Re-throw wrapper for in-loop SDK transients (the SDK delivers them as
// `SDKResultError`, not as throws), so the batch loop's retry-once catches.
export class TransientApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientApiError';
  }
}

// Unknown prompt is a bug only when cellContext is present (batch path); probe /
// calibration callers fall back to 'simple' since they don't feed the rollup.
function resolveTier(question: string, cellContext: CellContext | undefined): ComplexityTier {
  for (const q of QUESTIONS) if (q.prompt === question) return q.complexity_tier;
  if (question === PROBE_QUESTION.prompt) return PROBE_QUESTION.complexity_tier;
  if (cellContext !== undefined) {
    throw new Error(
      `resolveTier: unknown question for batch cell (cellContext present); ` +
      `prompt=${JSON.stringify(question.slice(0, 100))}`,
    );
  }
  return 'simple';
}

export interface ArmSetup {
  options: Partial<Options>;
  workdir?: string;
  dispose: () => Promise<void>;
}

export async function setupArmA(opts: { pool: Pool; repoRoot: string }): Promise<ArmSetup> {
  const built: BuiltArmA = await buildArmAMcpServer({ pool: opts.pool });
  const orientation = await readFile(path.join(opts.repoRoot, 'src/arm-a/orientation.md'), 'utf8');
  return {
    options: {
      model: MODEL,
      systemPrompt: orientation,
      settingSources: [],
      mcpServers: { postgresfs: built.server },
      permissionMode: 'dontAsk',
      // MCP tool name is formed by the SDK as 'mcp__' + server.name + '__' + tool.name;
      // toolAliases routes model-emitted `Bash` before name lookup. tools:[] disables
      // built-in Bash so it can't shadow the alias.
      toolAliases: { Bash: 'mcp__postgresfs__bash' },
      tools: [],
      allowedTools: ['mcp__postgresfs__bash'],
      maxTurns: MAX_TURNS,
    },
    async dispose() { await built.dispose(); },
  };
}

// Arm B does not borrow from the pool — `./sql` opens its own connection via
// PG_CONNECTION_STRING. ARMB_SIDECAR_PATH is set in run-cell's env block so
// `./sql` writes the sidecar to the workdir regardless of agent cwd drift.
export const ARMB_SIDECAR_BASENAME = '.sql_metrics.jsonl';

export async function setupArmB(opts: { repoRoot: string }): Promise<ArmSetup> {
  const workdir = await createWorkdir({
    prefix: '/tmp/armb_run_',
    uuid: randomUUID(),
    fixture: path.join(opts.repoRoot, ARM_B_SKILL_BUNDLE_REL),
  });
  return {
    options: {
      model: MODEL,
      // 1-line systemPrompt; description carries verb teaching; body arrives on-trigger.
      systemPrompt: 'You are an AI assistant answering questions about the Arize documentation corpus, using the tools provided.',
      settingSources: ['project'],
      skills: ['sql-skill'],
      permissionMode: 'dontAsk',
      // 'Skill' auto-included by the SDK when `skills:` is set; smoke gate
      // asserts the auto-inclusion held.
      allowedTools: ['Bash'],
      cwd: workdir,
      maxTurns: MAX_TURNS,
    },
    workdir,
    async dispose() { await removeWorkdir(workdir); },
  };
}

function deriveTerminateReason(result: SDKResultMessage, aborted: boolean): TerminateReason {
  if (aborted) return 'question_timeout';
  if (result.subtype === 'success') {
    const stop = result.stop_reason;
    if (stop === 'end_turn')    return 'end_turn';
    if (stop === 'max_tokens')  return 'max_tokens';
    return 'other';
  }
  if (result.subtype === 'error_max_turns')                       return 'max_iterations';
  if (result.subtype === 'error_during_execution')                return 'api_error';
  if (result.subtype === 'error_max_budget_usd')                  return 'budget_exceeded';
  if (result.subtype === 'error_max_structured_output_retries')   return 'structured_output_retry_exhausted';
  return 'other';
}

function sum(a: ReadonlyArray<number>): number {
  return a.reduce((s, v) => s + v, 0);
}

// Counts the ./sql script invocations the trajectory exposes. Reuses the
// metrics-stitch helper so the orphan-guard and the stitcher always agree on
// what counts as a `./sql` call.
const ARMB_SQL_SCRIPT_PATH = '.claude/skills/sql-skill/sql';

function countTrajectorySqlInvocations(turns: ReadonlyArray<TurnRecord>): number {
  let n = 0;
  for (const t of turns) {
    for (const tc of t.tool_calls) {
      if (tc.name !== 'Bash') continue;
      const input = tc.input;
      if (input == null || typeof input !== 'object') continue;
      const cmd = (input as Record<string, unknown>)['command'];
      if (typeof cmd !== 'string') continue;
      n += countSqlInvocations(cmd, ARMB_SQL_SCRIPT_PATH);
    }
  }
  return n;
}

// Contiguous Skill-region overhead — see RunRecord.skill_overhead_ms for the
// semantic contract. Walks turns in order: once a turn containing a `Skill`
// tool_call is seen, accumulates (model_ms + tool_ms) for it and every
// subsequent turn until a turn containing a non-Skill tool_call is reached
// (which terminates the region and is NOT counted). Mid-trajectory Skill
// re-invocations that follow substrate work are not counted (the loop has
// already broken at the first substrate call).
function computeSkillOverheadMs(turns: ReadonlyArray<TurnRecord>): number {
  let inSkillRegion = false;
  let overhead = 0;
  for (const t of turns) {
    const hasSubstrate = t.tool_calls.some((c) => c.name !== 'Skill');
    if (hasSubstrate) break;
    const hasSkill = t.tool_calls.some((c) => c.name === 'Skill');
    if (hasSkill) inSkillRegion = true;
    if (inSkillRegion) overhead += t.model_ms + t.tool_ms;
  }
  return overhead;
}

// SDK result usage gives the authoritative cumulative cell token totals.
// Per-turn in_tokens/out_tokens are streamed deltas and undercount the final
// synthesis turn; they remain in TurnRecord for rendering only.
interface CellUsage {
  input_tokens_total: number;
  output_tokens_total: number;
  cache_read_input_tokens_total: number;
  cache_creation_input_tokens_total: number;
}

function usageFromResult(result: SDKResultMessage): CellUsage {
  const u = result.usage;
  return {
    input_tokens_total: u.input_tokens ?? 0,
    output_tokens_total: u.output_tokens ?? 0,
    cache_read_input_tokens_total: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens_total: u.cache_creation_input_tokens ?? 0,
  };
}

const ZERO_USAGE: CellUsage = {
  input_tokens_total: 0,
  output_tokens_total: 0,
  cache_read_input_tokens_total: 0,
  cache_creation_input_tokens_total: 0,
};

interface TurnBuffer {
  turn: number;
  assistantMessage: SDKAssistantMessage;
  // Captured EAGERLY at message arrival, before lastEndOfTurnMs gets overwritten.
  model_ms: number;
}

// Cell provenance; smoke/probe/calibration omit (stub used).
export interface CellContext {
  run_id: string;
  fixture_sha256: string;
  seed: number;
  model: string;
  rep: number;
}

export async function runCell(args: {
  arm: 'a' | 'b';
  question: string;
  emptyConfigDir: string;
  pool: Pool;
  repoRoot: string;
  cellContext?: CellContext;
  onBuilderReady?: (b: JsonlBuilder) => void;
  // Overrides for exercising non-end_turn paths in tests; production callers omit both.
  maxTurns?: number;
  abortAfterMs?: number;
}): Promise<{ turns: TurnRecord[]; run: RunRecord }> {
  const abortController = new AbortController();
  const abortAfterMs = args.abortAfterMs ?? (MAX_QUESTION_MS - MAX_QUESTION_ABORT_GRACE_MS);

  // Run setup before scheduling the abort timer so a setup throw can't orphan it.
  const setup = args.arm === 'a'
    ? await setupArmA({ pool: args.pool, repoRoot: args.repoRoot })
    : await setupArmB({ repoRoot: args.repoRoot });

  const timeout = setTimeout(() => abortController.abort(), abortAfterMs);

  const builder = new JsonlBuilder(args.arm, args.question);
  args.onBuilderReady?.(builder);
  const hookCtx = makeHookCtx();

  let currentTurnIdx = 0;
  let currentTurnBuffer: TurnBuffer | null = null;
  const turnsEmitted: TurnRecord[] = [];
  let totalToolCalls = 0;
  let result: SDKResultMessage | undefined;
  let metrics_stitch_warnings: string[] | undefined;
  // Arm B only. Sidecar-derived db_ms_total — substrate ground truth (one
  // JSONL line per ./sql exec), authoritative for the cross-arm metric.
  // Per-ToolCall attribution lands on every invocation countSqlInvocations
  // recognizes (full-path + bare `./sql`).
  let armBSidecarDbMsTotal: number | undefined;

  function flushTurn(buf: TurnBuffer): void {
    const m = buf.assistantMessage.message;
    const isNewMsg = !hookCtx.seenAssistantMessageIds.has(m.id);
    hookCtx.seenAssistantMessageIds.add(m.id);

    const tools = Array.from(hookCtx.pendingTools.values());
    hookCtx.pendingTools.clear();

    const tool_ms = sum(tools.map(t => t.tool_ms));
    const dbVals  = tools.map(t => t.db_ms).filter((v): v is number => typeof v === 'number');

    const toolCalls: ToolCall[] = tools.map(t => ({
      tool_use_id: t.tool_use_id,
      name: t.name,
      input: t.input,
      tool_ms: t.tool_ms,
      ...(t.db_ms    !== undefined ? { db_ms:    t.db_ms    } : {}),
      ...(t.stdout   !== undefined ? { stdout:   t.stdout   } : {}),
      ...(t.stderr   !== undefined ? { stderr:   t.stderr   } : {}),
      ...(t.is_error === true       ? { is_error: true       } : {}),
      ...(t.tool_output_truncated === true ? { tool_output_truncated: true } : {}),
    }));

    const turn: TurnRecord = {
      turn: buf.turn,
      model_ms: buf.model_ms,
      tool_ms,
      ...(dbVals.length > 0 ? { db_ms: sum(dbVals) } : {}),
      in_tokens:  isNewMsg ? m.usage.input_tokens  : 0,
      out_tokens: isNewMsg ? m.usage.output_tokens : 0,
      ...(isNewMsg && m.usage.cache_read_input_tokens     != null ? { cache_read_input_tokens:     m.usage.cache_read_input_tokens     } : {}),
      ...(isNewMsg && m.usage.cache_creation_input_tokens != null ? { cache_creation_input_tokens: m.usage.cache_creation_input_tokens } : {}),
      stop_reason_raw: m.stop_reason ?? '',
      tool_calls: toolCalls,
    };

    builder.appendTurn(turn);
    turnsEmitted.push(turn);
    totalToolCalls += toolCalls.length;
  }

  try {
    const options: Options = {
      ...(setup.options as Options),
      abortController,
      ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
      env: {
        ...baseAgentEnv(args.emptyConfigDir),
        // Arm B is out-of-process; ./sql needs the PG string directly.
        // ARMB_SIDECAR_PATH pins the sidecar to the workdir so an agent that
        // `cd`s away mid-command (e.g. `cd /tmp && /abs/sql ...`) still emits
        // metrics where the harness reads them.
        ...(args.arm === 'b' && setup.workdir
          ? {
              PG_CONNECTION_STRING: process.env['PG_CONNECTION_STRING'] ?? '',
              ARMB_SIDECAR_PATH: path.join(setup.workdir, ARMB_SIDECAR_BASENAME),
              ARMB_SPILL_DIR: setup.workdir,
              STMT_TIMEOUT_MS: String(STATEMENT_TIMEOUT_MS),
            }
          : {}),
      },
      // SDK types hook input as the full union; per-event cast narrows to the matcher's shape.
      hooks: {
        UserPromptSubmit:   [{ hooks: [async (i) => { recordT0(hookCtx, i as UserPromptSubmitHookInput); return { continue: true }; }] }],
        PreToolUse:         [{ matcher: '.*', hooks: [async (i) => { recordPreTool(hookCtx, i as PreToolUseHookInput); return { continue: true }; }] }],
        PostToolUse:        [{ matcher: '.*', hooks: [async (i) => { recordPostTool(hookCtx, i as PostToolUseHookInput); return { continue: true }; }] }],
        PostToolUseFailure: [{ matcher: '.*', hooks: [async (i) => { recordPostToolFailure(hookCtx, i as PostToolUseFailureHookInput); return { continue: true }; }] }],
        SessionEnd:         [{ hooks: [async (i) => { recordSessionEnd(hookCtx, i as SessionEndHookInput); return { continue: true }; }] }],
      },
    };

    for await (const message of query({ prompt: args.question, options })) {
      if (message.type === 'assistant') {
        const T_assistant = Date.now();
        const model_ms_for_this_turn = Math.max(0, T_assistant - hookCtx.lastEndOfTurnMs);

        if (currentTurnBuffer !== null) {
          flushTurn(currentTurnBuffer);
        }

        currentTurnIdx++;
        currentTurnBuffer = {
          turn: currentTurnIdx,
          assistantMessage: message,
          model_ms: model_ms_for_this_turn,
        };
        hookCtx.lastEndOfTurnMs = T_assistant;
      }
      if (message.type === 'result') {
        result = message;
        if (currentTurnBuffer !== null) {
          flushTurn(currentTurnBuffer);
          currentTurnBuffer = null;
        }
      }
    }
  } catch (err) {
    // Only swallow aborts; rethrow anything else so harness bugs surface
    // instead of being recorded as api_error.
    const isAbort =
      err instanceof AbortError ||
      (err instanceof Error && err.name === 'AbortError') ||
      abortController.signal.aborted;
    if (!isAbort) throw err;
  } finally {
    clearTimeout(timeout);

    // Flush any buffered in-flight turn BEFORE stitch — only matters on the
    // no-result path (success branch flushed at message.type === 'result').
    // Idempotent otherwise. Moved into finally (ahead of stitch) so on abort-
    // mid-tool, stitch sees the complete trajectory including the tool_use
    // whose PostToolUse never fired — otherwise sidecar lines from the in-
    // flight `./sql` are unmatched and a spurious "unmatched line(s)" warning
    // fires.
    if (!result && currentTurnBuffer !== null) {
      flushTurn(currentTurnBuffer);
      currentTurnBuffer = null;
    }

    if (args.arm === 'b' && setup.workdir) {
      // Stitch BEFORE dispose — workdir gets rm -rf'd, taking the sidecar with it.
      let sidecarLines: SidecarLine[] = [];
      let readError: string | null = null;
      try {
        const sidecarPath = path.join(setup.workdir, ARMB_SIDECAR_BASENAME);
        const text = await readFile(sidecarPath, 'utf8');
        sidecarLines = text
          .trim().split('\n').filter(Boolean)
          .map((l) => JSON.parse(l) as SidecarLine);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e?.code !== 'ENOENT') {
          readError = `failed to read sidecar: ${String(e?.message ?? err)}`;
        }
        // ENOENT is the empty-sidecar case (no ./sql calls); sidecarLines stays [].
      }
      const stitch = stitchSidecar(turnsEmitted, sidecarLines);
      metrics_stitch_warnings = readError ? [readError] : stitch.warnings;
      armBSidecarDbMsTotal = stitch.db_ms_total;
      // Warn if ./sql ran but the sidecar didn't measure it (missing file, or
      // present-but-empty db_ms — partial-crash / sub-ms / env-not-honored).
      const scriptInvocations = countTrajectorySqlInvocations(turnsEmitted);
      if (scriptInvocations > 0 && sidecarLines.length === 0) {
        metrics_stitch_warnings = [
          ...metrics_stitch_warnings,
          `trajectory has ${scriptInvocations} ./sql invocation(s) but sidecar absent or empty (ARMB_SIDECAR_PATH=${path.join(setup.workdir, ARMB_SIDECAR_BASENAME)})`,
        ];
      } else if (scriptInvocations > 0 && sidecarLines.length > 0 && stitch.db_ms_total === 0) {
        metrics_stitch_warnings = [
          ...metrics_stitch_warnings,
          `trajectory has ${scriptInvocations} ./sql invocation(s) and ${sidecarLines.length} sidecar line(s) but db_ms_total == 0`,
        ];
      }
    }

    // Recompute per-turn db_ms from (possibly post-stitch) tool_calls. Arm A:
    // idempotent — tool_calls[].db_ms was set at flushTurn from PostToolUse
    // structuredContent. Arm B: tool_calls[].db_ms was just mutated by
    // stitchSidecar; per-turn db_ms picks up the stitched values. Maintains
    // the invariant `TurnRecord.db_ms === Σ tool_calls[].db_ms` on both arms.
    // (TurnRecord objects are referenced by both turnsEmitted and the builder's
    // internal `turns` array, so mutation propagates to both.)
    for (const t of turnsEmitted) {
      const dbVals = t.tool_calls
        .map((c) => c.db_ms)
        .filter((v): v is number => typeof v === 'number');
      if (dbVals.length > 0) t.db_ms = sum(dbVals);
    }

    await setup.dispose();
  }

  const ctx: CellContext = args.cellContext ?? {
    run_id: 'probe', fixture_sha256: '', seed: 0, model: MODEL, rep: 0,
  };
  const aborted = abortController.signal.aborted;

  const model_total_ms = sum(turnsEmitted.map((t) => t.model_ms));
  const tool_total_ms  = sum(turnsEmitted.map((t) => t.tool_ms));
  const last = turnsEmitted[turnsEmitted.length - 1];
  // Synthesis = last turn's model_ms ONLY if that turn has no tool_calls.
  // A no-tool last turn is the "writes final answer after all data is in" shape
  // — present on end_turn cells. On max_iterations/question_timeout/api_error,
  // the last buffered turn is often a cut-off tool turn whose model_ms is
  // pre-tool deliberation, not synthesis. Structural proxy avoids needing
  // terminate_reason here (it isn't derived until after `common`).
  const synthesis_ms = (last && last.tool_calls.length === 0) ? last.model_ms : 0;
  // Arm B: sidecar-derived total (substrate ground truth, one JSONL line per
  // ./sql exec). Arm A: MCP handler returns per-call db_ms in structuredContent,
  // so per-ToolCall sum IS the substrate.
  const db_ms_total = armBSidecarDbMsTotal !== undefined
    ? armBSidecarDbMsTotal
    : sum(turnsEmitted.flatMap((t) => t.tool_calls
        .map((c) => c.db_ms)
        .filter((v): v is number => typeof v === 'number')));
  const usage = result !== undefined ? usageFromResult(result) : ZERO_USAGE;
  const stitchSpread = metrics_stitch_warnings !== undefined ? { metrics_stitch_warnings } : {};

  const skill_overhead_ms = computeSkillOverheadMs(turnsEmitted);
  const tool_output_truncated_count = sum(
    turnsEmitted.flatMap((t) => t.tool_calls.map((c) => (c.tool_output_truncated === true ? 1 : 0))),
  );

  const common = {
    run_id: ctx.run_id, fixture_sha256: ctx.fixture_sha256, seed: ctx.seed, model: ctx.model, rep: ctx.rep,
    arm: args.arm, question: args.question, complexity_tier: resolveTier(args.question, args.cellContext),
    first_tool_call_ms: hookCtx.first_tool_call_ms ?? 0,
    skill_overhead_ms,
    model_total_ms, tool_total_ms, synthesis_ms, db_ms_total,
    turn_count: turnsEmitted.length,
    tool_call_count: totalToolCalls,
    tool_output_truncated_count,
    ...usage,
    ...stitchSpread,
  } as const;

  if (!result) {
    const wallclock_ms = Math.max(0, Date.now() - hookCtx.t_userPromptSubmit_ms);
    return builder.finalize({
      ...common,
      wallclock_ms,
      wallclock_ex_skill_ms: Math.max(0, wallclock_ms - skill_overhead_ms),
      permission_denials_count: 0,
      terminate_reason: aborted ? 'question_timeout' : 'api_error',
      final_answer: null, final_answer_source: 'none',
      permission_denials: [],
    });
  }

  const terminate_reason = deriveTerminateReason(result, aborted);

  // In-loop transients arrive as result messages, not throws — re-throw so
  // the batch loop's retry-once handler fires. Non-transient api_error falls
  // through to log-and-continue.
  if (terminate_reason === 'api_error' && result.subtype === 'error_during_execution') {
    const errMsg = result.errors.join(' | ');
    if (isTransient(errMsg)) {
      throw new TransientApiError(`SDK in-loop transient: ${errMsg.slice(0, 300)}`);
    }
  }

  const finalAnswer = result.subtype === 'success' ? result.result : null;
  const permission_denials: PermissionDenialEvent[] =
    result.permission_denials.map((d) => ({ tool_name: d.tool_name }));

  const wallclock_ms = result.duration_ms ?? 0;
  const wallclock_ex_skill_ms = Math.max(0, wallclock_ms - skill_overhead_ms);

  return builder.finalize({
    ...common,
    wallclock_ms,
    wallclock_ex_skill_ms,
    permission_denials_count: permission_denials.length,
    terminate_reason,
    final_answer: terminate_reason === 'end_turn' ? finalAnswer : null,
    final_answer_source: terminate_reason === 'end_turn' && finalAnswer != null ? 'result' : 'none',
    permission_denials,
  });
}
