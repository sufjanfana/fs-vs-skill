// Programmatic cite verifier. The L-judge runs over question + final_answer
// with no DB access, so it cannot reliably verify slug existence against the
// live corpus. We do that here, before the judge call, and short-circuit to
// `corpus_integrity_fail` when the answer references pages that aren't in the
// corpus.

import type { Pool } from 'pg';

const SLUG_SHAPE = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)+$/i;

/**
 * Extract slugs from the `Cited pages:` block. Returns [] when no block is
 * present — the cite-gate only short-circuits the judge on misses against an
 * EXPLICIT block; prose mentions are the L-judge's responsibility.
 *
 * Returned slugs are normalized: lowercased, leading `/` stripped, trailing
 * `.md` / `.mdx` stripped, surrounding non-slug chars trimmed.
 */
export function extractCitedSlugs(answer: string): string[] {
  const out = new Set<string>();

  // Anchor at `Cited pages:` header; body runs to blank line or EOF.
  const blockMatch = answer.match(/(?:^|\n)\s*Cited pages?:\s*\n([\s\S]+?)(?:\n\s*\n|$)/i);
  if (blockMatch && blockMatch[1]) {
    for (const raw of blockMatch[1].split('\n')) {
      const cleaned = raw
        .trim()
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/^[^\w/-]+|[^\w/-]+$/g, '')   // jq quotes, markdown parens
        .replace(/^\//, '')
        .replace(/\.mdx?$/i, '')
        .replace(/\/index$/, '')
        .toLowerCase()
        .trim();
      if (cleaned && SLUG_SHAPE.test(cleaned)) out.add(cleaned);
    }
  }

  return [...out];
}

/**
 * Look up the extracted cite-set against `doc_paths`. Returns the misses
 * (cited slugs not present) and the total number of cited slugs. A miss
 * triggers `corpus_integrity_fail` and short-circuits the judge call.
 */
export async function verifyCites(
  answer: string,
  pool: Pool,
): Promise<{ misses: string[]; total: number }> {
  const cited = extractCitedSlugs(answer);
  if (cited.length === 0) return { misses: [], total: 0 };
  const { rows } = await pool.query<{ slug: string }>(
    'SELECT slug FROM doc_paths WHERE slug = ANY($1)',
    [cited],
  );
  const present = new Set(rows.map((r) => r.slug));
  const misses = cited.filter((s) => !present.has(s));
  return { misses, total: cited.length };
}
