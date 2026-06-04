// EVAL QUESTIONS — live Arize corpus.
// Two-layer grader: parser layer + correctness layer.
// Cite-set existence is verified programmatically by verify-cites.ts.

import { extractCitedSlugs } from './verify-cites.js';

export interface PGraderResult {
  score: number;
  passed: boolean;
  reason: string;
  // Did the parser layer recognize a comparable value? `false` → parse_fail in
  // the 4-category taxonomy emitted by classify-fail.ts; `true` and !passed
  // → content_wrong.
  parsed: boolean;
  // Sub-counts surfaced to the 4-category failure taxonomy via classify-fail.ts.
  // Populated by the architectural-pressure graders; undefined for graders
  // where the concept doesn't apply (exactNumber).
  missing_count?: number;
  extras_count?: number;
  dups_count?: number;
}

export interface LGraderRubric {
  required: string[];
  disqualifying: string[];
}

export type ComplexityTier = 'simple' | 'mid' | 'complex';

export interface QuestionEntry {
  id: string;
  prompt: string;
  shape: 'quant' | 'content' | 'structural';
  // Drives the renderer's stratified rollup.
  complexity_tier: ComplexityTier;
  p_grader: (answer: string) => PGraderResult;
  l_grader_rubric: LGraderRubric;
}

// True when a question is L-graded (carries rubric items); false → P-graded only.
export function isLGradedQuestion(q: Pick<QuestionEntry, 'l_grader_rubric'>): boolean {
  return q.l_grader_rubric.required.length > 0 || q.l_grader_rubric.disqualifying.length > 0;
}

// ─── Parser-tolerant P-grader primitives ─────────────────────────────────────

// Parentheticals stripped; verdict marker (**N**, N times/occurrences,
// total/=/verb-led N) wins over trailing prose. Multiple markers or none →
// rightmost fallback, so "counts: 25, 27, 31" still picks 31.
export function pGrader_exactNumber(expected: number, tolerance = 0): (answer: string) => PGraderResult {
  return (answer: string) => {
    const stripped = answer.replace(/\([^)]*\)/g, '');
    const matches = stripped.match(/-?\d+(?:\.\d+)?/g);
    if (!matches || matches.length === 0) {
      return { score: 0, passed: false, parsed: false, reason: 'no number in answer' };
    }
    let got: number;
    if (matches.length === 1) {
      got = Number(matches[0]);
    } else {
      const markerPatterns: RegExp[] = [
        /\*\*(-?\d+(?:\.\d+)?)\*\*/g,                              // **31**
        /(-?\d+(?:\.\d+)?)\s+times\b/gi,                            // 31 times
        /(-?\d+(?:\.\d+)?)\s+occurrences\b/gi,                      // 31 occurrences
        /\btotal\b[\s:=]*(-?\d+(?:\.\d+)?)\b/gi,                    // Total: 35 / Total = 35
        /=\s*(-?\d+(?:\.\d+)?)\b/g,                                 // = 35
        /\b(?:found|have|has|contains?|got|is|are)\s+(-?\d+(?:\.\d+)?)\b/gi, // verb-led verdict
      ];
      const verdictValues = new Set<string>();
      for (const re of markerPatterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped)) !== null) {
          if (m[1] !== undefined) verdictValues.add(m[1]);
        }
      }
      got = verdictValues.size === 1
        ? Number([...verdictValues][0])
        : Number(matches[matches.length - 1]);
    }
    const diff = Math.abs(got - expected);
    const passed = diff <= tolerance;
    const otherNumbers = matches.filter((s) => Number(s) !== got).join(', ');
    return {
      score: passed ? 1 : 0,
      passed,
      parsed: true,
      reason: passed
        ? `expected ${expected}, got ${got}`
        : `expected ${expected}, got ${got}${otherNumbers ? ` (other numbers seen: ${otherNumbers})` : ''}`,
    };
  };
}

/**
 * pGrader_pairedKeyCount — architectural pressure: ENFORCES key↔count pairing
 * (q6). For each expected key, scopes to the FIRST line containing the key,
 * then takes the LAST digit in the segment between this key and the next
 * expected key on that line (or end-of-line if no next key). Per-line scoping
 * prevents trailing prose (e.g., "Total across all four providers: 15 pages")
 * from polluting the last key's count. Handles single-line multi-key prose
 * ("openai 5, anthropic 3, ..."), multi-row tables, and transparency tables
 * (raw | adjustment | corrected → verdict is rightmost).
 *
 * Intentionally omits extras_count and dups_count: the grader can't detect
 * extras/dups when answers come in declared-key shape (one count per expected
 * key); only missing_count is meaningful.
 */
export function pGrader_pairedKeyCount(
  expected: Record<string, number>,
): (answer: string) => PGraderResult {
  const expectedKeys = Object.keys(expected);
  const escapedKeys = new Map<string, string>(
    expectedKeys.map((k) => [k, k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]),
  );
  return (answer: string) => {
    const got: Record<string, number> = {};
    for (const line of answer.split('\n')) {
      // Locate every expected-key occurrence on this line.
      type Hit = { key: string; start: number; end: number };
      const hits: Hit[] = [];
      for (const [key, escaped] of escapedKeys) {
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        let m: RegExpExecArray | null;
        while ((m = regex.exec(line)) !== null) {
          hits.push({ key, start: m.index, end: m.index + m[0].length });
        }
      }
      if (hits.length === 0) continue;
      hits.sort((a, b) => a.start - b.start);
      // Table rows ('|'-prefixed) put the verdict rightmost (raw|adj|corrected).
      // Prose lines keep the first/last-digit rule for trailing-prose tails.
      const isTableRow = line.trim().startsWith('|');
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]!;
        if (hit.key in got) continue; // first line containing the key wins
        const isLastHitOnLine = i + 1 >= hits.length;
        const segmentEnd = isLastHitOnLine ? line.length : hits[i + 1]!.start;
        const segment = line.slice(hit.end, segmentEnd).replace(/\([^)]*\)/g, '');
        const digits = segment.match(/-?\d+/g);
        if (digits && digits.length > 0) {
          const useLastDigit = isTableRow || !isLastHitOnLine;
          got[hit.key] = Number(useLastDigit ? digits[digits.length - 1] : digits[0]);
        }
      }
    }

    const wrong: string[] = [];
    const missing: string[] = [];
    for (const key of expectedKeys) {
      if (!(key in got)) { missing.push(key); continue; }
      if (got[key] !== expected[key]) wrong.push(`${key}: expected ${expected[key]}, got ${got[key]}`);
    }
    const passed = wrong.length === 0 && missing.length === 0;
    // parsed = at least one expected key matched in the answer; if zero keys
    // matched, the answer didn't present in a recognizable shape (parse_fail).
    const parsed = Object.keys(got).length > 0;
    return {
      score: passed ? 1 : 0,
      passed,
      parsed,
      reason: passed
        ? 'all paired counts correct'
        : [
            missing.length ? `missing: ${missing.join(', ')}` : '',
            wrong.length ? `wrong: ${wrong.join('; ')}` : '',
          ].filter(Boolean).join('; '),
      missing_count: missing.length,
    };
  };
}

/**
 * pGrader_distinctSet — architectural pressure: asymmetric missing/extras +
 * optional dup detection. Drives q8 (no-uniq → dups are the signal) and q9
 * (no-INTERSECT → extras are the signal). Parser tolerates bullets, numbering,
 * commas, semicolons, and a per-question normalize hook for slug stripping.
 */
export function pGrader_distinctSet(
  expected: readonly string[],
  opts: {
    maxMissing: number;
    maxExtras: number;
    rejectDups: boolean;
    normalize?: (s: string) => string;
  },
): (answer: string) => PGraderResult {
  const normalize = opts.normalize ?? ((s: string) => s.toLowerCase().trim());
  const expectedSet = new Set(expected.map(normalize));
  // Cite-set questions (expected entries contain `/`) anchor on `Cited
  // pages:`; identifier-set questions (q8) anchor on `Identifiers:`. Both
  // orientations now instruct the agent to end list/enumerate answers with
  // the appropriate anchor block, one item per line — so the grader extracts
  // tokens from that block and ignores any prose/table breakdown above it.
  const expectedIsSlugShape = expected.some((e) => e.includes('/'));
  return (answer: string) => {
    // Extract from whichever anchor the agent picked; `normalize` folds tokens
    // to the comparable shape regardless.
    const citeMatch = answer.match(/(?:^|\n)\s*Cited pages?:\s*\n/i);
    const hasCiteBlock = citeMatch !== null && citeMatch.index !== undefined;
    const identifiersMatch = answer.match(/(?:^|\n)\s*Identifiers:\s*\n/i);
    const hasIdentifiersBlock = identifiersMatch !== null && identifiersMatch.index !== undefined;

    const anchorIdx = [
      hasCiteBlock ? citeMatch!.index! : Infinity,
      hasIdentifiersBlock ? identifiersMatch!.index! : Infinity,
    ].reduce((min, v) => Math.min(min, v), Infinity);
    const beforeAnchor = anchorIdx < Infinity ? answer.slice(0, anchorIdx) : answer;

    // Slug-shape: cite block IS the answer set. Identifier-shape: cite block
    // is a SOURCE citation, not the answer — ignore and fall through.
    const citeTokens = (hasCiteBlock && expectedIsSlugShape)
      ? extractCitedSlugs(answer)
      : [];
    const identifierTokens = hasIdentifiersBlock
      ? extractAnchorBlockLines(answer, identifiersMatch!.index! + identifiersMatch![0].length)
      : [];

    const anchorTokens = [...citeTokens, ...identifierTokens];
    const tokens = anchorTokens.length > 0
      ? anchorTokens.map(normalize).filter(Boolean)
      : tokenizeList(beforeAnchor).map(normalize).filter(Boolean);
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const t of tokens) {
      if (seen.has(t)) dups.push(t);
      seen.add(t);
    }
    const missing = [...expectedSet].filter((e) => !seen.has(e));
    const extras = [...seen].filter((s) => !expectedSet.has(s));

    const failures: string[] = [];
    if (missing.length > opts.maxMissing) failures.push(`${missing.length} missing > ${opts.maxMissing} allowed`);
    if (extras.length > opts.maxExtras) failures.push(`${extras.length} extras > ${opts.maxExtras} allowed`);
    if (opts.rejectDups && dups.length > 0) failures.push(`${dups.length} duplicate(s)`);
    const passed = failures.length === 0;
    return {
      score: passed ? 1 : 0,
      passed,
      // Zero tokens recognized → couldn't parse the answer (parse_fail).
      parsed: tokens.length > 0,
      reason: passed
        ? `pass (missing=${missing.length}, extras=${extras.length}, dups=${dups.length})`
        : failures.join('; '),
      missing_count: missing.length,
      extras_count: extras.length,
      dups_count: dups.length,
    };
  };
}

// Extract the lines that follow an anchor header (e.g., the body after
// `Identifiers:\n`). Reads until end-of-string OR until a blank line that's
// followed by another anchor / prose section. Splits each line on `,;` so
// comma-list shapes under the anchor parse the same as one-per-line.
function extractAnchorBlockLines(answer: string, startIdx: number): string[] {
  const tail = answer.slice(startIdx);
  const out: string[] = [];
  for (const rawLine of tail.split('\n')) {
    const trimmed = rawLine.trim();
    if (/^[`~]{3,}/.test(trimmed)) continue;            // code fences
    if (trimmed === '') { if (out.length === 0) continue; break; }
    for (const piece of trimmed.split(/[,;]/)) {
      let t = piece.trim();
      t = t.replace(/^[-*•]\s+/, '');
      t = t.replace(/^\d+[.)]\s+/, '');
      t = t.replace(/^`+|`+$/g, '');
      // Strip surrounding non-slug chars (jq quotes, markdown parens, …).
      t = t.replace(/^[^\w/-]+|[^\w/-]+$/g, '');
      if (t.length === 0) continue;
      out.push(t);
    }
  }
  return out;
}

// Tokenize free-form lists: split on newline/comma/semicolon; drop markdown
// code-fence lines and table-separator rows; split markdown table rows on
// pipes; strip leading bullets/numbering and surrounding backticks; trim.
// Empty tokens dropped. Parser-tolerant of the markdown shapes the model
// produces under both arms' orientations.
function tokenizeList(s: string): string[] {
  return s
    .replace(/\r\n/g, '\n')
    .split(/[\n,;]/)
    .flatMap((line) => {
      const trimmed = line.trim();
      // Drop markdown code fences (``` or ~~~ of length ≥3).
      if (/^[`~]{3,}/.test(trimmed)) return [];
      // Drop markdown table separator rows (|---|---|, | :-- | --: | etc.).
      if (/^[|\s:-]+$/.test(trimmed) && trimmed.includes('-')) return [];
      // Split markdown table rows on `|`; otherwise keep the line as one.
      return trimmed.includes('|') ? trimmed.split('|') : [trimmed];
    })
    .map((cell) => {
      // Trim first so surrounding whitespace doesn't hide the prefix/backtick
      // anchors (e.g., " `os` " → `os` → os, not " `os` " → " `os` ").
      let t = cell.trim();
      t = t.replace(/^[-*•]\s+/, '');
      t = t.replace(/^\d+[.)]\s+/, '');
      t = t.replace(/^`+|`+$/g, '');
      return t.trim();
    })
    .filter(Boolean);
}

// q9 slug normalizer: lowercase, strip leading `/`, strip trailing `.md`/`.mdx`.
const normalizeSlug = (s: string): string =>
  s.toLowerCase().trim().replace(/^\//, '').replace(/\.mdx?$/, '');

// q3 suffix normalizer: lowercase, strip `.md`/`.mdx`, strip surrounding
// non-slug chars, then take the tail after the last `/`. Returns '' for
// non-slug-shape tails so they drop via .filter(Boolean) rather than counting
// as extras. Parent-path guard drops `installation` when the input is the
// question's parent directory in prose.
export const normalizeInstallSuffix = (s: string): string => {
  let trimmed = s.toLowerCase().trim().replace(/\.mdx?$/, '');
  trimmed = trimmed.replace(/^[^a-z0-9_-]+|[^a-z0-9_-]+$/g, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const tail = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  if (trimmed === 'ax/selfhosting/installation') return '';
  if (tail === 'installation' && trimmed.includes('selfhosting/installation')) return '';
  return /^[a-z0-9_-]+$/.test(tail) ? tail : '';
};

// ─── q8 expected: 54 distinct Python top-level identifiers ───────────────────
const Q8_EXPECTED: readonly string[] = [
  'agent', 'agentc', 'agents', 'anthropic', 'arize', 'ast', 'asyncio', 'azure',
  'couchbase', 'databricks', 'databricks_langchain', 'datasets', 'datetime',
  'dotenv', 'duckdb', 'gcsfs', 'getpass', 'google', 'ipywidgets', 'json',
  'langchain', 'langchain_community', 'langchain_core', 'langchain_couchbase',
  'langchain_google_vertexai', 'langchain_huggingface', 'langchain_openai',
  'langchain_text_splitters', 'langgraph', 'llama_index', 'logging', 'mlflow',
  'nest_asyncio', 'openai', 'openinference', 'opentelemetry', 'optimizer_sdk',
  'os', 'pandas', 'phoenix', 'pkg_resources', 'playwright', 'pprint',
  'pydantic_evals', 'ragas', 're', 'rouge', 'sys', 'tqdm', 'typing',
  'unitycatalog', 'urllib', 'uuid', 'vertexai',
];

// ─── q3 expected: 7 direct children of ax/selfhosting/installation/ ─────────
// The prompt asks for slug suffixes; the grader's normalize strips path
// prefixes so agents that echo full slugs are graded the same as agents that
// emit suffixes.
const Q3_EXPECTED: readonly string[] = [
  'configuring-ingress-endpoints',
  'configuring-saml',
  'installation-on-aws',
  'installation-on-azure',
  'installation-on-gcp',
  'installation-on-openshift',
  'installation-on-single-host',
];

// ─── q9 expected: 17 slugs where OpenInference AND evaluator co-occur ────────
const Q9_EXPECTED: readonly string[] = [
  'api-clients/python/version-8/overview',
  'api-clients/python/version-8/tutorial/get-started-evaluations-with-arize-sdk',
  'ax/cookbooks/agents/evaluating-agentic-rag-using-arize-and-couchbase',
  'ax/cookbooks/agents/foundry-red-team',
  'ax/cookbooks/agents/openai-agents-cookbook',
  'ax/cookbooks/agents/ragas-agents-cookbook',
  'ax/cookbooks/agents/tracing-and-evaluating-agents',
  'ax/cookbooks/evaluation/evaluating-rag',
  'ax/cookbooks/evaluation/evaluations-quickstart',
  'ax/develop/datasets-and-experiments/run-experiment/advanced-options-for-running-experiments-via-code',
  'ax/graphql-reference/apis/online-tasks-api',
  'ax/improve/build-a-dataset',
  'ax/improve/experiment-in-code',
  'ax/improve/experiment-in-playground',
  'ax/instrument/what-are-traces',
  'ax/release-notes',
  'ax/release-notes/history/2026/01-31-2026',
];

// ─── Frozen 10 questions ─────────────────────────────────────────────────────
// Array order drives per-question detail rendering: simple → mid → complex.
// The renderer's tier rollup groups by complexity_tier independently.

export const QUESTIONS: ReadonlyArray<QuestionEntry> = [
  // ─── Simple tier (3) ──────────────────────────────────────────────────────

  // q1 — single migration page lookup
  {
    id: 'q1',
    complexity_tier: 'simple',
    prompt:
      'The Arize Python SDK v8 renamed the `model_id` parameter. What did `model_id` do, what was it renamed to in v8, and which page documents the rename? Cite the page.',
    shape: 'content',
    p_grader: () => ({ score: 0, passed: false, parsed: false, reason: 'L-graded only' }),
    l_grader_rubric: {
      required: [
        'Definition: states that `model_id` identifies a model — a string identifier the SDK user supplied to name the model (or project) that data was being logged to or exported from.',
        'Names the rename — either `model_id` → `model_name` (ML / pandas client) OR `model_id` → `project_name` (tracing / exporter client). Mentioning both is canonical but not required.',
        'Cites at least one of `api-clients/python/version-8/migration/exporter-client` OR `api-clients/python/version-8/migration/pandas-client`.',
      ],
      disqualifying: [
        'Claims `model_id` still exists by that name in v8 (it was renamed).',
      ],
    },
  },
  // q2 — single-page slug lookup (Okta SSO)
  {
    id: 'q2',
    complexity_tier: 'simple',
    prompt:
      'What is the slug of the Arize docs page that documents how to set up SSO with Okta? Return just the slug, unprefixed (no leading `/`, no `.md`/`.mdx` suffix).',
    shape: 'content',
    p_grader: (answer: string) => {
      const passed = answer.toLowerCase().includes('setting-up-sso-with-okta');
      return {
        score: passed ? 1 : 0,
        passed,
        parsed: answer.trim().length > 0,
        reason: passed
          ? 'answer contains setting-up-sso-with-okta slug'
          : 'expected slug suffix `setting-up-sso-with-okta` not found in answer',
      };
    },
    l_grader_rubric: { required: [], disqualifying: [] }, // P-graded only
  },
  // q3 — single-directory enumeration
  {
    id: 'q3',
    complexity_tier: 'simple',
    prompt:
      'List every page directly under `ax/selfhosting/installation/`. Return just the slug suffixes (e.g., `installation-on-aws`), one per line.',
    shape: 'structural',
    p_grader: pGrader_distinctSet(Q3_EXPECTED, {
      maxMissing: 0, maxExtras: 0, rejectDups: true,
      normalize: normalizeInstallSuffix,
    }),
    l_grader_rubric: { required: [], disqualifying: [] }, // P-graded only
  },

  // ─── Mid tier (4) ─────────────────────────────────────────────────────────

  // q4 — baseline single-term frequency count
  {
    id: 'q4',
    complexity_tier: 'mid',
    prompt: 'How many times does `log_evaluations` get mentioned across the Arize docs?',
    shape: 'quant',
    p_grader: pGrader_exactNumber(31, 0),
    l_grader_rubric: { required: [], disqualifying: [] }, // P-graded only; rubric unused
  },
  // q5 — subtree page count (no-`wc` counting pressure)
  {
    id: 'q5',
    complexity_tier: 'mid',
    prompt:
      'How many recipe pages live anywhere under the `ax/cookbooks/` directory tree, including pages nested inside subdirectories like `ax/cookbooks/agents/`? Exclude only the `ax/cookbooks` section index itself.',
    shape: 'quant',
    p_grader: pGrader_exactNumber(35, 0),
    l_grader_rubric: { required: [], disqualifying: [] },
  },
  // q6 — group-by aggregation across slug-prefix buckets (no-`wc` + group-by pressure)
  {
    id: 'q6',
    complexity_tier: 'mid',
    prompt:
      'How many pages live in each of these LLM provider integration subtrees: `openai`, `anthropic`, `mistralai`, `google-gen-ai`? Each is a subdirectory of `ax/integrations/llm-providers/`. Count every page within each provider\'s subtree, including the subtree\'s section landing page itself.',
    shape: 'quant',
    p_grader: pGrader_pairedKeyCount({
      openai: 5, anthropic: 3, mistralai: 3, 'google-gen-ai': 4,
    }),
    l_grader_rubric: { required: [], disqualifying: [] },
  },
  // q7 — two-section comparison (cross-section locality pressure)
  {
    id: 'q7',
    complexity_tier: 'mid',
    prompt:
      "What's the difference between online evals and offline evals in Arize? When would I use one over the other?",
    shape: 'content',
    p_grader: () => ({ score: 0, passed: false, parsed: false, reason: 'L-graded only' }),
    l_grader_rubric: {
      required: [
        'At least one concrete setup difference grounded in the docs (target = trace project vs. dataset experiment, SDK call vs. UI config, deployment mode).',
        'At least one concrete execution difference (online = continuous + sampling; offline = one-shot + deterministic per-experiment).',
        'At least one concrete reporting/use-case difference (online = production monitoring; offline = CI/CD regression checks before ship).',
        'Cites ≥1 page path per side: one for online evals (e.g. `ax/evaluate/run-evals-on-traces`) and one for offline evals (e.g. `ax/evaluate/run-evals-on-experiments`).',
      ],
      disqualifying: [
        'Conflates the two: claims a feature belongs to both when it belongs to one (e.g., "offline evals run continuously" is false).',
        'Invents a feature not in the corpus (e.g., "online evals run in the browser").',
      ],
    },
  },

  // ─── Complex tier (3) ─────────────────────────────────────────────────────

  // q8 — distinct top-level Python identifiers (no-`uniq` dedupe pressure)
  {
    id: 'q8',
    complexity_tier: 'complex',
    prompt:
      'List the distinct top-level identifiers imported via `import X` or `from X` statements in Arize\'s cookbook pages. "Top-level identifier" means: take the FIRST identifier appearing after each `import` or `from` keyword, then take whatever comes before its first `.`. Match lowercase-starting identifiers only (skip prose words like "Note:"). Include stdlib (`os`, `sys`, etc.), third-party PyPI packages, and locally-defined notebook modules — anything that appears as the first import token counts.',
    shape: 'structural',
    p_grader: pGrader_distinctSet(Q8_EXPECTED, {
      maxMissing: 1, maxExtras: 1, rejectDups: true,
    }),
    l_grader_rubric: { required: [], disqualifying: [] },
  },
  // q9 — multi-criteria page co-occurrence (no-INTERSECT + locality pressure)
  {
    id: 'q9',
    complexity_tier: 'complex',
    prompt:
      'Which Arize docs mention both "OpenInference" AND the word "evaluator" (or its plural "evaluators")? Match case-insensitively as substrings — any page whose content contains both substrings anywhere counts. List every matching page.',
    shape: 'structural',
    p_grader: pGrader_distinctSet(Q9_EXPECTED, {
      maxMissing: 1, maxExtras: 0, rejectDups: false,
      normalize: normalizeSlug,
    }),
    l_grader_rubric: { required: [], disqualifying: [] },
  },
  // q10 — session-tracking synthesis (DB round-trip per page + locality pressure)
  {
    id: 'q10',
    complexity_tier: 'complex',
    prompt:
      'How does session tracking work in Arize end-to-end? What does the SDK emit, how does it surface in the UI, and how is it queried? Cite every page you used.',
    shape: 'content',
    p_grader: () => ({ score: 0, passed: false, parsed: false, reason: 'L-graded only' }),
    l_grader_rubric: {
      required: [
        'Names the exact span-attribute key the SDK emits: literally `session.id` (dotted, lowercase). `session_id` (underscore) is the function-parameter name — citing only that as the emitted attribute is a fail.',
        'Names the Python entry point (`using_session` or `using_attributes`) OR the JS entry point (`setSession`) used to set the attribute.',
        'Describes where session views surface in the UI — the Sessions tab on the tracing project.',
        'Describes how sessions are grouped or queried — traces grouped by `session.id` value, sortable/filterable by duration / trace count / token counts.',
        'Cites ≥3 distinct page paths from `ax/instrument/set-up-sessions`, `ax/observe/tracing/view-and-manage-traces`, `ax/observe/tracing-concepts/openinference-semantic-conventions`, or related — all in `doc_paths`.',
      ],
      disqualifying: [
        'Names a fake SDK method (`set_session_id`, `track_session`, `arize.set_session`, `start_session`, `Sessions.start`, `SessionTracker`) — none of these exist in `doc_chunks.content`.',
        'Asserts UI behavior or data-model invariant not in the docs.',
      ],
    },
  },
] as const;

// Single-page slug lookup, deliberately outside every L-question reference
// cite set. Trajectory-driven iteration target (grader is lenient — pass on
// any answer containing 'openai' AND 'trac'). The target slug must be
// verified against the live corpus before the first cell runs.
export const PROBE_QUESTION: QuestionEntry = {
  id: 'PROBE',
  // Tagged simple because the probe is a single-page slug lookup outside the
  // 10 eval questions' cite sets.
  complexity_tier: 'simple',
  prompt:
    "Find the Arize docs page that documents the OpenAI Python integration's tracing setup (the page where you'd start to instrument OpenAI calls with Arize). Return just the slug, unprefixed.",
  shape: 'content',
  p_grader: (answer: string) => {
    const lower = answer.toLowerCase();
    const passed = /openai/.test(lower) && /trac/.test(lower);
    return {
      score: passed ? 1 : 0,
      passed,
      parsed: answer.trim().length > 0,
      reason: passed
        ? 'answer mentions an openai-and-tracing slug'
        : 'expected a slug under ax/integrations/python-agent-frameworks/openai/ mentioning tracing',
    };
  },
  l_grader_rubric: {
    required: [
      'Names a specific docs slug rooted under `ax/integrations/python-agent-frameworks/openai/`.',
      'The slug exists in `doc_paths`.',
    ],
    disqualifying: [
      'Returns a slug for a different integration (langchain, anthropic, mistralai, etc.) instead of OpenAI.',
    ],
  },
};
