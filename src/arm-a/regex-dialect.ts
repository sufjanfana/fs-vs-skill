export interface CoarseFilter {
  /** SQL fragment for the WHERE clause; one positional parameter. */
  sql: string;
  /** The parameter to bind to `$1` in the fragment. */
  param: string;
}

export function toPgIlike(substr: string): string {
  const escaped = substr
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  return `%${escaped}%`;
}

// Escapes backslashes only — POSIX ERE is intentionally passed through (so
// Postgres-specific anchors like \m / \y will reach the regex engine as-is).
export function toPgRegex(posix: string): string {
  return posix.replace(/\\/g, '\\\\');
}

export function ilikeFilter(substr: string): CoarseFilter {
  return { sql: 'content ILIKE $1', param: toPgIlike(substr) };
}

export function regexFilter(posix: string): CoarseFilter {
  // (?n) enables newline-sensitive matching so `^`/`$` anchor per line, matching
  // grep semantics. Default Postgres regex anchors against the whole content.
  return { sql: 'content ~* $1', param: `(?n)${toPgRegex(posix)}` };
}
