# dsh-memory

Long-term project memory and a token cascade for DeepSeek Harness agents.

**Русская версия:** [README.md](README.md)

> **Status: MVP, phase 5 and local RAG are ready.** Memory (SQLite FTS5 + lexical:
> stemmer, trigram, synonyms), the `memory.*` tools (available to the agent via
> `ctx.tools`) with TTL and metrics, top-k injection, the soft L1→L2→L3 cascade,
> verification. **Local RAG is the default**: `@vkozachek/dsh-memory-embeddings`
> enables a local ONNX model (`multilingual-e5-small`); weights are downloaded on
> the first run into `~/.dsh/memory/models` and then work offline; cloud providers
> are optional. The L2→L3 router and the role dispatcher are implemented behind
> flags: acceptance in [`docs/dispatcher-calibration.md`](docs/dispatcher-calibration.md),
> design in [`docs/router-design.md`](docs/router-design.md), [`docs/roles-design.md`](docs/roles-design.md).

## Problem

An agent session starts from scratch: the agent re-reads the same docs and
source files, asks and answers questions at full price, and knowledge
evaporates when the session ends. The answer to "why is this designed this
way?" sits in a past session or a decision record, but reaching it costs more
than re-deriving it. dsh-memory makes the expensive path the exception: cheap
lookups first, the main model last, and what is learned is kept once verified.

## What it does

By design (nothing here is implemented yet), the plugin:

- **Answers from cheap sources first.** A four-level cascade: deterministic
  lookups, local retrieval, a cheap submodel, and only then the main model.
- **Injects memory into every turn.** At most three short entries inside a fixed
  token budget — or nothing at all when nothing matches.
- **Writes knowledge back.** A successful answer is distilled, given provenance,
  stored as a draft and reused only after a PASS or human confirmation.
- **Keeps memory honest.** Entries go stale when their source changes or
  disappears, and stale knowledge is never returned to a model.

## Install and first run

```bash
dsh plugin --profile web add @vkozachek/dsh-memory   # then restart DSH Web
```

- nothing to configure: memory is local (SQLite FTS5), no network, no API keys;
- `dsh-memory index` indexes the markdown documentation manually (incrementally,
  filtering secrets out);
- auto-indexing: when the index is empty, the first turn schedules markdown
  indexing in the background (does not block the turn); later runs are
  incremental by sha256; opt out with `DSH_MEMORY_AUTOINDEX=off` or
  `index.autoindex: false`;
- planned later (outside phase 0): `dsh-memory doctor` (DB path, namespace,
  files/chunks, skipped secrets) and `dsh-memory index --dry-run`;
- vectors are not part of the main package: the separate
  `@vkozachek/dsh-memory-embeddings` package enables local RAG by default
  (`Xenova/multilingual-e5-small`; first use downloads weights, then offline);
  design and trust boundaries are in [docs/embeddings-design.md](docs/embeddings-design.md), local RAG acceptance:
[docs/benchmark-local-rag.md](docs/benchmark-local-rag.md).

### First query

```bash
# 1. Index the workspace markdown documentation (the package CLI).
#    --json prints the report: files / indexed / chunks / revived / stale / removed / skipped / secrets.
#    --namespace names the memory; without it the workspace directory name is used.
dsh-memory index --workspace . --namespace dsh-memory --json

# 2. Search the memory. Inside a DSH profile the memory.search tool does this;
#    in a package checkout the same call can be verified directly:
node --input-type=module -e "
  import { openStore } from './lib/store.js'
  import { searchMemory } from './lib/search.js'
  const store = openStore({ dbPath: '~/.dsh/memory', namespace: 'dsh-memory' })
  console.log(searchMemory(store, { query: 'cascade L0 L1 L2 L3', k: 3 }))
"
```

A `memory.search` request is `{ "query": "cascade L0 L1 L2 L3", "k": 3 }`; the
answer is a list of snippets `[{ id, title, snippet, source_path, source_ref,
status, confidence, score }]` — the full document text never leaves the store.

## How it works

```text
  request
     v
  [L0] deterministic sources: board, cards, grep/glob    0 model tokens
     v miss
  [L1] RAG memory: top-k snippets, SQLite FTS5           0 model tokens
     v miss
  [L2] cheap submodel: ANSWER | NO_ANSWER                limited max_tokens
     v NO_ANSWER
  [L3] main model: from the session settings             full cost
     v answer
  write-back: distill + provenance --> draft
     v PASS review/test or human confirmation
  verified --> served by L1 on the next question
```

| Level | What it does | Cost |
| --- | --- | --- |
| L0 | board, cards, `grep`/`glob` — deterministic, no model involved | 0 model tokens |
| L1 | top-k snippets from the local SQLite FTS5 index | 0 model tokens |
| L2 | cheap submodel under `ANSWER \| NO_ANSWER`, allowed to say "I don't know" | limited `max_tokens` |
| L3 | the main model from the session settings, only on `NO_ANSWER` | full price |

**Cascade rule.** Before any model answer, search memory (`memory.search`, L1).
On a miss, use the `triage` preset (L2: cheap `deepseek-v4-flash` model,
`ANSWER | NO_ANSWER` contract; markers are recognized with trailing punctuation,
so `NO_ANSWER.` is a refusal, not an answer). On `NO_ANSWER`, call the main
model (L3). An L2/L3
answer is distilled back into memory as a `draft` with a source (write-back);
`verified` is set only by confirmation (006/013).

**Verified knowledge only.** Write-back is gated: a distilled answer is stored as
`draft` with `confidence ≤ 0.6` (model write-back must pass an
`cascade:*`/`model*`/`triage*` `author`) and becomes `verified` only through
`memory.verify`, which requires a source and a confirmer: a review/test PASS
(`reviewer:…`/`verifier:…`/`tester:…`) or a human (`human`); a bare session id is
rejected so a session cannot confirm its own record. `memory.write` cannot write
`verified` directly. The only manual exception is `human` confirming a source-less
entry with `requireSource: false` — an explicit human act, not a review/test PASS. Otherwise one hallucination enters the index and is
then served to every future session *cheaper than it would have cost to verify*.

## Memory (RAG)

Search is lexical, with no vectors and no network: FTS5 over a stemmed index
(Russian Snowball + loose stems), a trigram index for typos and substrings,
synonyms from `data/synonyms.json` (disabled with `search.synonyms: false`), and
a separate verified Q&A channel whose title matches rank above ordinary
snippets (lexical engine and `verified` status only). Plain `unicode61` remains the comparison engine (`engine:
"unicode61"` / `dsh-memory bench --compare`).

| Aspect | Design |
| --- | --- |
| Storage | SQLite at `~/.dsh/memory/<namespace>.db`: `sources`, `entries`, `entries_fts`, `metrics` |
| Namespace | one per workspace; the MVP has no cross-project memory |
| Kinds | `doc`, `decision`, `fact`, `answer`, `code-note` |
| Statuses | `draft`, `verified`, `stale` — stale is never returned |
| Provenance | every entry carries `source_path`, `source_ref`, author, timestamps |
| Dedupe | `hash = sha256(kind\|title\|text)` is UNIQUE; a match raises confidence and merges sources |
| Indexing | `.kanban/tasks/*.md` and `docs/adr/*` → `decision` (180-day TTL), component READMEs and other docs → `doc`; chunks are split by `##` |
| Invalidation | source sha256 changed or file deleted → indexer chunks go `stale` (text kept in the DB for audit, never served); source removal is scoped to the namespace (`namespace: auto` = one namespace per workspace) |
| TTL | `decision` 180 days, `fact` 60 days, `answer` 30 days |

## Tools

| Tool | Purpose | Input → output |
| --- | --- | --- |
| `memory.search` | find relevant knowledge | `{ query, k?, kinds?, status?, namespace? }` → `[{ id, title, snippet, source_path, source_ref, status, confidence, score }]` |
| `memory.write` | store distilled knowledge | `{ text, title, kind, sources[], confidence?, status? }` → `{ id, deduped, status }` |
| `memory.invalidate` | mark dependent entries stale | `{ path?, ref? }` → `{ affected }` |
| `memory.verify` | promote a draft to verified | `{ id, verified_by }` → `{ id, status: "verified" }` |
| `memory.stats` | usage and savings | `{}` → `{ entries, by_status, hit_rate, injected_tokens, tokens_saved_estimate, dispatch }` |

Tools are registered in `ctx.tools` once the `tools` service becomes available:
`apply` waits for it via `ctx.inject(['tools'], …)` (it may appear after apply,
as in the desktop profile). If `tools` never appears, the plugin loads as before
and the `ctx.memory` API modules remain available.
`memory.search` returns `verified` entries by default; `status: "all"` adds
`draft` entries marked by status, and snippets are truncated to 300 characters —
a pointer, never the document.
`memory.write` dedupes by hash; a source-less record is only a `draft` with
`confidence < 0.5`.

## Context injection

On every turn the plugin searches by the first 200 characters of the last user
message and injects at most 3 entries (budget ≤ 600 tokens) as
`[memory] title — snippet (source, status)`. If nothing matches, no block is
added and the turn costs nothing extra. Disabled by `DSH_MEMORY_INJECT=off`;
added latency to first token ≤ 50 ms, never blocking.

## Dispatcher and specialised submodels (design spike 018)

Beyond the MVP, the cheap L2 role can be played not by a single submodel but by
a dispatcher (manager submodel) with a registry of specialists: it gets the
request after an L0/L1 miss, splits it into subtopics and routes each one to a
specialist. Specialists answer from their own knowledge plus RAG and escalate
to L3 when they cannot.

```text
  request (after L0/L1 miss) --> dispatcher (manager submodel)
     |  analyse -> split into subtopics -> route to a specialist
     |
     +--> developer --> reviewer --(comments)--> back to developer
     +--> designer | tester | scientist
     |
     v
  aggregate: resolve conflicts, decide escalation
     +--> answer: reply to the agent, write-back to shared verified memory
     +--> no answer: escalate to L3
```

| Role | Area of responsibility |
| --- | --- |
| developer | software engineering: implementation, debugging, refactoring; fixes per review comments |
| designer | design: UX, interfaces, visual and interaction decisions |
| reviewer | strict, unbiased review of the developer's code; comments go back to the author, and the reviewer never fixes the code |
| tester | testing of all kinds: unit, integration, end-to-end, edge cases |
| scientist | physics, mathematics, chemistry, biology and related fields |

The developer → reviewer → fixes loop matters: no specialist signs off on its
own output; the tester works independently of the developer. Roles scale
through a **role registry**: a new specialist is a configuration entry, not a
dispatcher change. Phase 5 is implemented behind `dispatcher.enabled:false`:
the hook calls the dispatcher after an L1 miss, and an uncovered plan/error/
cancellation falls back to L3. Design: [docs/roles-design.md](docs/roles-design.md);
acceptance and thresholds: [docs/dispatcher-calibration.md](docs/dispatcher-calibration.md).
Risks: latency, coordination cost, routing errors, conflicting answers,
prompt and role versioning.

## Configuration

The `dsh-memory` block in `~/.dsh/cordis.patch.yml`; defaults and environment
parsing live in `lib/config.js`, and the row config and `DSH_MEMORY_*` override them.

```yaml
dsh-memory:
  namespace: auto
  db_path: ~/.dsh/memory
  inject: { enabled: true, top_k: 3, token_budget: 600 }
  search: { default_status: verified, snippet_chars: 300, synonyms: true }
  index:
    include: ["**/*.md"]
    exclude: [".git/**", "node_modules/**", "target/**", "dist/**", "build/**", "tmp/**", ".cache/**", "worktrees/**", "bench/**", "test/**", "docs/benchmark-*.md"]
    max_chunk_tokens: 800
    autoindex: true
  embeddings: { enabled: false, model: "" }   # legacy main-package field; local RAG lives in dsh-memory-embeddings (enabled:true)
  verify: { require_source_for_verified: true }
  router: { enabled: false, confidence_threshold: 0.6, timeout_ms: 5000 }
  dispatcher:
    enabled: false                                 # phase 5, off by default
    strategy: priority                             # single | priority | concat | vote
    timeout_ms: 5000
    plan_timeout_ms: 5000                          # planner timeout (026)
    max_subtasks: 8                                # subtopic limit (026)
    shared_namespace: false                        # roles write to their own namespace (029)
    default_role: ""                               # role for an unrouted subtopic
    roles: []                                      # [{ name, prompt, model, namespace, ... }]
  cascade:
    enabled: false                                 # soft cascade L1 -> L2 (triage) -> L3
    preset: triage                                 # presets/triage.json: cheap model, ANSWER | NO_ANSWER
    model: ""                                      # overrides the preset model (deepseek-v4-flash)
    max_tokens: 300
    write_back: true                               # L2/L3 answer -> memory.write (draft with a source)
```

The `triage` preset is a cascade descriptor (`presets/triage.json`: cheap model,
`ANSWER | NO_ANSWER` contract, `max_tokens`), not a DSH agent preset: routing is
owned by `lib/cascade.js` and enabled by the `cascade` section above. After an
L2/L3 answer the cascade writes a distilled entry back to memory as a `draft`
with a source (`write_back`). When the provider supplies no sources, the entry
gets the synthetic `source_ref` `cascade:L2`/`cascade:L3`. `cascade.enabled:
false` is the supported "no cheap model" mode: memory (L1) is still searched
first, then the main model (L3) runs directly.

## Benchmark

The MVP benchmark is one reproducible command: fixtures
(`bench/fixtures/project`) and 20 questions (`bench/questions/questions.json`)
ship with the package; no network, no current date. The numbers are measured
on that fixture (10 documents), not on a real project corpus: this is an
acceptance test of the mechanism, not a promise of −44% on any project.

```bash
dsh-memory bench --report docs/benchmark-mvp.md
```

"Before" is the full text of the answer source; "after" is the L1 injection
(top-k snippets, 600-token budget) plus the source on a miss. A hit counts as
relevant only when `source_path` matches, so weak `matchMode: any` matches do
not count as savings. Targets: hit-rate ≥ 20%, token savings ≥ 25%; the report
with numbers and the question table is [docs/benchmark-mvp.md](docs/benchmark-mvp.md).
Exit code 0 means targets met, 1 means not met.

### Real corpus

A separate scenario asks 20 questions about the repository's own documents
(README, AGENTS, PLAN, specs, task cards); `bench/` fixtures are excluded from
the index so the benchmark cannot answer itself:

```bash
dsh-memory bench --workspace . --questions bench/questions/real.json \
  --compare --with-fixture --report docs/benchmark-real.md
```

[docs/benchmark-real.md](docs/benchmark-real.md) contains exact numbers, misses,
and comparisons with fixture 015 and plain `unicode61`. On the current corpus
the lexical engine gets about 85% hit-rate and 85% savings (`unicode61`: about
65%); the numbers drift as the repository grows, the misses are broad semantic
questions. The local hybrid (FTS5 + e5-small) keeps the same 85% at a 20–30 ms
p95 injection latency with a ~129 MB model cache — see
[docs/benchmark-local-rag.md](docs/benchmark-local-rag.md). The benchmark always
uses a temporary DB unless `--db-path` is given; `DSH_MEMORY_DB` does not affect
`bench`.

## Hard L2→L3 router (017)

The experimental `router` flag (off by default) routes a turn after L1: a
confident L2 (`confidence >= confidence_threshold`) serves the turn, otherwise
L3 is called unconditionally. The decision is recorded in `metrics` as `route`;
L2 is buffered, L3 streams; cancellation/timeouts use `AbortSignal` and
`timeout_ms`. Design, entry point and limits:
[docs/router-design.md](docs/router-design.md); with the flag off behaviour is
unchanged (direct L3).

## Role dispatcher (phase 5)

The experimental `dispatcher` (off by default) hands a turn to roles after an L1
miss: the registry comes from `dispatcher.roles`, role providers are registered
by an adapter via `memory.registerRoleProvider(name, fn)`, and the planner via
`memory.registerDispatcherPlanner(fn)`. If the plan is not covered, a role
fails/times out, or the turn is cancelled, the hook stays out of the way and the
turn proceeds to L3 (or ends by cancellation). A dispatcher answer is added as a
`dsh-memory-dispatcher` plugin message and recorded in `metrics` as L2. Role
write-back (`memory.writeRole`) is `draft` only with `author: role:<name>` and
`confidence ≤ 0.6`, in the role namespace (or the shared one when
`dispatcher.shared_namespace: true`); `verified` is only reachable through
`memory.verify`. With the flag off the package behaviour is unchanged; design:
[docs/roles-design.md](docs/roles-design.md).

## Embeddings (optional)

The optional
[`packages/dsh-memory-embeddings`](packages/dsh-memory-embeddings/README.md)
package enables local RAG by default (multilingual-e5-small, ONNX weights
downloaded to `~/.dsh/memory/models` on first use) and also supports
OpenAI-compatible/Ollama embeddings,
stores vectors in SQLite BLOBs and contributes a hybrid RRF BM25 + cosine
channel via `memory.registerSearchChannel`. The main package gets no network
code; all egress lives in the optional package, the key comes from env only, and
`DSH_MEMORY_NO_NETWORK=1` blocks the network. Quality/latency vs FTS5:
[docs/benchmark-embeddings.md](docs/benchmark-embeddings.md); diagnostics:
`dsh-memory-embeddings doctor --config <file.json>`; design and criteria:
[docs/embeddings-design.md](docs/embeddings-design.md), local RAG acceptance:
[docs/benchmark-local-rag.md](docs/benchmark-local-rag.md).

The main package's `memory.search` is **async** (it waits for embedding
channels); `memory.searchSync` is the synchronous variant for CLI/benchmarks
that skips async channels.

## Metrics

| Goal | Metric | MVP target |
| --- | --- | --- |
| Cheaper repeat questions | tokens spent on repeated questions | −25% |
| Retrieval actually works | L1 hit-rate | ≥ 20% |
| Traceable knowledge | verified records with provenance | 100% |
| No unsourced facts | verified records without a source | 0 |
| Invisible overhead | added latency to first token | ≤ 50 ms |
| Injection stays small | injected block size | ≤ 600 tokens |

`memory.stats` semantics: `injected_tokens` is the cost of memory injections
(every turn appends another snapshot block to the history, so the cost
accumulates); `tokens_saved_estimate` is savings only where a turn is served by
L2 instead of L3, and stays 0 in the MVP until benchmark 015 calibrates it.
`dsh-token-meter`, when available, is used as the authoritative token estimator
(`estimateMessage`); it exposes no metric-publishing channel, so metrics live in
the plugin's own `metrics` table.

## Scope and security

**Non-goals**

- Not a replacement for `AGENTS.md` / `CLAUDE.md`; those stay the source of rules.
- No cross-project global memory in the MVP — the namespace is the workspace.
- No learning from conversations without verification.
- Vector search is not mandatory; FTS5 carries the MVP.
- No custom UI.

**Privacy and safety.** The index is local; the main package never touches the network. The optional embeddings package downloads the local model weights on first use and then works offline; cloud providers are opt-in and `DSH_MEMORY_NO_NETWORK=1` blocks egress/download. `*.env`,
`*secret*`, `*credential*`, `.git-credentials` and keys recognized **by shape** are
excluded from indexing: a PEM header at the start of a line
(`-----BEGIN … PRIVATE KEY-----`), `ghp_` + 36 characters, `sk-` + 48 characters,
`AKIA` + 16 uppercase characters. Bare marker mentions and a PEM header in the
middle of a description (README, spec, task cards) are not treated as secrets —
otherwise the project's own documentation would drop out of memory; a key in
inline code, a list, or a fenced block is still filtered out. `memory.search`
returns snippets only, and on error the plugin stays silent, letting the turn continue.

## Roadmap

| Phase | Scope | Acceptance |
| --- | --- | --- |
| 0 | plugin skeleton, `memory.search` / `memory.write`, SQLite FTS5, CLI `index` | index builds over docs, search finds the 3 known definitions |
| 1 | top-k injection, `memory.stats`, dedupe, stale by hash | hit-rate ≥ 20% on 20 queries, injection ≤ 600 tokens |
| 2 | draft/verified verification, triage presets, `AGENTS.md` rules | no verified record without a source, savings measured |
| 3 | index `.kanban` and decisions, TTL, `memory.invalidate` | stale records are never returned |
| 4 | lexical search, optional embeddings package, hard L2→L3 router, dashboard | −25% tokens on repeated questions without a quality drop |
| 5 | dispatcher and specialised submodels | proposal only, acceptance criteria to be defined |

## Status and repository layout

Phase 0 is complete: the plugin skeleton (package, bundle row, `apply`), the
SQLite store (schema, migrations, namespace, FTS5), the document indexer with
the `index` CLI, the `memory.search` / `memory.write` / `memory.verify` /
`memory.invalidate` / `memory.stats` tools, TTL and `metrics` events; `npm test`
runs 99 tests, including the phase 0 e2e "`index` → `search` finds three known
definitions" over the `test/fixtures/phase0` fixtures. Next: context injection
(010), `token-meter` metrics (011), the MVP benchmark (015). The detailed
internal specification is not published.

## License

MIT, © 2026 Victor Kozachek.
