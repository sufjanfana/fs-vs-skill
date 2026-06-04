import { LRUCache } from 'lru-cache';

// Per-Run LRU; size cap injected by caller.

export interface PageCacheStats {
  hits: number;
  misses: number;
  size: number;
}

export class PageCache {
  private readonly cache: LRUCache<string, string>;
  private hits = 0;
  private misses = 0;

  constructor(max: number) {
    this.cache = new LRUCache<string, string>({ max });
  }

  get(slug: string): string | undefined {
    const v = this.cache.get(slug);
    if (v === undefined) { this.misses++; return undefined; }
    this.hits++;
    return v;
  }

  set(slug: string, content: string): void {
    this.cache.set(slug, content);
  }

  bulkSet(entries: ReadonlyArray<readonly [string, string]>): void {
    for (const [slug, content] of entries) this.cache.set(slug, content);
  }

  size(): number { return this.cache.size; }
  clear(): void { this.cache.clear(); }
  stats(): PageCacheStats { return { hits: this.hits, misses: this.misses, size: this.cache.size }; }
  resetStats(): void { this.hits = 0; this.misses = 0; }
}
