# Provider Settings Local Branch Integration (2026-09-12)

> Full history: `git show 45f808f7:docs/working-memory/provider-refactor/research/provider-settings-merge-20260912.md`

## Scope and Rulings

- Current branch baseline: `5bf148568d`; source `provider-settings-todos` fixed at `d3b8b937b1`.
- The source's independent three commits were not in existing remote references. The original branch is used by another workspace and kept as-is; the real merge was performed on the organized `provider-settings-todos-renumbered` copy, without rewriting shared staging history.
- Source Todo133 → Todo137 (Start Plan GLM-5.3 hide visual marker), Todo134 → Todo138 (empty model drafts and reasoning fallback). Filenames, titles, indices, cross-references, and test descriptions synchronized; the current branch's original Todo133-136 unchanged.
- The three organized commits are `6f8505bf81`, `ee416e47ef`, `2c86f975a8` (sources `1a6a9dcc76`, `284d6a2ba0`, `d3b8b937b1`); differences before/after organization are only numbers and references.
- Retained the source's already-merged staging Composer recent mode fix: the Renderer only holds drafts and recently accepted input preferences, not changing CLI queues, model selection persistence authority, or desktop continuous/mobile replayable boundaries.

## Merge Intersection

- Index conflicts: retained 135, 136, 137, 138 simultaneously; corrected 135's outdated "pending implementation" status.
- Built-in: both sides independently rose from 22 to 23 with differing configurations; the merge result rose to 24, retaining Turbo disabled by default for ordinary APIs plus Model generic disabled/enabled and API enabled → high mappings. No schema or data migration; no online config published.
- Model editors: kept the current branch's simplified/advanced layouts, hidden fields, and Personal override mechanisms, integrating the source's empty-ID non-prefill of reasoning tiers.
- Header fixes retained; Todo136 still pending implementation; signature scope not expanded this round.

## Verification

- 12 related UI/Provider/Desktop helper unit test files, 284 items passing; Adapter new-model wire and Header merge tests, 66 items passing (350 total). Logs: `/tmp/provider-settings-merge-tests.log`, `/tmp/provider-settings-merge-wire.log`.
- Settings page browser batch 24 items passing (390/Chinese/Light, 1200/English/Dark), covering Start visual markers, empty ID tiers, restore/cancel, advanced collapse, hidden field saves, and Personal overrides; isolated transports and local Chromium, no real user data or model requests; log `/tmp/provider-settings-merge-browser.log`.
- Root `pnpm typecheck`, desktop `typecheck:e2e` pass; `pnpm lint` 0 errors / 42 pre-existing warnings; architecture check 0 violations. Logs at `/tmp/provider-settings-merge-{types,e2e-types,lint,architecture}.log`.
- Composer recent mode's pending E2E fixture verification passed without promotion; complete Electron/mobile shared-host/Pro real-device tests were not run this round. Behavior-level unit tests cover post-acceptance preferences, rejection/late ACKs, historical and workspace isolation, and cannot claim native multi-platform acceptance.
- Per-file normalization comparisons before/after organization passed: content consistent except numbers and references. No unresolved conflicts, duplicate link references, or production residual imports of deleted modules.
- Bidirectional re-review: the source's Start visual markers, empty drafts, API mappings, and Composer recent mode all retained; the current branch's Header assembly, Turbo disabled, edit layouts, and hidden field boundaries all retained. The only extra product file adjustment is the merged config revision to 24; Todo136 unimplemented.
- State owners remain the existing UI Draft/Recent and Provider config parsing chains; no new sync, queue, or cross-layer interfaces. Merge adds ~1,320 lines, deletes 296 (including docs and tests); organized copies are mechanical number changes only. No expanding fixes for unrelated pre-existing issues; no automatic pushes.
