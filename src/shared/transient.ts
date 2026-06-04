// Single source of truth for the transient-error regex — shared by the batch
// loop and the judge wrapper to prevent drift between sites.

const TRANSIENT_PATTERN =
  /rate.?limit|too many requests|overload|service unavailable|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN|fetch failed|socket hang up|\b(429|502|503|504)\b/i;

export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return TRANSIENT_PATTERN.test(msg);
}
