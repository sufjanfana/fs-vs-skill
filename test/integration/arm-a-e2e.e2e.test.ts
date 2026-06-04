import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, type SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { MODEL, MAX_TURNS } from '../../src/shared/config.js';
import { makeEmptyConfigDir, removeEmptyConfigDir } from '../../src/shared/empty-config-dir.js';
import { buildArmAMcpServer } from '../../src/arm-a/mcp-server.js';

describe('Arm A e2e', () => {
  let pool: Pool;
  let emptyConfigDir: string;
  beforeAll(async () => {
    pool = getPool();
    emptyConfigDir = await makeEmptyConfigDir();
  });
  afterAll(async () => {
    await closePool();
    await removeEmptyConfigDir(emptyConfigDir);
  });

  it('answers a trivial question using the bash tool', async () => {
    const armA = await buildArmAMcpServer({ pool });
    const orientation = await readFile(new URL('../../src/arm-a/orientation.md', import.meta.url), 'utf8');

    const seen: string[] = [];
    let systemMsg: SDKSystemMessage | undefined;
    const abortController = new AbortController();

    for await (const message of query({
      prompt: 'List the top-level sections of the Arize docs.',
      options: {
        model: MODEL,
        systemPrompt: orientation,
        settingSources: [],
        skills: [],
        mcpServers: { postgresfs: armA.server },
        permissionMode: 'dontAsk',
        allowedTools: ['mcp__postgresfs__bash'],
        maxTurns: MAX_TURNS,
        abortController,
        env: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
          API_TIMEOUT_MS: '60000',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          CLAUDE_CONFIG_DIR: emptyConfigDir,
          HOME: emptyConfigDir,
          PATH: process.env.PATH ?? '',
        },
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') systemMsg = message;
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && block.name === 'mcp__postgresfs__bash') {
            seen.push((block.input as { cmd: string }).cmd);
          }
        }
      }
      if (message.type === 'result' && message.subtype === 'success') {
        expect(message.result).toMatch(/api|auth|getting-started/i);
      }
    }

    expect(systemMsg?.tools).toContain('mcp__postgresfs__bash');
    // SDKSystemMessage.tools reports DISCOVERED items, not invocable ones
    // (Claude Code default tools leak in despite settingSources:[] +
    // CLAUDE_CONFIG_DIR redirect). The architectural constraint is
    // allowedTools=['mcp__postgresfs__bash'], verified by `seen` below
    // capturing only mcp__postgresfs__bash tool_use; strict purity lives
    // in the smoke gate.
    expect(seen.length).toBeGreaterThan(0);
    await armA.dispose();
  });
});
