# questions.md — eval set + tier rationale

## How these were chosen

The set needs roughly balanced coverage across three complexity tiers, so the stratified per-(question, tier) rollup isn't dominated by any single tier or question shape.

The set is sized **3 simple / 4 mid / 3 complex**. Tier definitions:

- **simple** — single-page lookup, no composition.
- **mid** — one aggregation OR one cross-page comparison; modest composition.
- **complex** — dedup, set-ops, or multi-page synthesis with structured extraction.

q2 (Okta slug) and q3 (installation enumeration) are the newest additions; the rest are retained from earlier iterations of the set.

All expected answer values, slug sets, and term counts must be verified against the live `docs_fs` corpus (671 paths, 1397 chunks) at freeze time. q2 and q3 expected values below are pre-verified.

---

## Simple tier (3)

### q1 — single-page rename + cite

**Prompt.** The Arize Python SDK v8 renamed the `model_id` parameter. What did `model_id` do, what was it renamed to in v8, and which page documents the rename? Cite the page.

**Tests.** Single migration page; one fact + one cite. No composition.

---

### q2 — single-page slug lookup

**Prompt.** What is the slug of the Arize docs page that documents how to set up SSO with Okta? Return just the slug.

**Tests.** Slug-shape lookup, no body content needed.

**Expected answer.** `ax/security-and-settings/sso-and-rbac/setting-up-sso-with-okta` (verified).

---

### q3 — single-directory enumeration

**Prompt.** List every page directly under `ax/selfhosting/installation/`. Return just the slug suffixes (e.g., `installation-on-aws`), one per line.

**Tests.** Single-directory enumeration; one verb on a known path.

**Expected answer (7 slugs, verified).**
- `configuring-ingress-endpoints`
- `configuring-saml`
- `installation-on-aws`
- `installation-on-azure`
- `installation-on-gcp`
- `installation-on-openshift`
- `installation-on-single-host`

**Grader.** `pGrader_distinctSet({maxMissing:0, maxExtras:0, rejectDups:true})`.

---

## Mid tier (4)

### q4 — single-term frequency

**Prompt.** How many times does `log_evaluations` get mentioned across the Arize docs?

**Tests.** Single-term grep + count across the entire corpus.

**Grader.** `pGrader_exactNumber(31, 0)`.

---

### q5 — subtree page count

**Prompt.** How many recipe pages live anywhere under the `ax/cookbooks/` directory tree, including pages nested inside subdirectories like `ax/cookbooks/agents/`? Exclude only the `ax/cookbooks` section index itself.

**Tests.** Subtree count, no dedup.

**Grader.** `pGrader_exactNumber(35, 0)`.

---

### q6 — 4-bucket group-by aggregation

**Prompt.** How many pages live in each of these LLM provider integration subtrees: `openai`, `anthropic`, `mistralai`, `google-gen-ai`? Each is a subdirectory of `ax/integrations/llm-providers/`. Count every page within each provider's subtree.

**Tests.** Group-by aggregation, 4 fixed buckets, paired key↔count precision.

**Grader.** `pGrader_pairedKeyCount({openai: 5, anthropic: 3, mistralai: 3, 'google-gen-ai': 4})`.

---

### q7 — cross-section comparison

**Prompt.** What's the difference between online evals and offline evals in Arize? When would I use one over the other?

**Tests.** Cross-section content synthesis (run-evals-on-traces vs run-evals-on-experiments).

---

## Complex tier (3)

### q8 — distinct identifier dedup

**Prompt.** List the distinct top-level identifiers imported via `import X` or `from X` statements in Arize's cookbook pages. "Top-level identifier" means: take the FIRST identifier appearing after each `import` or `from` keyword, then take whatever comes before its first `.`. Match lowercase-starting identifiers only (skip prose words like "Note:"). Include stdlib (`os`, `sys`, etc.), third-party PyPI packages, and locally-defined notebook modules.

**Tests.** Regex extraction across hundreds of import lines + **dedup across the entire match set**.

**Grader.** `pGrader_distinctSet(Q8_EXPECTED, {maxMissing:1, maxExtras:1, rejectDups:true})` — 54 expected identifiers.

---

### q9 — set intersection across pages

**Prompt.** Which Arize docs mention both "OpenInference" AND the word "evaluator" (or its plural "evaluators")? Match case-insensitively as substrings — any page whose content contains both substrings anywhere counts. List every matching page.

**Tests.** Page-level set intersection (two filters AND-combined) + locality (per-page content reads to confirm).

**Grader.** `pGrader_distinctSet(Q9_EXPECTED, {maxMissing:1, maxExtras:0, rejectDups:false, normalize: normalizeSlug})` — 17 expected slugs.

---

### q10 — multi-page synthesis + attribute precision

**Prompt.** How does session tracking work in Arize end-to-end? What does the SDK emit, how does it surface in the UI, and how is it queried? Cite every page you used.

**Tests.** Multi-page synthesis across `ax/instrument/`, `ax/observe/tracing/`, `ax/observe/tracing-concepts/` + **the critical precision distinction**: the SDK emits `session.id` (dotted span attribute), not `session_id` (the function parameter name). Many agents conflate these.

**Rubric highlights.** Names `session.id` literally; names Python (`using_session` / `using_attributes`) or JS (`setSession`) entry point; describes Sessions UI tab; describes traces grouped by `session.id`; cites ≥3 distinct pages. Disqualifying: invents `set_session_id`, `track_session`, `SessionTracker`.
