// Stitches the Arm-B `./sql` sidecar (.sql_metrics.jsonl) onto Bash ToolCalls:
// each Bash command containing the script path receives aggregated db_ms
// from the matching sidecar line(s); mismatches surface as RunRecord warnings.
// Only db_ms is stitched — disk_ms / tool_handler_ms aren't captured on Arm A.
import type { TurnRecord } from '../shared/jsonl.js';

export interface SidecarLine {
  t_start_ms: number;
  t_end_ms: number;
  db_ms: number;
  row_count: number;
  mode: 'inline' | 'spill';
  result_path: string | null;
  error?: string;
}

const DEFAULT_SCRIPT_PATH = '.claude/skills/sql-skill/sql';
// Matches a bare `./sql 'arg'` invocation. Requires explicit `./` prefix
// (rules out unrelated `sql`/`mysql`/`psql`) and a quote/whitespace lookahead
// (rules out trailing-token cases like `echo .../sql`).
const BARE_REL_RE = /(?:^|[\s;&|()])\.\/sql(?=[\s'"])/g;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBashCommand(input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === 'string') return obj.command;
  return '';
}

// Counts every invocation of the bundle's `sql` script in a single Bash
// command string. Two shapes are valid:
//   1. Full path:   `<workdir-or-abs>/sql-skill/sql 'arg'` (split-substring)
//   2. Relative:    `./sql 'arg'` (preceded by start/whitespace/punctuation,
//      followed by space/quote — see BARE_REL_RE)
// Bare `./sql` is counted unconditionally: the workdir contains exactly one
// `./sql` script (the sql-skill bundle), so cd-then-bare-./sql sequences
// across turns (cwd persists across SDK Bash exec()s) attribute correctly.
// A bare `./sql` issued from a non-sql-skill cwd would fail at exec and write
// no sidecar line — that surfaces as the existing "sidecar exhausted" warning
// rather than silently dropping legitimate cd-then-bare attribution.
export function countSqlInvocations(cmd: string, scriptPath: string = DEFAULT_SCRIPT_PATH): number {
  // Anchored full-path match: preceded by start-of-string, whitespace, shell
  // operator, or `/` (the absolute-path prefix); followed by whitespace,
  // quote, or end-of-string. Mirrors BARE_REL_RE's boundary discipline so
  // both branches share the same edge-case behavior. `/` in the boundary set
  // preserves `cd /tmp && /abs/path/<scriptPath> 'A'` matching.
  const fullPathRe = new RegExp(`(?:^|[\\s;&|()/])${escapeForRegex(scriptPath)}(?=[\\s'"]|$)`, 'g');
  let n = (cmd.match(fullPathRe) ?? []).length;
  n += (cmd.match(BARE_REL_RE) ?? []).length;
  return n;
}

// In-place mutation; returns per-call attribution warnings AND the sidecar-derived
// db_ms_total. The total comes from the sidecar (substrate ground truth — one line
// per ./sql exec regardless of Bash idiom). Per-ToolCall attribution lands on every
// invocation countSqlInvocations recognizes (full-path + bare `./sql`).
export function stitchSidecar(
  turns: TurnRecord[],
  sidecarLines: SidecarLine[],
  scriptPath: string = DEFAULT_SCRIPT_PATH,
): { warnings: string[]; db_ms_total: number } {
  const warnings: string[] = [];
  const db_ms_total = sidecarLines.reduce((acc, l) => acc + l.db_ms, 0);

  let sidecarIdx = 0;
  let scriptCallCount = 0;
  let bashCallCount = 0;

  for (const turn of turns) {
    for (const tc of turn.tool_calls) {
      if (tc.name !== 'Bash') continue;
      bashCallCount += 1;
      const cmd = extractBashCommand(tc.input);
      const occurrences = countSqlInvocations(cmd, scriptPath);
      // Substring count is an over-approximation when calls short-circuit (||)
      // or fail mid-chain; db_ms attribution is best-effort.
      if (occurrences === 0) continue;

      scriptCallCount += occurrences;
      let agg_db = 0;
      let consumed = 0;
      for (let k = 0; k < occurrences; k += 1) {
        if (sidecarIdx >= sidecarLines.length) {
          warnings.push(
            `Bash ToolCall referenced ${scriptPath} ${occurrences} time(s) but sidecar exhausted after ${k}: '${cmd.slice(0, 80)}'`,
          );
          break;
        }
        const line = sidecarLines[sidecarIdx++]!;
        agg_db += line.db_ms;
        consumed += 1;
      }
      if (consumed > 0) {
        tc.db_ms = (tc.db_ms ?? 0) + agg_db;
      }
    }
  }

  if (sidecarIdx < sidecarLines.length) {
    const excess = sidecarLines.length - sidecarIdx;
    warnings.push(
      `Sidecar has ${excess} unmatched line(s) beyond trajectory's ${scriptCallCount} ${scriptPath} invocation(s) (bash calls seen: ${bashCallCount})`,
    );
  }

  return { warnings, db_ms_total };
}
