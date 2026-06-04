// Unit tests for the parser-tolerant P-grader primitives.
//
// The architectural-pressure rules (q8 dup-detect, q9 asymmetric extras=0,
// q6 paired-counts) MUST survive the parser-tolerant layer. Tests assert each
// primitive against representative answer shapes (canonical, formatted, noisy).
import { describe, it, expect } from 'vitest';
import {
  pGrader_exactNumber,
  pGrader_pairedKeyCount,
  pGrader_distinctSet,
  normalizeInstallSuffix,
} from '../../src/eval/questions.js';

describe('pGrader_exactNumber (parser-tolerant)', () => {
  const grader = pGrader_exactNumber(35, 0);

  it('passes on bare integer', () => {
    const r = grader('35');
    expect(r.passed).toBe(true);
  });

  it('passes when integer is the last number in a sentence', () => {
    const r = grader('After scanning, the answer is 35.');
    expect(r.passed).toBe(true);
  });

  it('fails on wrong number', () => {
    const r = grader('34');
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/34/);
  });

  it('fails when no integer present', () => {
    const r = grader('no number here');
    expect(r.passed).toBe(false);
  });

  it('tolerates pre-text integers when last integer is the expected one', () => {
    const r = grader('Step 1: gather. Step 2: count. Result: 35');
    expect(r.passed).toBe(true);
  });

  // ─── Match-anywhere with priority ───────────────────────────────
  // Real q4 Arm B / q5 Arm B failures: the agent stated the correct number
  // earlier in the answer, then ended with a secondary statistic (trailing
  // prose). The grader must extract the verdict, not the trailing number.

  it('passes on prose-tail answers (q4 Arm B idiom: "31 times across 17 chunks")', () => {
    const r = grader('I found 35 entries appearing in 12 distinct files.');
    expect(r.passed).toBe(true);
  });

  it('passes on multi-part prose answers (q5 Arm B idiom: "Total=35 ... remaining 5 subdirs")', () => {
    const r = grader('Total = 35. Breakdown: 20 in agents/, 10 in evaluation/, remaining 5 subdirectories each contain a single page.');
    expect(r.passed).toBe(true);
  });

  it('still fails when expected is genuinely absent', () => {
    const r = grader('I found 17 entries appearing in 12 distinct files.');
    expect(r.passed).toBe(false);
  });

  // ─── Verdict-marker priority (handoff §2a) ─────────────────────────────────
  // q4 Arm B failure: "31 times across 17 chunks" — rightmost picked 17.
  // The N-times verdict marker must beat the trailing qualifier.

  it('picks the verdict number when followed by a qualifier number', () => {
    const g = pGrader_exactNumber(31);
    expect(g('log_evaluations is mentioned 31 times across the docs, appearing in 17 different chunks').passed).toBe(true);
  });

  it('still picks rightmost when no marker exists', () => {
    const g = pGrader_exactNumber(31);
    expect(g('counts: 25, 27, 31').passed).toBe(true); // pure number list, rightmost wins
  });
});

describe('normalizeInstallSuffix (q3 parent-path guard, handoff §2b)', () => {
  it('drops parent-path tail "installation"', () => {
    expect(normalizeInstallSuffix('ax/selfhosting/installation/')).toBe('');
    expect(normalizeInstallSuffix('`ax/selfhosting/installation/`')).toBe('');
  });

  it('keeps real suffixes', () => {
    expect(normalizeInstallSuffix('installation-on-aws')).toBe('installation-on-aws');
    expect(normalizeInstallSuffix('ax/selfhosting/installation/installation-on-aws')).toBe('installation-on-aws');
  });
});

describe('pGrader_pairedKeyCount (q6)', () => {
  const expected = { openai: 5, anthropic: 3, mistralai: 3, 'google-gen-ai': 4 };
  const grader = pGrader_pairedKeyCount(expected);

  it('passes on correct line-separated pairs', () => {
    const r = grader('openai 5\nanthropic 3\nmistralai 3\ngoogle-gen-ai 4');
    expect(r.passed).toBe(true);
  });

  it('passes regardless of bucket order', () => {
    const r = grader('anthropic 3\ngoogle-gen-ai 4\nmistralai 3\nopenai 5');
    expect(r.passed).toBe(true);
  });

  it('passes with comma-separated pairs', () => {
    const r = grader('openai 5, anthropic 3, mistralai 3, google-gen-ai 4');
    expect(r.passed).toBe(true);
  });

  it('passes with colon-separated pairs', () => {
    const r = grader('openai: 5\nanthropic: 3\nmistralai: 3\ngoogle-gen-ai: 4');
    expect(r.passed).toBe(true);
  });

  it('REJECTS swapped pairs (architectural pressure: pairing must be enforced)', () => {
    // openai answered as 3 (wrong), anthropic answered as 5 (wrong).
    // pGrader_setEquality would have accepted {"openai","5","3","anthropic"} as a set.
    const r = grader('openai 3\nanthropic 5\nmistralai 3\ngoogle-gen-ai 4');
    expect(r.passed).toBe(false);
  });

  it('reports missing buckets in missing_count', () => {
    const r = grader('openai 5\nanthropic 3\nmistralai 3');
    expect(r.passed).toBe(false);
    expect(r.missing_count).toBeGreaterThanOrEqual(1);
  });

  // ─── Last-digit-in-segment between keys ─────────────────────────
  // Real q6 Arm A failure: transparency table where each row has multiple
  // digits (raw count | adjustment | corrected); the verdict is rightmost on
  // the row. The grader must extract the verdict, not the intermediate.

  it('extracts the rightmost digit per row in a transparency table (q6 Arm A idiom)', () => {
    const table = [
      '| Provider | Raw count | Adjustment | Corrected |',
      '|----------|-----------|------------|-----------|',
      '| openai | 6 | -1 | 5 |',
      '| anthropic | 4 | -1 | 3 |',
      '| mistralai | 4 | -1 | 3 |',
      '| google-gen-ai | 5 | -1 | 4 |',
    ].join('\n');
    expect(grader(table).passed).toBe(true);
  });

  it('still scopes digits to the segment between consecutive keys (multi-key single line)', () => {
    // Already covered by 'passes with comma-separated pairs' but assert
    // explicitly that the per-key segment isolation holds.
    const r = grader('openai 5, anthropic 3, mistralai 3, google-gen-ai 4');
    expect(r.passed).toBe(true);
  });

  it('LAST key on its own line does NOT pull in trailing prose like "Total: 15" (q6 Arm B real fixture)', () => {
    // Real fixture from pre-flight: agent emits a markdown table with one row
    // per provider, followed by a prose summary "Total across all four
    // providers: 15 pages.". The previous "segment between consecutive keys"
    // logic extended the last key's segment to end-of-answer, swallowing
    // "15" as mistralai's count.
    const answer = [
      'Here are the page counts for each LLM provider:',
      '',
      '| Provider | Pages |',
      '|---|---|',
      '| `openai` | **5** |',
      '| `google-gen-ai` | **4** |',
      '| `anthropic` | **3** |',
      '| `mistralai` | **3** |',
      '',
      '**Total across all four providers: 15 pages.** OpenAI has the largest subtree.',
    ].join('\n');
    expect(grader(answer).passed).toBe(true);
  });
});

describe('pGrader_distinctSet — q8 shape (max 1 missing, max 1 extra, reject dups)', () => {
  const grader = pGrader_distinctSet(['os', 'sys', 'json'], {
    maxMissing: 1, maxExtras: 1, rejectDups: true,
  });

  it('passes on exact match', () => {
    const r = grader('os\nsys\njson');
    expect(r.passed).toBe(true);
    expect(r.missing_count).toBe(0);
    expect(r.extras_count).toBe(0);
    expect(r.dups_count).toBe(0);
  });

  it('passes within ≤1 missing tolerance', () => {
    const r = grader('os\njson');
    expect(r.passed).toBe(true);
  });

  it('passes with ≤1 extra tolerance', () => {
    const r = grader('os\nsys\njson\nfake');
    expect(r.passed).toBe(true);
  });

  it('fails on >1 missing', () => {
    const r = grader('os');
    expect(r.passed).toBe(false);
    expect(r.missing_count).toBe(2);
  });

  it('fails on >1 extras', () => {
    const r = grader('os\nsys\njson\nfake1\nfake2');
    expect(r.passed).toBe(false);
    expect(r.extras_count).toBe(2);
  });

  it('REJECTS duplicates (architectural pressure: dups ARE the no-uniq signal)', () => {
    const r = grader('os\nsys\njson\nsys');
    expect(r.passed).toBe(false);
    expect(r.dups_count).toBeGreaterThanOrEqual(1);
  });

  it('tolerates bullets and numbered prefixes', () => {
    expect(grader('- os\n- sys\n- json').passed).toBe(true);
    expect(grader('1. os\n2. sys\n3. json').passed).toBe(true);
  });

  it('tolerates comma-separated lists', () => {
    expect(grader('os, sys, json').passed).toBe(true);
  });

  // ─── Parser-tolerant for idiomatic Sonnet output ──────────────
  // The 'parser-tolerant' docstring promise must hold against the answer shapes
  // the model actually produces under both arms' orientations.

  it('tolerates markdown code-fenced lists (q3 idiom)', () => {
    const fenced = '```\nos\nsys\njson\n```';
    expect(grader(fenced).passed).toBe(true);
  });

  it('tolerates bullet lists with backticked identifiers (q8 idiom)', () => {
    const bullets = '- `os`\n- `sys`\n- `json`';
    expect(grader(bullets).passed).toBe(true);
  });

  it('extracts identifiers from markdown table rows (q8 idiom — missing_count must be 0)', () => {
    // Markdown tables produce extras from header / row indices / description
    // cells — those are legit signal under q8's architectural pressure. What
    // tokenizeList must guarantee is that the IDENTIFIERS in the table get
    // extracted, so missing_count reflects whether the agent listed them.
    const table = [
      '| # | Identifier | Description |',
      '|---|------------|-------------|',
      '| 1 | `os` | stdlib |',
      '| 2 | `sys` | stdlib |',
      '| 3 | `json` | stdlib |',
    ].join('\n');
    const r = grader(table);
    expect(r.missing_count).toBe(0);
  });
});

describe('pGrader_distinctSet — q9 shape (≤1 missing, NO extras, dups OK)', () => {
  const grader = pGrader_distinctSet(['a/b', 'c/d', 'e/f'], {
    maxMissing: 1, maxExtras: 0, rejectDups: false,
  });

  it('passes within ≤1 missing', () => {
    expect(grader('a/b\nc/d').passed).toBe(true);
  });

  it('REJECTS any extra (architectural pressure: extras ARE the no-INTERSECT signal)', () => {
    const r = grader('a/b\nc/d\ne/f\nfake/slug');
    expect(r.passed).toBe(false);
    expect(r.extras_count).toBeGreaterThanOrEqual(1);
  });

  it('dups do not flag fail when rejectDups: false', () => {
    expect(grader('a/b\na/b\nc/d\ne/f').passed).toBe(true);
  });
});

describe('pGrader_distinctSet — cite-block anchor (q9 idiom)', () => {
  // Real q9 failure: both arms emit a canonical `Cited pages:` block with the
  // expected slugs, but tokenizeList runs over the whole answer (preceding
  // markdown table + prose), inflating extras_count past maxExtras=0. The fix
  // is to anchor on the cite block when present.
  const grader = pGrader_distinctSet(['a/b', 'c/d', 'e/f'], {
    maxMissing: 0, maxExtras: 0, rejectDups: false,
    normalize: (s: string) => s.toLowerCase().trim().replace(/^\//, '').replace(/\.mdx?$/, ''),
  });

  it('anchors on `Cited pages:` block when present (ignores preceding markdown + prose)', () => {
    const answer = [
      'Here is a summary of pages with both terms:',
      '',
      '| # | Title | Slug |',
      '|---|-------|------|',
      '| 1 | Page A | a/b |',
      '| 2 | Page C | c/d |',
      '| 3 | Page E | e/f |',
      '',
      'These 3 pages span the corpus.',
      '',
      'Cited pages:',
      'a/b',
      'c/d',
      'e/f',
    ].join('\n');
    const r = grader(answer);
    expect(r.passed).toBe(true);
    expect(r.missing_count).toBe(0);
    expect(r.extras_count).toBe(0);
  });

  it('falls through to tokenizeList when no `Cited pages:` block is present', () => {
    // Plain list shape — current behavior, must still work.
    expect(grader('a/b\nc/d\ne/f').passed).toBe(true);
  });

  it('does NOT anchor on slug-shaped substrings in prose (only on explicit `Cited pages:` header)', () => {
    // extractCitedSlugs has a SLUG_IN_PROSE fallback that fires when no
    // `Cited pages:` block is present — useful for cite verification but
    // wrong for grader anchoring. q3 regression: agent says "pages under
    // `ax/selfhosting/installation/`" in prose; fallback would treat that
    // as the cited set and report all 7 expected as missing.
    const sgrader = pGrader_distinctSet(['a', 'b', 'c'], {
      maxMissing: 0, maxExtras: 1, rejectDups: false,
      normalize: (s: string) => s.toLowerCase().trim(),
    });
    const answer = 'I scanned `foo/bar/baz/`:\n\na\nb\nc';
    expect(sgrader(answer).passed).toBe(true);
  });

  it('does NOT trigger cite-block anchor when expected is identifier-shape (no slashes) — q8 regression', () => {
    // Real q8 Arm B fixture: agent emits a `Cited pages:` block referencing
    // the source page (`ax/cookbooks`), not the identifiers under test. The
    // cite-block anchor must only fire for cite-set questions (expected slugs
    // contain `/`); for identifier-set questions it would wrongly anchor on
    // the source-page cite and report all expected as missing.
    const idgrader = pGrader_distinctSet(['os', 'sys', 'json'], {
      maxMissing: 1, maxExtras: 1, rejectDups: true,
    });
    const answer = [
      '- `os`',
      '- `sys`',
      '- `json`',
      '',
      'Cited pages:',
      'ax/cookbooks',
    ].join('\n');
    expect(idgrader(answer).passed).toBe(true);
  });
});

describe('q3-style answer (real fixture from pre-flight)', () => {
  // The agent's natural q3 answer: prose preamble citing the directory path,
  // then the slug suffixes in a fenced block. normalizeInstallSuffix strips
  // before the last `/`, so the prose tail becomes "`:" — without a slug-shape
  // filter, that counts as an extra (q3 maxExtras=0 → fail).
  const normalizeInstallSuffix = (s: string): string => {
    const trimmed = s.toLowerCase().trim().replace(/\.mdx?$/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    const tail = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
    return /^[a-z0-9_-]+$/.test(tail) ? tail : '';
  };
  const grader = pGrader_distinctSet(
    [
      'configuring-ingress-endpoints',
      'configuring-saml',
      'installation-on-aws',
      'installation-on-azure',
      'installation-on-gcp',
      'installation-on-openshift',
      'installation-on-single-host',
    ],
    {
      maxMissing: 0, maxExtras: 0, rejectDups: true,
      normalize: normalizeInstallSuffix,
    },
  );

  it('passes the real-fixture q3 answer (prose preamble + fenced slug list)', () => {
    const answer = [
      'Here are the pages directly under `ax/selfhosting/installation/`:',
      '',
      '```',
      'configuring-ingress-endpoints',
      'configuring-saml',
      'installation-on-aws',
      'installation-on-azure',
      'installation-on-gcp',
      'installation-on-openshift',
      'installation-on-single-host',
      '```',
    ].join('\n');
    expect(grader(answer).passed).toBe(true);
  });
});

describe('pGrader_distinctSet — Identifiers: anchor (q8 idiom, non-slug-shape expected)', () => {
  // Real q8 failure: both arms produced all expected identifiers but in a
  // multi-column markdown table; tokenizeList split rows on `|` and counted
  // the `Notes` cells as extras. Both orientations now teach the agent to
  // end identifier-list answers with an `Identifiers:` block; the grader
  // anchors on it and ignores the preceding table/prose.
  const grader = pGrader_distinctSet(['os', 'sys', 'json'], {
    maxMissing: 0, maxExtras: 0, rejectDups: true,
  });

  it('anchors on `Identifiers:` block when present (ignores preceding markdown table)', () => {
    const answer = [
      'Here is the complete list of distinct top-level identifiers:',
      '',
      '| Identifier | Notes |',
      '|---|---|',
      '| `os` | `import os` |',
      '| `sys` | `import sys` |',
      '| `json` | `import json` |',
      '',
      'Identifiers:',
      'os',
      'sys',
      'json',
    ].join('\n');
    const r = grader(answer);
    expect(r.passed).toBe(true);
    expect(r.missing_count).toBe(0);
    expect(r.extras_count).toBe(0);
  });

  it('anchor block accepts bullet/numbering/backtick decorations on each line', () => {
    const answer = [
      'Identifiers:',
      '- `os`',
      '1. `sys`',
      '* `json`',
    ].join('\n');
    expect(grader(answer).passed).toBe(true);
  });

  it('anchor block stops at the first blank line followed by more content', () => {
    // If the agent writes the block then trailing prose, we extract only the
    // block lines; trailing prose doesn't count as extras.
    const answer = [
      'Identifiers:',
      'os',
      'sys',
      'json',
      '',
      'These cover all the standard library imports used in the cookbooks.',
    ].join('\n');
    expect(grader(answer).passed).toBe(true);
  });

  it('does NOT trigger Identifiers: anchor when expected is slug-shape (cite-set questions)', () => {
    // A slug-set question must still take the Cited-pages path even if an
    // Identifiers: block happens to appear earlier in the answer.
    const slugGrader = pGrader_distinctSet(['a/b', 'c/d'], {
      maxMissing: 0, maxExtras: 0, rejectDups: false,
      normalize: (s: string) => s.toLowerCase().trim().replace(/^\//, '').replace(/\.mdx?$/, ''),
    });
    const answer = [
      'Cited pages:',
      'a/b',
      'c/d',
    ].join('\n');
    expect(slugGrader(answer).passed).toBe(true);
  });
});

describe('pGrader_distinctSet — slug normalization (q9 strips leading / and .mdx)', () => {
  const grader = pGrader_distinctSet(['auth/oauth', 'auth/api-keys'], {
    maxMissing: 0, maxExtras: 0, rejectDups: false,
    normalize: (s: string) => s.toLowerCase().trim().replace(/^\//, '').replace(/\.mdx?$/, ''),
  });

  it('passes when agent returns slugs with leading / and .mdx', () => {
    const r = grader('/auth/oauth.mdx\n/auth/api-keys.mdx');
    expect(r.passed).toBe(true);
  });

  it('passes when slugs are already normalized', () => {
    expect(grader('auth/oauth\nauth/api-keys').passed).toBe(true);
  });
});
