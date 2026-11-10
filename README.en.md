# dsh-memory

Long-term project memory and a token cascade for DeepSeek Harness agents.

**Русская версия:** [README.md](README.md)

> **Status: phase 0 complete.** The plugin skeleton, the SQLite store, the document
> indexer with the `index` CLI and the `memory.*` modules
> (`search`/`write`/`verify`/`invalidate`/`stats`) with TTL and metrics are
> working; the "`index` → `search` finds three definitions" e2e is green.
> Context injection, the L2/L3 cascade and the benchmark come next on the board
> ([PLAN.md](PLAN.md)).

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
dsh plugin --profile web add <path to the package>   # then restart DSH Web
```

- nothing to configure: memory is local (SQLite FTS5), no network, no API keys;
- `dsh-memory index` indexes the markdown documentation manually (incrementally,
  filtering secrets out);
- planned later (outside phase 0): `dsh-memory doctor` (DB path, namespace,
  files/chunks, skipped secrets), `dsh-memory index --dry-run`, and background
  auto-indexing on the first turn, disabled by `DSH_MEMORY_AUTOINDEX=off`;
- vectors are not part of the main package: an optional `dsh-memory-embeddings` package
  (later) owns the provider or local model.

### First query

```bash
# 1. Index the workspace markdown documentation (the package CLI).
#    --json prints the report: files / indexed / chunks / skipped / secrets.
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
`draft` with provenance and becomes `verified` only after a review/test PASS or
explicit human confirmation. Otherwise one hallucination enters the index and is
then served to every future session *cheaper than it would have cost to verify*.

## Memory (RAG)

| Aspect | Design |
| --- | --- |
| Storage | SQLite at `~/.dsh/memory/<namespace>.db`: `sources`, `entries`, `entries_fts`, `metrics` |
| Namespace | one per workspace; the MVP has no cross-project memory |
| Kinds | `doc`, `decision`, `fact`, `answer`, `code-note` |
| Statuses | `draft`, `verified`, `stale` — stale is never returned |
| Provenance | every entry carries `source_path`, `source_ref`, author, timestamps |
| Dedupe | `hash = sha256(kind\|title\|text)` is UNIQUE; a match raises confidence and merges sources |
| Invalidation | source sha256 changed or file deleted → dependent entries go `stale` |
| TTL | `decision` 180 days, `fact` 60 days, `answer` 30 days |

## Tools

| Tool | Purpose | Input → output |
| --- | --- | --- |
| `memory.search` | find relevant knowledge | `{ query, k?, kinds?, status?, namespace? }` → `[{ id, title, snippet, source_path, source_ref, status, confidence, score }]` |
| `memory.write` | store distilled knowledge | `{ text, title, kind, sources[], confidence?, status? }` → `{ id, deduped, status }` |
| `memory.invalidate` | mark dependent entries stale | `{ path?, ref? }` → `{ affected }` |
| `memory.verify` | promote a draft to verified | `{ id, verified_by }` → `{ id, status: "verified" }` |
| `memory.stats` | usage and savings | `{}` → `{ entries, by_status, hit_rate, injected_tokens, tokens_saved_estimate }` |

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

## Dispatcher and specialised submodels (proposal)

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
dispatcher change. Proposal only, after the MVP. Risks: latency, coordination
cost, routing errors, conflicting answers, prompt and role versioning.

## Configuration

The `dsh-memory` block in `~/.dsh/cordis.patch.yml`; defaults and environment
parsing live in `lib/config.js`, and the row config and `DSH_MEMORY_*` override them.

```yaml
dsh-memory:
  namespace: auto
  db_path: ~/.dsh/memory
  inject: { enabled: true, top_k: 3, token_budget: 600 }
  search: { default_status: verified, snippet_chars: 300 }
  index:
    include: ["**/*.md"]
    exclude: [".git/**", "node_modules/**", "target/**", "dist/**", "tmp/**", ".cache/**"]
    max_chunk_tokens: 800
  embeddings: { enabled: false, model: "" }
  verify: { require_source_for_verified: true }
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

**Privacy and safety.** The index is local and by default the plugin never touches the network (vectors live only in the optional package); `*.env`,
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
