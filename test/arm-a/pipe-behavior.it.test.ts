// PIPE BEHAVIOR PROBE
//
// Probes pipe composition through Arm A's `_invoke` handler. After the
// composability-operator expansion, the allowlist covers ls/cd/cat/find/grep
// plus the stdin-filter set (sort, uniq, wc, awk, sed, comm, cut, tr, head,
// tail). Pipes compose between any allowlisted commands.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { buildArmAMcpServer } from '../../src/arm-a/mcp-server.js';

describe('Arm A pipe composition under just-bash', () => {
  let pool: Pool;
  beforeAll(async () => { pool = getPool(); });
  afterAll(async () => { await closePool(); });

  it('find -type f | grep -c "^/" composes between two allowlisted verbs', async () => {
    const built = await buildArmAMcpServer({ pool });
    const r = await built._invoke({ cmd: "find / -type f | grep -c '^/'" });
    // Pipe between allowlisted commands produces an integer count, exit 0.
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toMatch(/^\d+$/);
    expect(Number(r.stdout.trim())).toBeGreaterThanOrEqual(1);
  });

  it('find / | wc -l counts files via the allowlisted wc filter', async () => {
    const built = await buildArmAMcpServer({ pool });
    const r = await built._invoke({ cmd: 'find / | wc -l' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toMatch(/^\d+$/);
    expect(Number(r.stdout.trim())).toBeGreaterThanOrEqual(1);
  });

  it('pure stdin pipeline (echo | tr | sort -u | wc -l) returns the distinct count', async () => {
    const built = await buildArmAMcpServer({ pool });
    const r = await built._invoke({ cmd: "echo 'a b a c b' | tr ' ' '\\n' | sort -u | wc -l" });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('3');
  });

  it('grep -rEo … | sort -u dedupes extracted matches (the q8 shape)', async () => {
    const built = await buildArmAMcpServer({ pool });
    // Use a high-frequency literal to guarantee multiple hits with duplicates.
    const r = await built._invoke({
      cmd: "grep -rhEo 'evaluat[a-z]+' / | sort -u",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    // sort -u guarantees uniqueness; expect at least two distinct morphemes
    // (e.g., 'evaluator', 'evaluate', 'evaluators', 'evaluation', ...).
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('grep -rEo … | sort -u | wc -l prefetches against the head only (not against the pipe)', async () => {
    const built = await buildArmAMcpServer({ pool });
    const r = await built._invoke({
      cmd: "grep -rhEo 'evaluat[a-z]+' /ax | sort -u | wc -l",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toMatch(/^\d+$/);
    expect(Number(r.stdout.trim())).toBeGreaterThanOrEqual(2);
    // The handler accumulates db_ms only for the prefetch SQL; pure stdin
    // filters (sort, wc) do not query the substrate.
    expect(r.structuredContent.db_ms).toBeGreaterThan(0);
  });

  // grep-leader pipe: when grep is the leading verb, rewriteForJustBash
  // rebuilds the cmd via shellSplit -> reassemble. The reassembled cmd must
  // keep `|` unquoted so just-bash parses it as a pipe. The earlier
  // `find | grep` test does not exercise this path because find is
  // pass-through; only `grep | <verb>` triggers the rewrite.

  it('grep -ril <pattern> / | grep -v <pattern> filters lines (pipe parses correctly)', async () => {
    const built = await buildArmAMcpServer({ pool });
    const r = await built._invoke({ cmd: 'grep -ril "online" / | grep -v "release-notes"' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.length).toBeGreaterThan(0);
    // The filter must actually drop release-notes paths.
    expect(r.stdout).not.toMatch(/release-notes/);
  });

  it('grep -ril <pattern> / | grep -i <pattern2> composes between two grep filters', async () => {
    const built = await buildArmAMcpServer({ pool });
    const r = await built._invoke({ cmd: 'grep -ril "online" / | grep -i "evaluate"' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    // Surviving lines must all match the second filter (case-insensitive "evaluate").
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    for (const line of lines) expect(line.toLowerCase()).toMatch(/evaluate/);
  });
});
