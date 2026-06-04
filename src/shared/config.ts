// The model pin IS the experiment baseline. Do not parametrize via env or CLI —
// a model change is a separate experiment.
export const MODEL = 'claude-sonnet-4-6';
export const JUDGE_MODEL = 'claude-opus-4-7';
export const MAX_TURNS = 30;
export const MAX_QUESTION_MS = 10 * 60 * 1000;
// Harness abort fires this far before MAX_QUESTION_MS, leaving room for an
// in-flight API call to error and be recorded rather than being hard-aborted.
export const MAX_QUESTION_ABORT_GRACE_MS = 60_000;
export const API_TIMEOUT_MS = 60_000;
export const TRANSIENT_RETRY_SLEEP_MS = 2_000;
export const PAGE_CACHE_MAX = 256;
export const STATEMENT_TIMEOUT_MS = 30_000;

// Per-batch env for every SDK query() (both arms + smoke probes): CLAUDE_CONFIG_DIR
// points at an empty per-batch dir and auto-memory is off so no host config leaks in.
export function baseAgentEnv(emptyConfigDir: string): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] ?? '',
    PATH: process.env['PATH'] ?? '',
    API_TIMEOUT_MS: String(API_TIMEOUT_MS),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CONFIG_DIR: emptyConfigDir,
  };
}

