import type {
  PreToolUseHookInput, PostToolUseHookInput, PostToolUseFailureHookInput,
  UserPromptSubmitHookInput, SessionEndHookInput,
} from '@anthropic-ai/claude-agent-sdk';

// Per-turn pending tool buffer. Symmetric fields only: tool_ms + db_ms.
// Arm B's db_ms is post-stitched from .sql_metrics.jsonl.
export interface PendingTool {
  tool_use_id: string;
  name: string;
  input: unknown;
  tool_ms: number;
  db_ms?: number;
  stdout?: string;
  stderr?: string;
  // True when PostToolUseFailure fired for this id; stderr carries the SDK
  // error string. Distinguishes failure path from success-with-stderr.
  is_error?: boolean;
  // SDK persisted-output cliff fired on this call (asymmetric by arm).
  tool_output_truncated?: boolean;
}

export interface HookCtx {
  seenAssistantMessageIds: Set<string>;
  pendingTools: Map<string, PendingTool>;
  // Anchor for model_ms; bumped on UserPromptSubmit + assistant-message arrival + post-tool events.
  lastEndOfTurnMs: number;
  // Cell-start timestamp; anchor for first_tool_call_ms.
  t_userPromptSubmit_ms: number;
  // Set on the first PreToolUse event of the cell; undefined if no tools fire.
  first_tool_call_ms?: number;
}

export function makeHookCtx(): HookCtx {
  const now = Date.now();
  return {
    seenAssistantMessageIds: new Set(),
    pendingTools: new Map(),
    lastEndOfTurnMs: now,
    t_userPromptSubmit_ms: now,
  };
}

export function recordT0(ctx: HookCtx, _i?: UserPromptSubmitHookInput): void {
  const now = Date.now();
  ctx.lastEndOfTurnMs = now;
  ctx.t_userPromptSubmit_ms = now;
}

export function recordPreTool(ctx: HookCtx, _input: PreToolUseHookInput): void {
  if (ctx.first_tool_call_ms === undefined) {
    ctx.first_tool_call_ms = Date.now() - ctx.t_userPromptSubmit_ms;
  }
}

// `input.tool_response` is a JSON-encoded string in SDK ≥0.3.143 — parse and read
// top-level keys (stdout, stderr, db_ms, …); non-JSON falls through to {}.
export function recordPostTool(ctx: HookCtx, input: PostToolUseHookInput): void {
  const id = input.tool_use_id;
  const sc = parseToolResponse(input.tool_response);
  const dur = input.duration_ms ?? 0;
  const stdoutSnippet = typeof sc['stdout'] === 'string' ? (sc['stdout'] as string) : undefined;
  const stderrSnippet = typeof sc['stderr'] === 'string' ? (sc['stderr'] as string) : undefined;
  const db_ms = typeof sc['db_ms'] === 'number' ? (sc['db_ms'] as number) : undefined;
  const truncated = detectTruncation(input.tool_response, sc);

  const existing = ctx.pendingTools.get(id);
  if (existing) {
    existing.tool_ms += dur;
    if (db_ms !== undefined) existing.db_ms = db_ms;
    if (stdoutSnippet !== undefined) existing.stdout = stdoutSnippet;
    if (stderrSnippet !== undefined) existing.stderr = stderrSnippet;
    if (truncated) existing.tool_output_truncated = true;
  } else {
    ctx.pendingTools.set(id, {
      tool_use_id: id,
      name: input.tool_name,
      input: input.tool_input,
      tool_ms: dur,
      ...(db_ms !== undefined ? { db_ms } : {}),
      ...(stdoutSnippet !== undefined ? { stdout: stdoutSnippet } : {}),
      ...(stderrSnippet !== undefined ? { stderr: stderrSnippet } : {}),
      ...(truncated ? { tool_output_truncated: true } : {}),
    });
  }
  ctx.lastEndOfTurnMs = Date.now();
}

// Bash 30 KB path: parsed object carries `persistedOutputPath`.
// MCP 100 KB path: raw response is the "Error: result … exceeds maximum allowed
// tokens. Output has been saved to …" string template.
function detectTruncation(tr: unknown, parsed: Record<string, unknown>): boolean {
  if (typeof parsed['persistedOutputPath'] === 'string') return true;
  if (typeof tr === 'string' && tr.startsWith('Error: result (') && tr.includes('exceeds maximum allowed tokens')) {
    return true;
  }
  return false;
}

// Failure event carries real tool_name + tool_input so the pending entry reflects
// the real tool, not '<unknown>'. The SDK-supplied error string lands in
// stderr so the existing trajectory renderer surfaces it; is_error flags this
// as the failure path so JSONL readers can distinguish failure from
// success-with-stderr.
export function recordPostToolFailure(ctx: HookCtx, input: PostToolUseFailureHookInput): void {
  const id = input.tool_use_id;
  const dur = input.duration_ms ?? 0;
  const errStr = input.error;
  const existing = ctx.pendingTools.get(id);
  if (existing) {
    existing.tool_ms += dur;
    existing.is_error = true;
    if (errStr.length > 0) {
      existing.stderr = existing.stderr !== undefined && existing.stderr.length > 0
        ? `${existing.stderr}\n${errStr}`
        : errStr;
    }
  } else {
    ctx.pendingTools.set(id, {
      tool_use_id: id,
      name: input.tool_name,
      input: input.tool_input,
      tool_ms: dur,
      is_error: true,
      ...(errStr.length > 0 ? { stderr: errStr } : {}),
    });
  }
  ctx.lastEndOfTurnMs = Date.now();
}

export function recordSessionEnd(_ctx: HookCtx, _input: SessionEndHookInput): void {
  // no-op
}

// Arm A's MCP custom tool serializes structuredContent as a JSON-encoded string
// (SDK ≥0.3.143). Arm B's native Bash + Skill deliver raw text bodies. Some SDK
// versions pass through unwrapped object responses. All three shapes are
// captured so trajectory observability stays symmetric across arms.
function parseToolResponse(tr: unknown): Record<string, unknown> {
  if (tr == null) return {};
  if (typeof tr === 'string') {
    try {
      const parsed = JSON.parse(tr) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* fall through */ }
    return { stdout: tr };
  }
  if (typeof tr === 'object' && !Array.isArray(tr)) {
    return tr as Record<string, unknown>;
  }
  return {};
}
