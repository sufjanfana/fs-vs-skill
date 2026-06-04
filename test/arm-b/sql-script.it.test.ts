/**
 * Integration tests for the Arm B bundled ./sql script.
 *
 * Invokes the script directly via child_process.execFile against the live
 * docs DB through the docs_ro role. Verifies: inline output for small results,
 * NDJSON spill for large results, exit codes, sidecar metrics-line shape,
 * atomic write (no .tmp file left), and read-only-role rejection on INSERT.
 *
 * Requires:
 *   - PG_CONNECTION_STRING set, pointing at docs_ro on the live docs DB
 *     (scripts/grant-docs-ro.sql has been run as a privileged role)
 *   - python3 + psycopg2 installed
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);

const REPO_ROOT = path.resolve(process.cwd());
const SCRIPT = path.join(REPO_ROOT, 'src/arm-b/skill/.claude/skills/sql-skill/sql');

describe('Arm B ./sql script', () => {
  let cwd: string;
  let dsn: string;

  beforeAll(() => {
    const cs = process.env['PG_CONNECTION_STRING'];
    if (!cs) throw new Error('PG_CONNECTION_STRING must be set (docs_ro on live)');
    dsn = cs;
    if (!existsSync(SCRIPT)) {
      throw new Error(`script not found at ${SCRIPT}; ensure Arm B skill bundle is in place`);
    }
  });

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'sql-script-it-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function run(query: string): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const r = await exec(SCRIPT, [query], { cwd, env: { ...process.env, PG_CONNECTION_STRING: dsn } });
      return { stdout: r.stdout, stderr: r.stderr, code: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
    }
  }

  it('inline mode: tiny aggregate result embeds rows in stdout', async () => {
    const r = await run('SELECT 1::int AS n');
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.row_count).toBe(1);
    expect(parsed.rows).toEqual([{ n: 1 }]);
    const files = await readdir(cwd);
    expect(files.filter((f) => /^result_\d+\.ndjson$/.test(f))).toEqual([]);
  });

  it('spill mode: large results write result_N.ndjson and return a navigation summary', async () => {
    // Live doc_chunks has hundreds of rows; even a 3-column projection is
    // well over the inline threshold.
    const r = await run('SELECT id, page_slug, chunk_index FROM doc_chunks');
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.file_path).toBe('./result_1.ndjson');
    expect(parsed.row_count).toBeGreaterThan(0);
    // Navigation summary fields (inline-summary-on-spill contract).
    expect(parsed.columns).toEqual(['id', 'page_slug', 'chunk_index']);
    expect(typeof parsed.byte_size).toBe('number');
    expect(parsed.byte_size).toBeGreaterThan(0);
    expect(parsed.first_row).toBeDefined();
    expect(typeof parsed.first_row.page_slug).toBe('string');
    // Summary stays under its own cap (8KB) regardless of result size.
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(8 * 1024 + 64);
    // `id` is one-per-chunk so it's high-cardinality → dropped from distinct.
    // `page_slug` is high-cardinality too → also dropped from distinct.
    // The summary should still parse cleanly even with `distinct` absent or empty.
    if (parsed.distinct !== undefined) {
      expect(typeof parsed.distinct).toBe('object');
    }
    const text = await readFile(path.join(cwd, 'result_1.ndjson'), 'utf8');
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(parsed.row_count);
    for (const l of lines.slice(0, 5)) {
      const row = JSON.parse(l);
      expect(typeof row.page_slug).toBe('string');
      expect(typeof row.chunk_index).toBe('number');
    }
    const files = await readdir(cwd);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('spill summary: low-cardinality column produces a distinct list', async () => {
    // ax/selfhosting/installation/ has 7 direct children — page_slug
    // cardinality is well under the distinct-cardinality limit, but content
    // per chunk pushes serialized JSON over the inline threshold.
    const r = await run(
      "SELECT page_slug, chunk_index, content FROM doc_chunks WHERE page_slug LIKE 'ax/selfhosting/installation/%' ORDER BY page_slug, chunk_index",
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    if (parsed.file_path) {
      // It spilled — distinct.page_slug should be the navigation index.
      expect(parsed.distinct).toBeDefined();
      expect(parsed.distinct.page_slug).toBeDefined();
      expect(Array.isArray(parsed.distinct.page_slug)).toBe(true);
      expect(parsed.distinct.page_slug.length).toBeGreaterThanOrEqual(7);
      expect(parsed.distinct.page_slug.length).toBeLessThanOrEqual(200);
      // Sorted (None last, then string sort).
      expect(parsed.distinct.page_slug[0].startsWith('ax/selfhosting/installation/')).toBe(true);
    }
  });

  it('spill summary: first_row strings are truncated with an ellipsis marker', async () => {
    const r = await run('SELECT id, page_slug, chunk_index, content FROM doc_chunks');
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.first_row).toBeDefined();
    expect(typeof parsed.first_row.content).toBe('string');
    // Truncation cap is 200 chars + a 1-char ellipsis marker for over-cap strings.
    expect(parsed.first_row.content.length).toBeLessThanOrEqual(201);
  });

  it('sequential numbering: second spill writes result_2.ndjson', async () => {
    const big = 'SELECT id, page_slug, chunk_index FROM doc_chunks';
    await run(big);
    const r2 = await run(big);
    expect(r2.code).toBe(0);
    expect(JSON.parse(r2.stdout.trim()).file_path).toBe('./result_2.ndjson');
  });

  it('sidecar: writes one .sql_metrics.jsonl line per invocation', async () => {
    await run('SELECT 1::int AS n');
    await run('SELECT id, page_slug, chunk_index FROM doc_chunks');
    const sidecar = await readFile(path.join(cwd, '.sql_metrics.jsonl'), 'utf8');
    const lines = sidecar.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    for (const m of [first, second]) {
      expect(typeof m.t_start_ms).toBe('number');
      expect(typeof m.t_end_ms).toBe('number');
      expect(typeof m.db_ms).toBe('number');
      expect(typeof m.row_count).toBe('number');
      // disk_ms / tool_handler_ms intentionally removed — asymmetric vs Arm A.
      expect(m.disk_ms).toBeUndefined();
      expect(m.tool_handler_ms).toBeUndefined();
    }
    expect(first.mode).toBe('inline');
    expect(first.result_path).toBeNull();
    expect(second.mode).toBe('spill');
    expect(second.result_path).toBe('./result_1.ndjson');
  });

  it('SQL syntax error → exit 1, stderr message, sidecar records error', async () => {
    const r = await run('SELECT FROM bogus');
    expect(r.code).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
    const sidecar = await readFile(path.join(cwd, '.sql_metrics.jsonl'), 'utf8');
    const line = JSON.parse(sidecar.trim());
    expect(line.error).toMatch(/syntax|relation .* does not exist|invalid/i);
    expect(line.row_count).toBe(0);
  });

  it('read-only role rejects INSERT', async () => {
    const r = await run("INSERT INTO doc_paths (slug) VALUES ('__it_probe__')");
    expect(r.code).toBe(1);
    expect(r.stderr.toLowerCase()).toMatch(/permission denied|insufficient/);
  });

  it('missing PG_CONNECTION_STRING → exit 2 with usage hint', async () => {
    const env = { ...process.env };
    delete env['PG_CONNECTION_STRING'];
    try {
      await exec(SCRIPT, ['SELECT 1'], { cwd, env });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const err = e as { code?: number; stderr?: string };
      expect(err.code).toBe(2);
      expect(err.stderr ?? '').toMatch(/PG_CONNECTION_STRING/);
    }
  });

  it('missing argv → exit 2 with usage hint', async () => {
    try {
      await exec(SCRIPT, [], { cwd, env: { ...process.env, PG_CONNECTION_STRING: dsn } });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const err = e as { code?: number; stderr?: string };
      expect(err.code).toBe(2);
      expect((err.stderr ?? '').toLowerCase()).toMatch(/usage/);
    }
  });
});
