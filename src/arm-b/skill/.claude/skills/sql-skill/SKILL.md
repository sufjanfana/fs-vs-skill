---
name: sql-skill
description: Use for any question over a Postgres-backed documentation corpus with a `doc_paths` (slug, metadata) + `doc_chunks` (page_slug, chunk_index, content) schema. Bundles a `./sql` command that runs read-only SELECT and returns rows inline (large results spill to local NDJSON). Each `./sql` call pays ~400 ms of subprocess + libpq + DB overhead, so the skill resolves a question in one query — compute the answer in SQL — or two for page synthesis (locate the pages, then read them), never iterative narrowing.
---

# sql-skill

You answer questions about documentation stored in a Postgres-backed corpus. The skill bundles `./sql`, a thin psycopg2 wrapper that runs read-only `SELECT`s, inlines small results, and spills large ones to a local NDJSON file you can then process with `jq`. Resolve each question in one `./sql` — or two for page synthesis — then read the result once and answer.

## How `./sql` works

Invoke at the skill-relative path:

    .claude/skills/sql-skill/sql 'SELECT ...'

The script connects via `PG_CONNECTION_STRING` (already in env, read-only role), enforces a 30 s statement timeout, and returns one JSON object on stdout. Quote SQL string literals with `$$...$$` to avoid shell-escaping headaches; an empty literal is `$$$$`.

**Inline response** (serialized JSON ≤ 28 KB):

    {"row_count": N, "rows": [{...}, ...]}

Rows are right there in the response.

**Spill response** (> 28 KB): rows are written to `./result_<N>.ndjson` (sequential per cell), and stdout returns a navigation summary:

- `row_count`, `file_path`, `byte_size` — basics.
- `columns` — the schema of each NDJSON line, so `jq` selectors are right the first time.
- `distinct` — per-column unique values for columns with ≤ 200 distinct entries. **This IS the navigation index**; don't `jq` for distinct values that are already in `distinct`.
- `first_row` — row shape with a 200-char content sample. Confirms column meaning before composing.

On SQL error the script prints to stderr and exits 1. Read the stderr and adjust the query; don't retry the same SQL.

## Schema

- `doc_paths(slug TEXT PRIMARY KEY, metadata JSONB)` — one row per page. Common `metadata` keys: `title`, `description`, `keywords`. Read with `metadata->>'title'`.
- `doc_chunks(id INT PRIMARY KEY, page_slug TEXT REFERENCES doc_paths(slug), chunk_index INT, content TEXT, UNIQUE (page_slug, chunk_index))` — pages split into chunks. Reassemble with `ORDER BY chunk_index` or `string_agg(content, chr(10) ORDER BY chunk_index)`. Dollar-quoting does not honor `\n` as an escape; use `chr(10)`.
- Trigram GIN index on `doc_chunks.content` — `ILIKE '%pattern%'` and `~* 'regex'` are fast for selective predicates. Unselective predicates (matching a large fraction of chunks) scan more.
- Slug shape is path-like with no leading `/` and no extension: `<section>/<subsection>/<page>`. `LIKE '<prefix>/%'` scopes to a subtree. Some slugs are both a page and the prefix of their children; use `slug = '<prefix>' OR slug LIKE '<prefix>/%'` when the landing page is part of the count.

Slug segments are numbered from 1 with `split_part(slug, '/', N)` — `<section>/<subsection>/<page>` is positions 1/2/3.

## Cost model

Each `./sql` call costs ~400 ms of overhead before any query work: ~50–70 ms Python startup + psycopg2 import, ~5–15 ms libpq connect, plus SDK Bash dispatch latency. The actual `SELECT` against an indexed predicate is usually 10–30 ms.

`jq` over a local NDJSON file is pure CPU and effectively free.

**This shapes every decision.** One SELECT that returns the answer is one round-trip; five narrowing SELECTs pay the overhead five times for nothing new. When you can answer in SQL, do; when you need page content, locate then read — at most two round-trips.

## Pre-flight

Before your first `./sql`:

1. Name the question shape in one sentence (count / scalar / set / distinct list / page-content synthesis).
2. Write the SQL you expect to issue. For most shapes, the SQL IS the answer.
3. If your plan has 3+ `./sql` calls, re-derive — most questions resolve in 1–2.

The pre-flight is mental; don't print it. Its job is to commit you to a small N upfront so you don't iterate after the fact.

## The two shapes

Decide which shape the question is up front, then commit to a single round-trip.

### Compute-in-SQL — count, scalar, lookup, group-by, set, distinct list

The query *is* the answer. Do the whole job inside one `SELECT` — extract, normalize, dedupe, aggregate — so the rows come back final and need no post-processing:

- count / frequency → `COUNT(*)`, `SUM(regexp_count(content, $$<term>$$))`
- per-bucket count → `COUNT(*) ... GROUP BY split_part(slug, $$/$$, <N>)`
- slug / metadata lookup → `SELECT slug ... WHERE slug ILIKE $$%<kw>%$$`
- cross-page set logic → `INTERSECT` / `EXCEPT` / `UNION` of `SELECT DISTINCT page_slug` subqueries
- distinct tokens → `SELECT DISTINCT (regexp_matches(content, $$<one-capture-group>$$, $$g$$))[1]`; wrap `lower()` / `split_part()` / `trim()` around the capture so each row comes back already final.

Emit the rows verbatim under the answer anchor, one token per line — never a markdown table, and don't `SELECT` titles or extra columns for presentation (they aren't graded and parse as extras). Don't reshape, dedupe, or filter the rows in your head, and don't run a second `./sql` to "clean up" — a pattern over prose always returns a few false positives, and they cost nothing the answer is graded on. One query, emit, done.

### Content synthesis — the answer is page text

At most two queries: **Locate** the pages, then **Read** them. Then synthesize.

**Locate** — one ranked candidate list (slugs + counts, inline):

    SELECT page_slug, COUNT(*) AS n
    FROM doc_chunks
    WHERE content ILIKE $$%<core-term>%$$
    GROUP BY page_slug ORDER BY n DESC LIMIT 12

Count-ranking surfaces the pages most about the topic; the slug names tell you which to cite. Trust the ranking — the top of this list is your answer set. Don't rerun Locate with synonyms to "find more."

**Read** — ONE pull of every page you'll cite (≤ ~6), reassembled and sliced to stay inline:

    SELECT page_slug, LEFT(string_agg(content, chr(10) ORDER BY chunk_index), 3500) AS body
    FROM doc_chunks
    WHERE page_slug IN ($$<slug-1>$$, $$<slug-2>$$, ...)
    GROUP BY page_slug ORDER BY page_slug

Choose the pages from the Locate list and pull them all in this one query — ≤6 × 3500 chars stays under the inline cap. Docs front-load their key content, so the slices hold what you need: synthesize from this one result, grounding each point in its page, and **end with a `Cited pages:` block listing exactly the pages you Read** (synthesis answers always cite, even when the prompt doesn't say to). Don't pull more pages afterward to cite them, don't re-pull a page in full, don't read pages one at a time. (If it ever spills, lower the slice — never `jq`.)

**Shortcut:** if your predicate is already specific — a distinctive term, or a known subtree via `slug LIKE $$<prefix>/%$$` — skip Locate and Read directly in one query. A multi-aspect question or a two-sided comparison is still ONE topic: `OR` its terms in a single Locate, not a query per aspect.

## Then answer — don't keep digging

Budget: **content** is two queries (Locate, then Read); **everything else is one**, and its rows are the answer. The moment the result lands you have everything; your **next message is the answer**, not a "here's what I found" turn.

1. **Emit immediately.** Compute rows go verbatim under the anchor; content pages get synthesized. Don't narrate the result in an intermediate turn first.
2. **A query past the budget is the failure signal** — a second for compute, a third for content. No regex/predicate refinement, no synonym retries of the Locate, no single-page full re-pulls, no "recovery" query — you already have your answer.
3. **Don't read a result piecemeal.** No `jq .page_slug` preview, no per-page `grep`/`head`/`tail`, no composing a subset then another.
4. **Don't post-process in your head.** If you ran `./sql` to count or extract, the rows are the answer.

The trigram index is deterministic: a selective query already returned every matching row. The tell that you're over-working it is a third `./sql`, a `jq`, or a spill file.

## Common idioms

Worked examples and edge cases live in companion references:

- `references/sql-idioms.md` — aggregates (occurrence counts, per-bucket group-by), set operations (`INTERSECT`/`EXCEPT`), distinct token extraction (`regexp_matches`), slug/metadata lookup.
- `references/jq-composition.md` — `jq` cookbook for spill files: group_by, page filtering, common one-shots.

The body above covers the patterns you'll reach for most often. Read the references when a shape doesn't fit.

## Output format

When a question asks you to cite pages or list items, end your answer with one of these blocks on its own paragraph:

    Cited pages:
    <slug-1>
    <slug-2>

    Identifiers:
    <token-1>
    <token-2>

Use `Cited pages:` for slugs (no leading `/`, no extension), `Identifiers:` for names, symbols, or other non-slug tokens. One item per line, plain text. Put prose or summary BEFORE the anchor block; the anchor block itself contains only the bare items — never a markdown table, a fenced code block, or an extra column. An added column turns every cell into a token the parser reads as a spurious item:

    Identifiers:                  | <token>  | <extra-column> |
    <token>            not        | -------- | -------------- |
    <token>                       | <token>  | <value>        |

Emit just the tokens, one per line.

## Recap

1. `./sql` round-trips are expensive (~400 ms each) and each is a model turn; `jq` is free. Optimize for fewer round-trips.
2. Compute-in-SQL for count / scalar / lookup / group-by / set / distinct list: do the whole job in one `SELECT` and emit the rows verbatim.
3. Content synthesis: Locate (ranked slug list), then Read (the ≤6 pages you'll cite, sliced to inline) — at most two queries, then synthesize and end with a `Cited pages:` block. No `jq`.
4. The result holds everything — a third `./sql`, a `jq`, or a spill means you over-worked it. Emit/synthesize immediately.
5. End list answers with the `Cited pages:` or `Identifiers:` anchor block.
