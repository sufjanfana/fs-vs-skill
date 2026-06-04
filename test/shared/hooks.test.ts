import { describe, it, expect } from 'vitest';
import {
  makeHookCtx,
  recordT0,
  recordPreTool,
  recordPostTool,
  recordPostToolFailure,
  recordSessionEnd,
} from '../../src/shared/hooks.js';
import type {
  PreToolUseHookInput, PostToolUseHookInput, PostToolUseFailureHookInput,
  UserPromptSubmitHookInput, SessionEndHookInput,
} from '@anthropic-ai/claude-agent-sdk';

// Minimal BaseHookInput stub. The recorders don't read these but the SDK types
// require them, so a small spread keeps the test types honest without inventing
// session state per test.
const BASE = { session_id: 's1', transcript_path: '/dev/null', cwd: '/tmp' };

describe('hooks (per-turn accumulators)', () => {
  it('PostToolUse populates pendingTools with db_ms from a JSON-encoded tool_response (SDK 0.3.143 shape)', () => {
    const ctx = makeHookCtx();
    recordT0(ctx, { ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'q' } as UserPromptSubmitHookInput);
    recordPreTool(ctx, { ...BASE, hook_event_name: 'PreToolUse', tool_use_id: 't1', tool_name: 'mcp__postgresfs__bash', tool_input: { cmd: 'ls /' } } as PreToolUseHookInput);
    recordPostTool(ctx, {
      ...BASE, hook_event_name: 'PostToolUse',
      tool_use_id: 't1',
      tool_name: 'mcp__postgresfs__bash',
      tool_input: { cmd: 'ls /' },
      duration_ms: 100,
      tool_response: JSON.stringify({ stdout: 'api/\nauth/\n', stderr: '', exitCode: 0, db_ms: 12, cache_hits: 0, cache_misses: 1 }),
    } as PostToolUseHookInput);
    const pt = ctx.pendingTools.get('t1');
    expect(pt).toBeDefined();
    expect(pt!.name).toBe('mcp__postgresfs__bash');
    expect(pt!.tool_ms).toBe(100);
    expect(pt!.db_ms).toBe(12);
    expect(pt!.stdout).toBe('api/\nauth/\n');
  });

  it('non-JSON tool_response (Skill body / native Bash output) captures raw string as stdout, no substrate fields', () => {
    const ctx = makeHookCtx();
    recordPostTool(ctx, {
      ...BASE, hook_event_name: 'PostToolUse',
      tool_use_id: 't4', tool_name: 'Skill', tool_input: { skill: 'sql-skill' },
      duration_ms: 6,
      tool_response: 'plain text body that is not JSON',
    } as PostToolUseHookInput);
    const pt = ctx.pendingTools.get('t4')!;
    expect(pt.tool_ms).toBe(6);
    expect(pt.db_ms).toBeUndefined();
    expect(pt.stdout).toBe('plain text body that is not JSON');
  });

  it('Arm B native Bash raw-string tool_response is captured as stdout (trajectory observability)', () => {
    const ctx = makeHookCtx();
    recordPostTool(ctx, {
      ...BASE, hook_event_name: 'PostToolUse',
      tool_use_id: 't5', tool_name: 'Bash', tool_input: { command: 'ls' },
      duration_ms: 12,
      tool_response: 'file1.mdx\nfile2.mdx\n',
    } as PostToolUseHookInput);
    const pt = ctx.pendingTools.get('t5')!;
    expect(pt.name).toBe('Bash');
    expect(pt.stdout).toBe('file1.mdx\nfile2.mdx\n');
    expect(pt.stderr).toBeUndefined();
    expect(pt.db_ms).toBeUndefined();
  });

  it('object-shape tool_response (defensive: some SDK versions pass through unwrapped) populates fields directly', () => {
    const ctx = makeHookCtx();
    recordPostTool(ctx, {
      ...BASE, hook_event_name: 'PostToolUse',
      tool_use_id: 't6', tool_name: 'X', tool_input: {}, duration_ms: 7,
      tool_response: { stdout: 'hello', db_ms: 4 } as unknown,
    } as PostToolUseHookInput);
    const pt = ctx.pendingTools.get('t6')!;
    expect(pt.stdout).toBe('hello');
    expect(pt.db_ms).toBe(4);
  });

  it('PostToolUseFailure accumulates duration_ms + captures error to stderr + sets is_error', () => {
    const ctx = makeHookCtx();
    recordPostTool(ctx, {
      ...BASE, hook_event_name: 'PostToolUse',
      tool_use_id: 't2', tool_name: 'X', tool_input: {}, duration_ms: 50,
      tool_response: JSON.stringify({}),
    } as PostToolUseHookInput);
    recordPostToolFailure(ctx, { ...BASE, hook_event_name: 'PostToolUseFailure', tool_use_id: 't2', tool_name: 'X', tool_input: {}, error: 'boom', duration_ms: 25 } as PostToolUseFailureHookInput);
    const pt = ctx.pendingTools.get('t2')!;
    expect(pt.tool_ms).toBe(75);
    expect(pt.is_error).toBe(true);
    expect(pt.stderr).toBe('boom');
  });

  it('PostToolUseFailure on unseen tool_use_id records tool_name + error string + is_error', () => {
    const ctx = makeHookCtx();
    recordPostToolFailure(ctx, {
      ...BASE, hook_event_name: 'PostToolUseFailure',
      tool_use_id: 't3', tool_name: 'Bash', tool_input: { command: 'foo' },
      error: 'refusing to run inside the skill bundle', duration_ms: 40,
    } as PostToolUseFailureHookInput);
    expect(ctx.pendingTools.get('t3')).toMatchObject({
      name: 'Bash', tool_ms: 40, input: { command: 'foo' },
      is_error: true, stderr: 'refusing to run inside the skill bundle',
    });
  });

  it('PostToolUseFailure preserves an existing success-path stderr by appending', () => {
    const ctx = makeHookCtx();
    recordPostTool(ctx, {
      ...BASE, hook_event_name: 'PostToolUse',
      tool_use_id: 't7', tool_name: 'Bash', tool_input: { command: 'foo' },
      duration_ms: 5,
      tool_response: JSON.stringify({ stdout: '', stderr: 'warn: deprecated\n', exitCode: 0 }),
    } as PostToolUseHookInput);
    recordPostToolFailure(ctx, {
      ...BASE, hook_event_name: 'PostToolUseFailure',
      tool_use_id: 't7', tool_name: 'Bash', tool_input: { command: 'foo' },
      error: 'killed', duration_ms: 1,
    } as PostToolUseFailureHookInput);
    const pt = ctx.pendingTools.get('t7')!;
    expect(pt.is_error).toBe(true);
    expect(pt.stderr).toBe('warn: deprecated\n\nkilled');
  });

  it('recordPreTool sets first_tool_call_ms once, as T_first_PreToolUse - T_UserPromptSubmit', async () => {
    const ctx = makeHookCtx();
    recordT0(ctx, { ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'q' } as UserPromptSubmitHookInput);
    expect(ctx.first_tool_call_ms).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    recordPreTool(ctx, { ...BASE, hook_event_name: 'PreToolUse', tool_use_id: 't1', tool_name: 'X', tool_input: {} } as PreToolUseHookInput);
    const firstCapture = ctx.first_tool_call_ms;
    expect(firstCapture).toBeGreaterThanOrEqual(8);
    // Subsequent PreToolUse events do NOT overwrite.
    await new Promise((r) => setTimeout(r, 10));
    recordPreTool(ctx, { ...BASE, hook_event_name: 'PreToolUse', tool_use_id: 't2', tool_name: 'X', tool_input: {} } as PreToolUseHookInput);
    expect(ctx.first_tool_call_ms).toBe(firstCapture);
  });

  it('recordSessionEnd is a no-op (RunRecord is built by run-cell.ts)', () => {
    const ctx = makeHookCtx();
    expect(() => recordSessionEnd(ctx, { ...BASE, hook_event_name: 'SessionEnd', reason: 'clear' } as SessionEndHookInput)).not.toThrow();
  });
});
