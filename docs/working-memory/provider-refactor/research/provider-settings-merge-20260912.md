# Provider Settings Local Branch Integration (2026-09-12)

## Scope and Rulings

- Current branch baseline: `5bf148568d`; source `provider-settings-todos` fixed at `d3b8b937b1`.
- The source's independent three commits were not found in existing remote references. The original branch is used by another workspace, kept as-is; perform a real merge after organizing the `provider-settings-todos-renumbered` copy, without rewriting shared staging history.
- Source Todo133 → Todo137 (Start Plan GLM-5.3 hide visual marker), Todo134 → Todo138 (empty model drafts and reasoning fallback). Synchronize filenames, titles, indices, cross-references, and test descriptions; current branch's original Todo133-136 unchanged.
- The three organized commits are `6f8505bf81`, `ee416e47ef`, `2c86f975a8`; corresponding sources `1a6a9dcc76`, `284d6a2ba0`, `d3b8b937b1`. Commit titles include new numbers, Source-Commit trailers preserve source tracking; differences before and after organization are only numbers and corresponding references.
- Normally retain the source's already-merged staging Composer recent mode fix: Renderer only holds drafts and recently accepted input preferences, not changing CLI queues, model selection persistence authority, or desktop continuous/mobile replayable boundaries.

## Merge Intersection

- Index conflicts: retain 135, 136, 137, 138 simultaneously; conveniently correct 135's outdated "pending implementation" status.
- Built-in: both sides independently rose from 22 to 23, but configurations differ. Merge result must rise to 24; simultaneously retain Turbo disabled by default for both ordinary APIs, plus Model generic disabled/enabled and API enabled → high mappings. No schema or data migration, and no online config published.
- Model editors: retain the current branch's simplified/advanced layouts, hidden fields, and Personal override mechanisms, while integrating the source's empty ID non-pre-filling of reasoning tiers. Re-review shared draft entries and auto-merge browser fixtures/cases.
- Header fixes retained; Todo136 still pending implementation, signature scope not expanded this round.

## Verification

- Merged version's 12 related UI/Provider/Desktop helper unit test files, 284 items passing; Adapter's new model wire and Header merge tests, 66 items passing, totaling 350 items. Logs: `/tmp/provider-settings-merge-tests.log`, `/tmp/provider-settings-merge-wire.log`.
- Settings page browser batch: 24 items passing: 390/Chinese/Light, 1200/English/Dark, including Start visual markers, empty ID tiers, restore/cancel, advanced collapse, hidden field saves, and Personal overrides. Uses isolated transports and local Chromium runtimes, no real user data or model requests; log `/tmp/provider-settings-merge-browser.log`.
- Root `pnpm typecheck`, desktop `typecheck:e2e` pass; `pnpm lint` 0 errors, 42 pre-existing warnings; architecture check 0 violations. Logs at `/tmp/provider-settings-merge-{types,e2e-types,lint,architecture}.log`.
- Composer recent mode's pending E2E fixture verification passed without promotion; this round did not run complete Electron/mobile shared-host/Pro joint real-device tests. Behavior-level unit tests cover post-acceptance preferences, rejection/late ACKs, historical and workspace isolation, and cannot be used to claim native multi-platform acceptance completion.
- Three organized pre/post per-file normalization comparisons passed: content consistent except for numbers and references; source staging commits preserve original history. No unresolved conflicts, old duplicate link references, or deleted module production residual imports.
- Bidirectional re-review: source's Start visual markers, empty drafts, API mappings, and Composer recent all retained; current branch's Header assembly, Turbo disabled, edit layouts, and hidden field boundaries all retained. The only extra product file adjustment is the merged config revision to 24; unimplemented Todo136.
- State owners remain existing UI Draft/Recent and Provider config parsing chains; no new sync, queue, or cross-layer interfaces. Merge adds approximately 1,320 lines, deletes 296 lines (including docs and tests) relative to current baseline; organized copies are only mechanical number changes. No expanding fixes for unrelated pre-existing issues, no automatic pushes.
