// Coarse-filter + bulk prefetch for Arm A's grep, executed as ONE Postgres CTE.
import type { Pool } from 'pg';
import type { PageCache } from './page-cache.js';
import type { PathTree } from './path-tree.js';
import { ilikeFilter, regexFilter } from './regex-dialect.js';

export interface PrefetchOpts {
  pool: Pool;
  pageCache: PageCache;
  // Routes candidate slugs to canonical FS paths (section-index slugs →
  // /<slug>/index.mdx; leaves → /<slug>.mdx).
  tree: PathTree;
  pattern: string;
  path: string;       // absolute path (file or directory) limiting the search
  isRegex: boolean;
}

export interface PrefetchResult {
  db_ms: number;
  candidate_paths: string[];   // absolute paths whose chunks matched AND fall under `path`
}

// Strip .mdx because the doc_paths.slug column never carries that suffix; the
// scope clause matches the raw slug shape under both file and dir targets.
export function slugScopeFromPath(absPath: string): string | null {
  if (absPath === '/' || absPath === '') return null;
  return absPath.replace(/^\/+/, '').replace(/\.mdx$/, '').replace(/\/+$/, '');
}

export async function prefetchGrepCandidates(opts: PrefetchOpts): Promise<PrefetchResult> {
  const { pool, pageCache, tree, pattern, path, isRegex } = opts;
  if (pattern === '') return { db_ms: 0, candidate_paths: [] };

  const filter = isRegex ? regexFilter(pattern) : ilikeFilter(pattern);
  const scope = slugScopeFromPath(path);

  // Combined coarse + prefetch CTE. The scope OR matches either the exact slug
  // (file target) or any slug under it as a directory prefix.
  const params: unknown[] = [filter.param];
  let scopeSql = '';
  if (scope !== null) {
    scopeSql = " AND (page_slug = $2 OR page_slug LIKE ($2 || '/%'))";
    params.push(scope);
  }
  const sql = `
    WITH candidates AS (
      SELECT DISTINCT page_slug AS slug FROM doc_chunks
      WHERE ${filter.sql}${scopeSql}
    )
    SELECT c.page_slug AS slug,
           string_agg(c.content, E'\\n' ORDER BY c.chunk_index) AS full
    FROM doc_chunks c
    JOIN candidates k ON c.page_slug = k.slug
    GROUP BY c.page_slug
    ORDER BY c.page_slug
  `;

  const t0 = Date.now();
  const r = await pool.query<{ slug: string; full: string | null }>(sql, params);
  const db_ms = Date.now() - t0;

  // CTE guarantees ≥1 chunk per slug → string_agg is never NULL. If it is, the
  // corpus has been mutated mid-query; surface that loudly rather than poisoning
  // the cache with an empty page.
  pageCache.bulkSet(r.rows.map((row) => {
    if (row.full === null) {
      throw new Error(`prefetchGrepCandidates: NULL string_agg for slug=${row.slug}`);
    }
    return [row.slug, row.full] as const;
  }));
  return { db_ms, candidate_paths: r.rows.map((row) => tree.slugToFsPath(row.slug)) };
}
