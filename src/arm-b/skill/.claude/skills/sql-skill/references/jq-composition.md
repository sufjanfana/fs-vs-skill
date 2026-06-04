# `jq` composition over spill files

When a `./sql` result spills to `./result_<N>.ndjson`, `jq` is your local compose tool. Treat the spill file as one collection: ONE `jq` invocation processes the whole file. Multiple `jq` invocations selecting different rows pay subprocess cost for no benefit.

## Group and reassemble

The wide-pull pattern is

    SELECT page_slug, chunk_index, content
    FROM doc_chunks
    WHERE <predicate>
    ORDER BY page_slug, chunk_index

Reassemble each page's chunks in one `jq`:

    jq -rs 'group_by(.page_slug)
            | .[]
            | "## \(.[0].page_slug)\n\(map(.content) | join("\n"))"' result_1.ndjson

`jq -s` slurps NDJSON into a single array; `group_by` partitions by `page_slug`; the format string puts each page under a slug header. The input was already ordered by `chunk_index`, so `map(.content)` preserves chunk order.

## Size-aware composition

If the full composition would exceed the runtime's ~30 KB tool-output cap, slice per-page content inside the same `jq`:

    jq -rs 'group_by(.page_slug)
            | .[]
            | "## \(.[0].page_slug)\n\((map(.content) | join("\n"))[0:<chars>])"' result_1.ndjson

Pick the per-page slice size before running:

    budget ≈ cap_bytes ÷ N_pages_selected

If the math doesn't fit, drop pages or tighten the SQL predicate — don't iterate slice sizes after the fact.

## Page selection in `jq`

If the wide pull's `distinct.page_slug` lists more pages than you want to cite, filter in `jq` — the rows are already local, and a second `./sql WHERE page_slug IN (...)` is a wasted round-trip:

    jq -rs '[
      .[] | select(
        .page_slug == "<slug-1>"
        or .page_slug == "<slug-2>"
        or .page_slug == "<slug-3>"
      )
    ]
    | group_by(.page_slug)
    | .[]
    | "## \(.[0].page_slug)\n\((map(.content) | join("\n"))[0:<chars>])"' result_1.ndjson

## Other one-shots

    jq -r '.content' result_1.ndjson
        # every row's content, concatenated newline-separated

    jq -r '.page_slug' result_1.ndjson
        # project one column (de-dup with `| sort -u` if you have GNU sort)

    jq -rs 'map(.page_slug) | unique' result_1.ndjson
        # de-duped page list using jq's own `unique` (works without sort)

    jq -rs 'length' result_1.ndjson
        # total row count from the spill

## Don't iterate

The spill file is deterministic — every row your SQL pulled is in it. A second `./sql` "to double-check" or "to fetch a column we forgot" should be rare. If you find yourself reaching for one, ask first: can the existing spill answer this with another `jq`? Almost always yes.
