import type { Pool } from 'pg';
import { PathTree } from './path-tree.js';
import { PageCache } from './page-cache.js';

export interface CatResult {
  content: string;
  db_ms: number;
}

export class PostgresFS {
  constructor(
    private readonly tree: PathTree,
    private readonly cache: PageCache,
    private readonly pool: Pool,
  ) {}

  async cat(absPath: string): Promise<CatResult> {
    if (this.tree.isDirectory(absPath)) {
      throw new Error(`EISDIR: ${absPath}`);
    }
    const slug = this.tree.resolveFile(absPath);
    if (!slug) throw new Error(`ENOENT: ${absPath}`);

    const cached = this.cache.get(slug);
    if (cached !== undefined) {
      return { content: cached, db_ms: 0 };
    }

    // Server-side reassembly via `string_agg` — one row over the
    // wire, server-aggregated in chunk_index order.
    const start = Date.now();
    const { rows } = await this.pool.query<{ full: string | null }>(
      `SELECT string_agg(content, E'\n' ORDER BY chunk_index) AS full
       FROM doc_chunks WHERE page_slug = $1`,
      [slug],
    );
    const db_ms = Date.now() - start;
    const content = rows[0]?.full ?? '';
    this.cache.set(slug, content);
    return { content, db_ms };
  }
}
