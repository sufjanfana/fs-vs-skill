import path from 'node:path';
import { stat } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client, type Pool } from 'pg';
import { MODEL, baseAgentEnv } from '../shared/config.js';
import { setupArmA, setupArmB, runCell } from '../shared/run-cell.js';
import { PROBE_QUESTION } from './questions.js';

export class SmokeGateFailure extends Error {
  constructor(public readonly property: string, message: string) {
    super(`[smoke ${property}] ${message}`);
  }
}

export interface SmokeReport {
  armA: { systemMsg: SDKSystemMessage };
  armB: { systemMsg: SDKSystemMessage };
}

export async function runSmokeGate(args: {
  emptyConfigDir: string;
  pool: Pool;
  repoRoot: string;
}): Promise<SmokeReport> {
  // Pre-flight: Arm B's bundled script must exist and be executable, and the DB role
  // must be read-only. These run before any SDK call so we fail-fast on misconfiguration.
  await checkArmBScriptFile(args.repoRoot);
  await checkReadOnlyRole();

  const armA = await probeArmA(args);
  const armB = await probeArmB(args);

  return { armA: { systemMsg: armA.systemMsg }, armB: { systemMsg: armB.systemMsg } };
}

async function probeArmA(args: { emptyConfigDir: string; pool: Pool; repoRoot: string }) {
  const setup = await setupArmA({ pool: args.pool, repoRoot: args.repoRoot });
  let systemMsg: SDKSystemMessage | undefined;

  try {
    for await (const message of query({
      prompt: 'List the top-level sections of /. Use one bash call.',
      options: {
        ...setup.options,
        env: baseAgentEnv(args.emptyConfigDir),
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') systemMsg = message;
      if (message.type === 'result') break;
    }
  } finally {
    await setup.dispose();
  }

  if (!systemMsg) throw new SmokeGateFailure('arm-a-system', 'no SDKSystemMessage received');
  if (!systemMsg.tools.includes('mcp__postgresfs__bash')) {
    throw new SmokeGateFailure('arm-a-tools', `missing mcp__postgresfs__bash. Got: ${JSON.stringify(systemMsg.tools)}`);
  }
  // No "no other skills" assertion: SDK 0.3.143's `claude` binary surfaces built-in
  // skills in systemMsg.skills regardless of settingSources/skills/env. Plugin-installed
  // skills do not leak.
  if (systemMsg.model !== MODEL) {
    throw new SmokeGateFailure('arm-a-model', `expected ${MODEL}, got ${systemMsg.model}`);
  }
  return { systemMsg };
}

async function probeArmB(args: { emptyConfigDir: string; pool: Pool; repoRoot: string }) {
  const setup = await setupArmB({ repoRoot: args.repoRoot });
  let systemMsg: SDKSystemMessage | undefined;

  try {
    for await (const message of query({
      prompt: 'Echo "ready" and stop.',
      options: {
        ...setup.options,
        env: baseAgentEnv(args.emptyConfigDir),
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') systemMsg = message;
      if (message.type === 'result') break;
    }
  } finally {
    await setup.dispose();
  }

  if (!systemMsg) throw new SmokeGateFailure('arm-b-system', 'no SDKSystemMessage received');
  // sql-skill must load; "no other skills" not asserted (SDK 0.3.143 always reports built-ins).
  if (!(systemMsg.skills ?? []).includes('sql-skill')) {
    throw new SmokeGateFailure('arm-b-skills', `missing 'sql-skill' in skills. Got: ${JSON.stringify(systemMsg.skills)}`);
  }
  if (!systemMsg.tools.includes('Bash')) {
    throw new SmokeGateFailure('arm-b-tools', `missing Bash. Got: ${JSON.stringify(systemMsg.tools)}`);
  }
  if (!systemMsg.tools.includes('Skill')) {
    throw new SmokeGateFailure('arm-b-tools', `missing Skill. Got: ${JSON.stringify(systemMsg.tools)}`);
  }
  if (systemMsg.model !== MODEL) {
    throw new SmokeGateFailure('arm-b-model', `expected ${MODEL}, got ${systemMsg.model}`);
  }

  return { systemMsg };
}

async function checkArmBScriptFile(repoRoot: string): Promise<void> {
  const scriptPath = path.join(repoRoot, 'src/arm-b/skill/.claude/skills/sql-skill/sql');
  let st;
  try {
    st = await stat(scriptPath);
  } catch (err) {
    throw new SmokeGateFailure('arm-b-script-file', `${scriptPath} not found: ${String((err as Error).message)}`);
  }
  if (!st.isFile()) {
    throw new SmokeGateFailure('arm-b-script-file', `${scriptPath} exists but is not a regular file`);
  }
  // 0o111 accepts owner/group/other exec bits — any class can have made it +x.
  const executable = (st.mode & 0o111) !== 0;
  if (!executable) {
    throw new SmokeGateFailure('arm-b-script-file', `${scriptPath} is not executable; chmod +x required`);
  }
}

async function checkReadOnlyRole(): Promise<void> {
  // Bypass the shared pool's default_transaction_read_only so the grants layer
  // (SQLSTATE 42501) is exercised directly.
  const connectionString = process.env.PG_CONNECTION_STRING;
  if (!connectionString) {
    throw new SmokeGateFailure('readonly-role', 'PG_CONNECTION_STRING (docs_ro) required for grants probe');
  }
  const client = new Client({ connectionString, statement_timeout: 5_000 });
  await client.connect();
  try {
    // BEGIN/ROLLBACK ensures any successful INSERT can't persist; INSERT names
    // only `slug` (other columns have defaults; irrelevant to the grants probe).
    await client.query('BEGIN');
    try {
      await client.query("INSERT INTO doc_paths (slug) VALUES ('__smoke__')");
      throw new SmokeGateFailure(
        'readonly-role',
        'INSERT succeeded — PG_CONNECTION_STRING does NOT point at a read-only role',
      );
    } catch (err) {
      if (err instanceof SmokeGateFailure) throw err;
      const code = (err as { code?: string }).code;
      if (code !== '42501') {
        // 42501 = insufficient_privilege (expected). Anything else is unexpected.
        throw new SmokeGateFailure(
          'readonly-role',
          `expected ERROR 42501 (insufficient_privilege) on INSERT; got code=${code} message=${(err as Error).message}`,
        );
      }
    } finally {
      try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
    }
  } finally {
    await client.end();
  }
}

// Achievability probe. Observation-only — ceiling predicates are strings, not gates.
// Runs end-to-end per arm to catch API-path regressions before a full batch.

export interface AchievabilityReport {
  arm: 'a' | 'b';
  tool_call_count: number;
  trajectory: string[];
  terminate_reason: string;
}

export async function runAchievabilityProbe(args: {
  emptyConfigDir: string;
  pool: Pool;
  repoRoot: string;
}): Promise<{ a: AchievabilityReport; b: AchievabilityReport }> {
  const a = await probeArm('a', args);
  const b = await probeArm('b', args);
  return { a, b };
}

async function probeArm(
  arm: 'a' | 'b',
  args: { emptyConfigDir: string; pool: Pool; repoRoot: string },
): Promise<AchievabilityReport> {
  const out = await runCell({ arm, question: PROBE_QUESTION.prompt, ...args });
  const trajectory = out.turns.flatMap((t) => t.tool_calls.map((c) => c.name));
  const tool_call_count = trajectory.length;
  return {
    arm,
    tool_call_count,
    trajectory,
    terminate_reason: out.run.terminate_reason,
  };
}
