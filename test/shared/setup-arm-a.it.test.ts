// Pins the option shape that wires the agent to emit `Bash` while routing to
// the MCP tool. `toolAliases` redirects the model-emitted name before lookup,
// `tools: []` disables built-in Bash so it can't shadow the alias, and
// `allowedTools` references the RESOLVED MCP name.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { setupArmA } from '../../src/shared/run-cell.js';

const REPO_ROOT = path.resolve(process.cwd());

describe('setupArmA option shape (toolAliases wiring)', () => {
  let pool: Pool;
  beforeAll(() => { pool = getPool(); });
  afterAll(async () => { await closePool(); });

  it('toolAliases maps Bash to mcp__postgresfs__bash', async () => {
    const setup = await setupArmA({ pool, repoRoot: REPO_ROOT });
    try {
      expect(setup.options.toolAliases).toEqual({ Bash: 'mcp__postgresfs__bash' });
    } finally {
      await setup.dispose();
    }
  });

  it('tools: [] disables built-in Bash so it cannot shadow the alias', async () => {
    const setup = await setupArmA({ pool, repoRoot: REPO_ROOT });
    try {
      expect(setup.options.tools).toEqual([]);
    } finally {
      await setup.dispose();
    }
  });

  it('allowedTools still references the resolved MCP name', async () => {
    const setup = await setupArmA({ pool, repoRoot: REPO_ROOT });
    try {
      expect(setup.options.allowedTools).toEqual(['mcp__postgresfs__bash']);
    } finally {
      await setup.dispose();
    }
  });
});
