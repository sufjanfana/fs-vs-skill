import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getPool, closePool } from '../../src/shared/db.js';
import { buildArmAMcpServer } from '../../src/arm-a/mcp-server.js';

describe('Arm A MCP server', () => {
  let pool: Pool;

  beforeAll(async () => { pool = getPool(); });
  afterAll(async () => { await closePool(); });

  it('builds a server with a single `bash` tool', async () => {
    const built = await buildArmAMcpServer({ pool });
    expect(typeof built.server).toBe('object');
    expect(built.server).not.toBeNull();
    expect(typeof built._invoke).toBe('function');
    expect(typeof built.dispose).toBe('function');
    expect(built.toolNames).toEqual(['bash']);
  });

  // Helper: pick a real multi-chunk page from live for cat / cache tests.
  async function pickMultiChunkSlug(): Promise<string> {
    const { rows } = await pool.query<{ slug: string }>(
      `SELECT page_slug AS slug FROM doc_chunks
       GROUP BY page_slug HAVING count(*) > 1
       ORDER BY page_slug LIMIT 1`,
    );
    if (!rows[0]) throw new Error('live corpus has no multi-chunk pages — unexpected');
    return rows[0].slug;
  }

  it('executes ls / via the bash tool and returns {stdout, stderr, exitCode}', async () => {
    const built = await buildArmAMcpServer({ pool });
    const r = await built._invoke({ cmd: 'ls /' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    // Live top-level: ax/, api-clients/, link/ (deterministic top-segments).
    expect(r.stdout).toMatch(/api-clients\//);
    expect(r.stdout).toMatch(/ax\//);
    expect(r.structuredContent).toMatchObject({ db_ms: expect.any(Number) });
  });

  it('cat reassembles a multi-chunk page', async () => {
    const built = await buildArmAMcpServer({ pool });
    const slug = await pickMultiChunkSlug();
    const r = await built._invoke({ cmd: `cat /${slug}.mdx` });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.structuredContent.db_ms).toBeGreaterThan(0);
  });

  it('grep returns matching pages on a known-present term', async () => {
    const built = await buildArmAMcpServer({ pool });
    // `Arize` appears across the corpus (the docs are about Arize) — used here
    // as a deterministic positive-match term. The test asserts the grep
    // returned at least one path-shaped line in stdout.
    const r = await built._invoke({ cmd: 'grep -ril Arize /' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^\/[a-z0-9_/-]+\.mdx/m);
  });

  it('writes throw EROFS via stderr (exitCode != 0)', async () => {
    const built = await buildArmAMcpServer({ pool });
    // The EROFS check fires on write_attempt before the path is even resolved.
    const r = await built._invoke({ cmd: 'echo x > /__ro_probe__.mdx' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/EROFS|read-only/i);
  });

  it('structuredContent surfaces cache_hits + cache_misses', async () => {
    const built = await buildArmAMcpServer({ pool });
    const slug = await pickMultiChunkSlug();
    const first = await built._invoke({ cmd: `cat /${slug}.mdx` });
    // First cat of a page is a cold read — at least one miss.
    expect(typeof first.structuredContent.cache_hits).toBe('number');
    expect(typeof first.structuredContent.cache_misses).toBe('number');
    expect(first.structuredContent.cache_misses).toBeGreaterThanOrEqual(1);

    const second = await built._invoke({ cmd: `cat /${slug}.mdx` });
    // Stats reset per handle(); the cache itself persists. The second cat sees
    // the page as cached — at least one hit, no further misses.
    expect(second.structuredContent.cache_hits).toBeGreaterThanOrEqual(1);
    expect(second.structuredContent.cache_misses).toBe(0);
  });

  it('concurrent handle() calls do not interleave per-call telemetry', async () => {
    // The SDK can issue parallel tool-use. handle() mutates shared state
    // (closureCwd, pageCache stats, fs.accDbMs) per call — without serialisation,
    // call N's resetStats() wipes call N-1's mid-flight accumulation. With the
    // mutex, calls serialise: one is cold (misses > 0, hits = 0) and the other
    // is warm (hits > 0, misses = 0).
    const built = await buildArmAMcpServer({ pool });
    const slug = await pickMultiChunkSlug();
    const [a, b] = await Promise.all([
      built._invoke({ cmd: `cat /${slug}.mdx` }),
      built._invoke({ cmd: `cat /${slug}.mdx` }),
    ]);
    const oneIsCold =
      (a.structuredContent.cache_misses > 0 && a.structuredContent.cache_hits === 0 &&
       b.structuredContent.cache_hits > 0   && b.structuredContent.cache_misses === 0) ||
      (b.structuredContent.cache_misses > 0 && b.structuredContent.cache_hits === 0 &&
       a.structuredContent.cache_hits > 0   && a.structuredContent.cache_misses === 0);
    expect(oneIsCold).toBe(true);
  });
});
