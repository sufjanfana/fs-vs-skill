# SQL idioms

Worked examples for the most common shapes. Schema is `doc_paths(slug TEXT PRIMARY KEY, metadata JSONB)` and `doc_chunks(id INT PRIMARY KEY, page_slug TEXT, chunk_index INT, content TEXT)` with a trigram GIN index on `doc_chunks.content`.

Each example shows the SQL only. Wrap in `.claude/skills/sql-skill/sql '...'` to run, and use `$$...$$` for string literals.

## Aggregates and counts

**Occurrence count (literal — always safe).** Counts non-overlapping occurrences without regex escaping:

    SELECT SUM(
      (LENGTH(content) - LENGTH(REPLACE(content, $$<term>$$, $$$$)))
      / LENGTH($$<term>$$)
    ) AS n
    FROM doc_chunks
    WHERE content ILIKE $$%<term>%$$

**Occurrence count (regex — `regexp_count`, PG15+).** Concise but interprets `<term>` as a regex; use the literal form above if `<term>` contains regex metacharacters (`. * + ? ( ) [ ] { } | ^ $ \`):

    SELECT SUM(regexp_count(content, $$<term>$$)) AS n
    FROM doc_chunks
    WHERE content ILIKE $$%<term>%$$

**Subtree page count.**

    SELECT COUNT(*) FROM doc_paths
    WHERE slug LIKE $$<prefix>/%$$

If the landing page (`slug = '<prefix>'`) should be counted, add `OR slug = $$<prefix>$$`.

**Per-bucket count (group-by on a slug segment).** `split_part(slug, '/', N)` extracts the Nth segment counting from 1:

    SELECT split_part(slug, $$/$$, <N>) AS bucket, COUNT(*) AS n
    FROM doc_paths
    WHERE slug LIKE $$<prefix>/%$$
    GROUP BY 1
    ORDER BY 1

## Set operations

`INTERSECT` between two `SELECT DISTINCT page_slug` subqueries finds pages where two terms BOTH appear, regardless of whether they live in the same chunk. A naive `content ILIKE '%A%' AND content ILIKE '%B%'` applies per-chunk and misses pages where the terms live in different chunks of the same page:

    SELECT DISTINCT page_slug FROM doc_chunks WHERE content ILIKE $$%<A>%$$
    INTERSECT
    SELECT DISTINCT page_slug FROM doc_chunks WHERE content ILIKE $$%<B>%$$

`EXCEPT` works the same way for "pages containing A but not B":

    SELECT DISTINCT page_slug FROM doc_chunks WHERE content ILIKE $$%<A>%$$
    EXCEPT
    SELECT DISTINCT page_slug FROM doc_chunks WHERE content ILIKE $$%<B>%$$

`UNION` (with `DISTINCT`, the default) for "pages containing either."

## Distinct token extraction

`regexp_matches` returns capture groups as an array per match; `(...)[1]` extracts the first group as text. The `g` flag returns every occurrence in each chunk, and `SELECT DISTINCT` deduplicates server-side:

    SELECT DISTINCT (regexp_matches(content, $$<pattern-with-one-capture-group>$$, $$g$$))[1] AS tok
    FROM doc_chunks
    WHERE page_slug LIKE $$<subtree>/%$$
    ORDER BY 1

Example pattern shapes:

- Import-line identifiers: `(?:^|\n)\s*(?:import|from)\s+([a-z_][a-z0-9_]*)` (captures the first identifier after `import`/`from`).
- Section anchors: `\n##\s+([^\n]+)` (captures H2 titles).
- URL hosts: `https?://([a-z0-9.-]+)` (captures the host).

The first extraction will include some false positives — extraction patterns matched against natural prose always do. Don't iterate the regex with tighter anchors, non-capturing wrappers, or `WHERE NOT SIMILAR TO` exclusion lists; emit the deduped set and stop.

## Slug and metadata lookup

`doc_paths` is the small path-only table; filter on `slug` directly rather than scanning `doc_chunks.content`:

    SELECT slug FROM doc_paths WHERE slug ILIKE $$%<keyword>%$$

    SELECT slug, metadata->>$$title$$ AS title
    FROM doc_paths
    WHERE slug LIKE $$<prefix>/%$$

For JSONB reads, `->>` returns text and `->` returns JSONB. Use `->>` whenever you want the value as a string.

## No presentation queries

When the answer is a slug list, emit the slug list. Don't issue a follow-up `./sql` joining `doc_paths` to fetch `metadata->>'title'` for a presentation table — titles add a round-trip and aren't part of the answer most consumers care about. If you want prose annotations, name slugs by their stem (`the <slug-stem> page`) rather than by a fetched title.
