import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/shared/db.js';

describe('live docs DB shape', () => {
  afterAll(async () => { await closePool(); });

  it('has the pg_trgm extension installed', async () => {
    const pool = getPool();
    const r = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'");
    expect(r.rowCount).toBe(1);
  });

  it('doc_paths has columns (slug text PK, metadata jsonb)', async () => {
    const pool = getPool();
    const r = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'doc_paths' ORDER BY ordinal_position`,
    );
    const shape = r.rows.map((row) => `${row.column_name}:${row.data_type}`);
    expect(shape).toEqual(['slug:text', 'metadata:jsonb']);
  });

  it('doc_chunks has columns (id, page_slug, chunk_index, content)', async () => {
    const pool = getPool();
    const r = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'doc_chunks' ORDER BY ordinal_position`,
    );
    const cols = r.rows.map((row) => row.column_name);
    expect(cols).toEqual(['id', 'page_slug', 'chunk_index', 'content']);
  });

  it('returns non-zero counts on both tables (corpus is loaded)', async () => {
    const pool = getPool();
    const paths = await pool.query<{ count: string }>('SELECT count(*) AS count FROM doc_paths');
    const chunks = await pool.query<{ count: string }>('SELECT count(*) AS count FROM doc_chunks');
    expect(Number(paths.rows[0]!.count)).toBeGreaterThan(0);
    expect(Number(chunks.rows[0]!.count)).toBeGreaterThan(0);
  });
});

describe('shared/db.ts', () => {
  afterAll(async () => { await closePool(); });

  it('returns a working pool that answers SELECT 1', async () => {
    const pool = getPool();
    const r = await pool.query<{ one: number }>('SELECT 1::int AS one');
    expect(r.rows[0]!.one).toBe(1);
  });

  it('shares the same pool across getPool() calls (singleton)', async () => {
    const p1 = getPool();
    const p2 = getPool();
    expect(p1).toBe(p2);
  });

  it('enforces read-only transactions by default', async () => {
    const pool = getPool();
    await expect(
      pool.query('CREATE TEMP TABLE __ro_probe (x int)'),
    ).rejects.toThrow(/read-only|cannot execute|read only/i);
  });

  it('enforces 30s statement_timeout', async () => {
    const pool = getPool();
    const start = Date.now();
    await expect(pool.query('SELECT pg_sleep(40)')).rejects.toThrow(/statement timeout/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(35_000);
    expect(elapsed).toBeGreaterThan(28_000);
  }, 35_000);
});
