# fs-vs-skill

A self-contained experiment comparing two ways to put a Claude agent on top of a
Postgres-backed docs corpus (the Arize docs): wrap the database in a filesystem
abstraction, or hand the agent a skill that pulls a slice via SQL and composes locally.
Both arms run the same Claude Agent SDK loop, model, and rubric — the only intended
variables are the tool surface, how orientation is delivered, and the substrate
underneath.

Reproducing it means porting the Arize AX docs into Postgres: each `.mdx` page becomes one
`doc_paths` row keyed by its slug — the repo-relative path with `.mdx` stripped (e.g.
`ax/observe/tracing-concepts/what-are-traces`) — with its frontmatter
(`title`/`description`/`keywords`) as `metadata` jsonb, and the page body split into ordered
`doc_chunks` (`chunk_index` from 0) that `cat`/`grep` reassemble with `string_agg(content
ORDER BY chunk_index)`; a trigram GIN index on `doc_chunks.content` backs search on both
arms. The frozen snapshot was ported from the docs repo at branch `improve-develop`
(commit `26fb79c2`, 2026-04-28), covering the `ax`, `api-clients`, and `link` subtrees
with `hidden`/empty pages skipped — 671 pages / 1,397 chunks.

## What we're testing

When an agent needs to work with data in a database, you choose how it touches that data:

- **Arm A — PostgresFS.** Wrap the DB in a filesystem-shaped interface. The agent runs
  shell verbs (`ls`, `cat`, `grep`, `find`, `cd`) and every read becomes a Postgres
  `SELECT`. This is Mintlify's published `ChromaFs` pattern, ported from Chroma to
  Postgres.
- **Arm B — SQL skill.** No abstraction. The agent gets the host's real bash plus a small
  `./sql` script: run one query, write the result to a local file, compose the answer with
  real `grep` / `jq` / `sort` / pipes.

The bet is that Arm B matches or beats Arm A because the two properties that matter here —
composability and speed — reduce to one: whether the agent owns a local copy of the data
or reaches back through the abstraction on every read. Even a tie favors the skill, since
the abstraction is a large custom layer to keep correct while the skill is a prompt and a
small script.

## The two arms

**Arm A — PostgresFS.** The five ChromaFs verbs (`ls`, `cat`, `grep`, `find`, `cd`) over
virtual paths that resolve to Postgres reads, plus the standard stream filters (`sort`,
`uniq`, `wc`, `awk`, `sed`, `comm`, `cut`, `tr`, `head`, `tail`) that run in-process over
whatever bytes came back. It's wired the way ChromaFs is: an in-process shell
([`just-bash`](https://www.npmjs.com/package/just-bash)) registered as the agent's `Bash`
tool, via an in-process MCP server plus the SDK's `toolAliases`. Read-only — the verbs
become `SELECT`s, writes throw `EROFS`. `cat` reassembles a page server-side with
`string_agg`; `grep` runs a trigram coarse-filter that prefetches matching pages into a
per-run cache, then delegates to native grep; `ls` / `find` answer from an in-memory path
tree built once from `doc_paths`.

**Arm B — SQL skill.** Native `Bash` (cwd pinned to a fresh `/tmp` workdir) plus the SDK's
`Skill` tool, which delivers the `SKILL.md` body when the question matches. The `./sql`
script (Python + psycopg2, read-only `docs_ro` role) takes one query and either returns
rows inline or spills to a local NDJSON file with a navigation summary; the agent then
composes against the result with the host's real coreutils + `jq`.

The model is pinned to `claude-sonnet-4-6`; L-questions are graded by a `claude-opus-4-7`
judge (`src/shared/config.ts`).

## How a run works

`bin/eval.ts` runs a single Node process that gates, executes, grades, and renders:

1. **Gates.** A smoke gate (`./sql` executable, `docs_ro` verified read-only via SQLSTATE
   `42501`, per-arm tool/model probes), an achievability probe, and a check that Arm B's
   skill autotriggers on all 10 questions.
2. **Batch.** 100 cells by default (10 questions × 2 arms × N=5 reps), Fisher-Yates
   shuffled (seed 42). Each cell is a fresh, cache-cold SDK session against the frozen
   corpus, with env hygiene (auto-memory off, an empty per-batch `CLAUDE_CONFIG_DIR`).
3. **Grading.** A pure P-grader (parser + correctness rules) for exact answers, a binary
   Opus L-judge (chain-of-thought, then `pass`/`fail`, with a self-consistency re-call) for
   synthesis, and a programmatic cite pre-gate that rejects answers citing pages not in
   `doc_paths`.
4. **Report.** One Markdown file from `logs/run-<id>.jsonl` — per-(arm, question) and
   per-(arm, tier) tables for accuracy, latency, effort, cost, and a failure taxonomy.
   Timing isolates the **investigation loop** (first prompt to last tool call), the only
   architectural slice. Every cell's JSONL line keeps the full per-turn breakdown
   (`turns[]` with `model_ms`/`tool_ms`, plus `first_tool_call_ms` and `synthesis_ms` on
   the run), so you can manually re-separate the investigation loop from orientation and
   final synthesis after the run, without re-executing.

## Methodology: how the arms and questions were built

Each arm is built to perform to its architectural limit — neither is strawmanned. Arm A
gets the faithful ChromaFs instantiation (real `just-bash`, the full filter set, prefetch
+ per-run cache); Arm B gets the canonical skill bundle with a navigation summary that
removes the substrate-handoff round-trip.

Both orientations — Arm A's `orientation.md` and Arm B's `SKILL.md` — are written as
**general role descriptions for a production assistant querying a database**, not cheat
sheets for the eval. They teach each substrate's cost model and idioms, the corpus shape,
and the output/citation contract; they do not encode answers, per-question hints, or
special-casing. The 10 questions were selected and frozen **before** the arms were built,
spanning three tiers — simple (one or a few reads), mid (aggregation over many pages),
complex (extraction or synthesis whose cost scales with how many separate reads the agent
must gather).

## Prerequisites

- **Node ≥ 22**, an **Anthropic API key**, and **Python** with `psycopg2-binary`.
- **Postgres ≥ 15** with `pg_trgm`, pre-loaded with the corpus —
  `doc_paths(slug text PK, metadata jsonb)` and
  `doc_chunks(id serial PK, page_slug text REFERENCES doc_paths(slug), chunk_index int, content text)`,
  with a trigram-GIN index on `doc_chunks.content`. This repo does **not** seed the corpus.
- A **`docs_ro` read-only role**. Both arms connect through it; the smoke gate asserts
  `INSERT` fails with SQLSTATE `42501`.

## Setup

```sh
npm install

# One-time, against the live DB as a privileged role: create docs_ro + grant SELECT.
psql "$ADMIN_CONNECTION_STRING" -f scripts/grant-docs-ro.sql

pip install psycopg2-binary          # Arm B's ./sql dependency

cp .env.example .env                 # then set PG_CONNECTION_STRING (docs_ro) + ANTHROPIC_API_KEY
```

`.env` is git-ignored and loaded automatically by the npm scripts.

## Running

```sh
npm run typecheck        # tsc, strict
npm run test:unit        # pure unit tests — no DB, no API
npm run test:it          # integration tests — live docs_ro Postgres
npm run test:e2e         # end-to-end — live DB + Anthropic API

npm run eval -- --n 5    # run a batch; writes logs/run-<id>.{md,jsonl}
npm run eval -- --skip-grading              # skip the L-judge (P-grader still runs)
npm run eval:rerun-failed -- logs/run-<id>.jsonl   # re-run only the failed cells
npm run eval:combine -- logs/run-A.jsonl logs/run-B.jsonl   # merge runs + re-render
npm run diagnose         # single-question manual diagnostic harness
```

`*.test.ts` are pure (unit project), `*.it.test.ts` need the live DB, `*.e2e.test.ts`
need the DB **and** an API key. `test:unit` excludes the latter two.

## Layout

```
src/
  arm-a/      PostgresFS: MCP server, just-bash adapter, grep prefetch, path-tree, page-cache, orientation.md
  arm-b/      SQL skill: the ./sql script + skill bundle, workdir setup, metrics stitch
  eval/       question bank, P-grader, L-judge, cite pre-gate, failure taxonomy, render
  shared/     config, pg pool, JSONL records, SDK hooks, per-cell run loop
bin/          CLI entrypoints: eval, eval-combine, eval-rerun-failed, manual-diagnostic
scripts/      grant-docs-ro.sql (one-time role setup)
test/         arm-a/ arm-b/ eval/ shared/ integration/   (unit + it + e2e)
```

Lint is intentionally not configured — strict `typecheck` plus the test suite cover
correctness.
```
