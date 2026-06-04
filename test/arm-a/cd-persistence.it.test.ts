import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { buildArmAMcpServer } from '../../src/arm-a/mcp-server.js';

describe('cd persistence across MCP invocations on the same Bash instance', () => {
  let pool: Pool;
  beforeAll(async () => { pool = getPool(); });
  afterAll(async () => { await closePool(); });

  // Live-corpus anchors:
  //   /ax/        → 9 subdirs incl. `cookbooks/`, `integrations/`
  //   /link/      → 2 files (`otel.mdx`, `phoenix.mdx`); no subdirs
  //   /api-clients/ → top-level section dir
  // These shapes are stable: every Arize doc lives under one of `ax`,
  // `api-clients`, `link` (verified against doc_paths' top segments).

  it('cd /ax then ls reads from /ax', async () => {
    const built = await buildArmAMcpServer({ pool });
    const cd = await built._invoke({ cmd: 'cd /ax' });
    expect(cd.exitCode).toBe(0);
    const ls = await built._invoke({ cmd: 'ls' });
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toMatch(/cookbooks\//);
    expect(ls.stdout).toMatch(/integrations\//);
    expect(ls.stdout).not.toMatch(/api-clients\//);
  });

  it('cd /ax then cd / then ls reads from /', async () => {
    const built = await buildArmAMcpServer({ pool });
    await built._invoke({ cmd: 'cd /ax' });
    await built._invoke({ cmd: 'cd /' });
    const ls = await built._invoke({ cmd: 'ls' });
    expect(ls.stdout).toMatch(/ax\//);
    expect(ls.stdout).toMatch(/api-clients\//);
    expect(ls.stdout).toMatch(/link\//);
  });

  it('cd to a nonexistent path exits non-zero and does not move cwd', async () => {
    const built = await buildArmAMcpServer({ pool });
    await built._invoke({ cmd: 'cd /ax' });
    const bad = await built._invoke({ cmd: 'cd /does-not-exist' });
    expect(bad.exitCode).not.toBe(0);
    const ls = await built._invoke({ cmd: 'ls' });
    expect(ls.stdout).toMatch(/cookbooks\//);  // still in /ax
  });

  it('cd (no arg) returns to /', async () => {
    const built = await buildArmAMcpServer({ pool });
    await built._invoke({ cmd: 'cd /ax' });
    const noArg = await built._invoke({ cmd: 'cd' });
    expect(noArg.exitCode).toBe(0);
    const ls = await built._invoke({ cmd: 'ls' });
    expect(ls.stdout).toMatch(/ax\//);
    expect(ls.stdout).toMatch(/api-clients\//);
  });

  it('cd ~ returns to /', async () => {
    const built = await buildArmAMcpServer({ pool });
    await built._invoke({ cmd: 'cd /ax' });
    const home = await built._invoke({ cmd: 'cd ~' });
    expect(home.exitCode).toBe(0);
    const ls = await built._invoke({ cmd: 'ls' });
    expect(ls.stdout).toMatch(/ax\//);
    expect(ls.stdout).toMatch(/link\//);
  });

  it('cd - returns to the previous directory', async () => {
    const built = await buildArmAMcpServer({ pool });
    await built._invoke({ cmd: 'cd /ax' });
    await built._invoke({ cmd: 'cd /link' });
    const back = await built._invoke({ cmd: 'cd -' });
    expect(back.exitCode).toBe(0);
    const ls = await built._invoke({ cmd: 'ls' });
    expect(ls.stdout).toMatch(/cookbooks\//);  // back in /ax
    expect(ls.stdout).not.toMatch(/otel\.mdx/);
  });
});
