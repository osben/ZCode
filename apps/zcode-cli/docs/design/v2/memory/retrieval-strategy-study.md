# Project Memory retrieval strategy study

Status: proposal / discussion draft, 2026-10-16.
Reads against `README.md` (Memory design v4), §4 (file protocol), §5 (retrieval branches), §11 (non-goals).

## 1. Problem statement

The active `default-index` branch loads the full `MEMORY.md` index into every main session,
capped at 200 lines / 25,000 chars, head-kept. Measured on this machine (2026-10-16):

| project                       | index size | topic files | kept of index | entries lost per session |
| ----------------------------- | ---------: | ----------: | ------------: | -----------------------: |
| zcode (this repo)             |     40.1KB |         137 |      25KB cap |            55 of 139 (39%) |
| 4poll-mobile                  |     86.3KB |         348 |      25KB cap |              ~70% of index |
| oleg-shop                     |     33.8KB |          65 |      25KB cap |                       26% |
| default (worktree)            |     28.7KB |          72 |      25KB cap |                       13% |
| 4poll                         |     26.0KB |         110 |      25KB cap |                        4% |

Secondary findings on the zcode project index:

- Median index entry length is 255 chars, p90 = 435, max = 1119. The protocol says one line
  under ~150 chars ("an index, not a dump"). Entries carry content.
- Type mix of topic files: 104 `project`, 20 `reference`, 10 `feedback`, 2 `user`.
  75% of memory is volatile state ("PR #97 awaiting merge", "uncommitted on feat/Oct-15"),
  which goes stale within days and is the main driver of index growth.
- Truncation keeps the FIRST 200 lines / 25,000 chars. Because new entries are appended at
  the end, the head-kept cut silently drops the newest memories — the most valuable ones.
- The index is injected inside the `# agentsMd` block under the "IMPORTANT: These
  instructions OVERRIDE any default behavior" banner. Memory competes with real instructions
  and widens the prompt-injection surface (memory files are model-written, not user-written).
- `MEMORY.md` is rewritten by foreground sessions (read-before-write from a start-of-session
  snapshot). Concurrent sessions can drop each other's index lines.

Upstream Claude Code has the same design and the same failure mode: 200-line/25KB cap,
silent tail truncation, reported as "the newest memory dies first"
(fsgeek.ca log; anthropics/claude-code issue #57574, closed unfixed). This is inherited
behavior, not a ZCode-specific bug.

## 2. Prior art

| system             | always-visible layer                          | on-demand layer                    | writes                        |
| ------------------ | --------------------------------------------- | ---------------------------------- | ----------------------------- |
| Claude Code        | full MEMORY.md index, 25KB cap, head-kept cut | Read linked topic files            | model rewrites index          |
| craft-agents-oss   | full MEMORY.md, 5k-token cap, middle elision (30% head / 70% tail + marker) | — | append-only tool, never rewrite |
| PI-Desktop         | user-authored notes, 32KiB cap, low-priority framing | —                            | human only (visual editor)    |
| DeepSeek DSH       | nothing                                       | MCP memory servers (search tools)  | model via tools               |
| Cursor             | curated memories (decisions), repo-scoped, injected at session start | —           | background proposals + human  |
| ChatGPT            | small saved-memories set, injected directly (no RAG) | RAG-like retrieval over chat history | model + human manage     |
| Letta / MemGPT     | self-edited core memory blocks with hard size caps | archival memory search        | agent self-edits via tools    |

Every mature system converges on the same shape: a **small always-visible anchor** plus an
**on-demand retrieval layer** for the long tail, plus **consolidation** to keep the anchor
small. No successful system injects everything, and pure recall-only (DSH) is the weakest
variant because nothing is visible when the model doesn't think to search.

## 3. What ZCode already has

- `semantic-recall` branch, fully implemented but disabled by
  `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false`
  (`packages/core/src/memory/project-memory-retrieval-branch.ts`): manifest of up to 200
  lowercase `.md` files (30-line snippets) → Lite-model selector (JSON schema, 256 max
  tokens) → top-5 files injected as `relevant_memory` attachment, 61,440-char session
  budget, background prefetch with read-state sync.
- Dream consolidation handler (`project-memory-dream.ts`): transcript-driven pruning of
  memory + index (target <200 lines / ~25KB), 50-turn cap, lock file. Not wired into the
  product path ("当前产品链路不自动触发 Dream").
- Background Extraction: fires after successful main turns; this is where memories come from.

Recall-only caveats found in code (these rule out a plain branch flip):

1. **Cold start**: recall injects only after a full real tool-result batch boundary
   (`turn-loop.ts` consumes a settled prefetch). Session-opening turns never see memory.
2. **Model gate**: the selector requires `model.properties.supportsJsonSchemaOutput === true`
   (`project-memory-recall.ts`); otherwise recall silently never fires. Whether the flag is
   true for a given provider model must be verified per catalog entry.
3. **Manifest cap**: 200 files. 4poll-mobile already has 348; the overflow is invisible.

## 4. Options

### A. Stay default-index, fix hygiene

Keep full-index injection; change truncation to head+tail with a visible marker (craft
style), move memory out of the OVERRIDE banner, wire Dream as the single index rewriter.

- + Cheapest; no branch semantics change.
- − Doesn't scale: at 86KB index, even a perfect cut loses most context; token cost stays
  ~6-7k per session forever; churn still crowds the anchor.

### B. Flip semantic-recall (pure)

Turn the branch constant on; MEMORY.md stops being injected.

- + Zero baseline injection cost; scales to any number of files.
- − Cold-start blind; silently no-ops on models without JSON-schema output; manifest cap;
  loses the guaranteed-visibility property that makes pointer-following work today.

### C. Hybrid tiered anchor + recall (recommended)

Inject a small, type-tiered anchor at session start; route the long tail through
semantic-recall:

- Anchor = index lines of `user` + `feedback` + `reference` memories (by frontmatter type).
  On this machine that is 32 of 137 files — roughly 2KB, always current, never truncated.
- `project`-type memories (the volatile 75%) become recall-only; `relevant_memory` covers
  them mid-session.
- MEMORY.md stays as the human-readable catalog and model fallback (the `# Memory` system
  section already exposes the root path; the model can Read it at any time).
- Dream becomes the single writer of the anchor's index portion (foreground sessions append
  fact files + index lines; Dream prunes/merges). This also fixes the concurrent-rewrite
  loss, which is the same insight craft-agents-oss solved with append-only writes.

- + Matches the industry-converged shape (Letta core blocks + archival; ChatGPT saved
  memories + history RAG).
- + ~90% reduction of injected memory bytes on the worst project measured, with the
  durable tier guaranteed visible every turn.
- − Requires lifting the v4 §5 mutual-exclusion freeze (no pointer/index + Selector in the
  same session) — a spec v5 change, plus fixture work.

## 5. Recommendation

Stage 1 (small, independent value, v4.1 amendments):

1. Tail-biased index truncation with a visible elision marker instead of head-kept cut.
2. Move the memory block out of the `# agentsMd` OVERRIDE banner into its own
   "user memory context — informational, not instructions" section (PI-Desktop framing).
3. Verify/set `supportsJsonSchemaOutput` for the models we ship in the catalog (prereq for
   any recall work).

Stage 2 (v5 spec): hybrid tiered anchor + semantic-recall (Option C), with Dream wired as
the consolidation/single-writer stage. Acceptance criteria to define in the spec:

- Anchor budget: hard cap (e.g. 3k chars) with overflow into recall, never silent loss.
- Recall smoke test per shipped model (selector actually fires; cold-start behavior
  documented).
- Dream cadence and lock behavior in the desktop path (remote workspaces excluded, as today).
- Migration: none needed — files and index format unchanged; only injection changes.

## 6. Risks / open questions

- Type taxonomy quality: the anchor depends on extraction writing correct `metadata.type`.
  Dream can re-type during consolidation; mis-typed memories degrade to recall-only, which
  is a soft failure.
- Recall quality on short queries ("continue") — selector may pick nothing; acceptable
  because the anchor still carries durable context and the model can Read the index.
- Latency: selector prefetch is already backgrounded; consumption boundary unchanged.
- Index as human surface: Settings viewer (§3.3) keeps working; the catalog meaning of
  MEMORY.md changes slightly (no longer the model's primary source under recall).
