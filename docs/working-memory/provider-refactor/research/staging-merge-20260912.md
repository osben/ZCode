# Provider Branch Merge into staging: 2026-09-12

> Full history: `git show f85b156c:docs/working-memory/provider-refactor/research/staging-merge-20260912.md`

## Targets and Boundaries

- Current branch `provider-stabilization-20260911`, pre-merge at `2fece1a06e`; pinned source `origin/staging` at `75021ca5b5` (8 new commits).
- Normal merges preserve both-side histories, no source remapping, no file-level ours/theirs; no application or online Provider configs published.
- Todo133/141 remain Draft; do not conveniently modify request security verification, account syncing, database migrations, running models, or phone recovery protocols.

## Source Rulings and Bidirectional Re-review

| Source                                   | Behavior and Handling                                                                         | Intersection with This Branch and Conclusions                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `6de4b30fa6`                             | Crash archive parsing Crashpad annotations and V8 OOM summaries; fully retained               | Main diagnostic boundary, does not change Providers or Session states                                                     |
| `1a01204a8b`                             | Diff/code highlighting unified to use WASM engine; fully retained                             | Four Worker and main thread entry points consistent, does not modify model editors                                        |
| `c8b578f771`                             | Pop prompts when exceeding attachment counts; fully retained                                  | Shared with Composer for default selections, but attachment scopes and model/mode drafts are independently separate       |
| `ff0f3a5274`                             | macOS dev packages retain relative symbolic links, upgrade cache fingerprints; fully retained | Does not change production packages, model configs, or data directories                                                   |
| `df72056924`                             | Official MCP credential validity logs deduplicated by hourly buckets; fully retained          | Only affects diagnostics, does not change authentication and entitlement judgments or model request security verification |
| `75021ca5b5`, `eb71ba51c2`, `6121d8ba48` | Source merge commits; retain real history                                                     | File differences based on the above function groups, no duplicate porting                                                 |

No explicit conflicts, no same-file changes from both sides; source 20 files retained as-is. Reverse checks: this branch's Header/security verification, model editors, Start visual markers, reasoning empty drafts, first share default selections, and idle directory modifications all retained. `SessionPane`/`ConversationComposer` config submissions and share context_refs chains were not rewritten.

## MR Impact Surface Supplement (impact-only)

- Reverse review of the current branch diff via functional graph `codeSeeds` plus one-hop edges: hits model capabilities, Provider settings, share continuations, and model IO/historical reasoning nodes within the same runner files.
- must-inspect: Settings page → edit drafts → Personal configs; share results → independent Composer drafts → existing Submissions; Built-in → Registry → idle Views; execution environment Headers → Model Adapters → request security verification.
- should-inspect: shared model selectors, Registry execution validations, titles/connection testing, and other common model exits. Runtime inheritance, historical messages, queues, and Tickets add no alternative paths.
- Owners/landing points: edits stash as UI drafts, saves still land in Personal; shares only initialize recipient-side independent drafts, submissions only on sending; capabilities and model IDs still published by Registries. Phone shared-host and desktop continuous/replayable delivery semantics unchanged.
- File hits are not business dependencies: runners only pass defaultHeaders; do not claim modified historical reasoning recovery/Model IO based on this.
- Reconciliation differences: AGENTS visualization rules and Todo133/141 drafts are documentation only; other diffs are the above functions' supporting specs, i18n, unit tests/browser fixtures. staging's diagnostics/Diffs/attachments/packaging/MCP logs are retained integration items for this round, not extra MR differences relative to staging.
- No Codegraph in this environment; no automatic callers/impact queries executed; uses actual graph seeds, one-hop relations, precise call reads, and tests — not claiming automatic full scans.
- Graph drift: old ContextChip nodes/edges and some old provider field descriptions still need separate maintenance; this branch already updated share surface real seeds in Todo139. This merge does not expand the full graph.

## Verification

- Merged-candidate targeted unit tests: 12 files, 126 items passing, covering all source unit tests and Composer drafts/submissions/share references, idle directories, and MCS.
- `pnpm typecheck` passing; `pnpm lint` passing (42 pre-existing warnings, 0 errors); `pnpm architecture:check --changed` 0 violations before and after; `git diff --check` passing.
- Logs: `/tmp/staging-merge-20260912-{unit,typecheck,lint}.log`.
- Existing function verifications continue using actual evidence from Todo134/135/137/138 and `todos-136-139-140-review-20260912.md`, not written as this round's re-runs.
- This round did not run native Electron, real macOS/SSH/phones, or online model requests. Todo139's public share → native SessionPane → first RPC joint acceptance still retained; existing ox-alpha value range test baseline failures are not expanded, not written as fully green.

## Delivery

Submitted the real merge per the user's request via the zcode-mr workflow (push and MR to staging); MRs not auto-merged; no real user configs modified.

## Push Gate Findings and Test Closure

- Force pre-push full unit tests showed two failures. ox-alpha Responses tests still require individual disabling, conflicting with this branch's Todo138-routed general two-tier decision; only assertions were aligned and verification of enabled mappings to high supplemented, without modifying configs.
- Memory in-place overwrite cases reproduce stably on this file system: same inode, same-length adjacent writes may retain identical timestamps; fixtures do not ensure observable file version changes. Tests now set initial mtime to fixed old values before reads, then let in-place writes update naturally; real IO and service rejections are still verified — no sleeps, no mocking of final errors.
- Memory tests and production implementations are identical to origin/staging; this round only makes tests confirm ahead. The existing design limitation — content changes with the same identity/length/timestamps may go undetected by stat — still exists; do not claim fixed, do not expand to body hashes or lock mechanisms.
