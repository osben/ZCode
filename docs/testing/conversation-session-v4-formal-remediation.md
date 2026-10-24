# V4 Conversation Formal Replay Remediation

## Background and evidence

The first desktop non-Docker replay (2026-07-11, run `task6-strict-20260711`) used a non-recursive formal glob and a strict provider pool: 29 formal specs, 29 workers, `manual-review/pending`: 0. Fixtures were `common.json` plus 29 case-local fixtures; `provider-basic` and tool-cross fallbacks were not loaded. Result: 34 tests, 20 passed, 14 failed (15 specs fully green, 14 with at least one failure).

The 14 failures are not downgraded to pending and are not fixed by raising timeouts, pinning English copy or restoring the legacy shared fixture. They remain formal contracts and are fixed by the root-cause groups below.

## Authority boundary

```text
CLI / V4 snapshot authority
          |
          v
canonical UI materialization
  ├─ row/marker semantic data attributes
  ├─ status-panel shell attributes
  ├─ one visible split-layout owner
  └─ row-count / render-unit-count separate units
          |
          v
formal E2E helpers
  └─ read stable ids/attributes and perform current user interaction
```

E2E must not treat old debug DOM, i18n copy, hidden child elements or an old localStorage owner as product authority.

## Failure groups and fix decisions

| Formal spec           | Direct failure                               | Root cause                                                                                                                                                                                    | Fix contract                                                                                                                                              |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v4-edit`             | edited reply never appears                   | E2E still typed newText into the main composer; the product requires inline Edit, inline input, inline Send                                                                                   | helper resolves the user rowId and uses `v4-edit-input/submit-${rowId}`; keep the strong rewind/rerun assertions                                          |
| `v4-fork-edit-branch` | edited reply never appears                   | same as `v4-edit`                                                                                                                                                                             | reuse the inline edit helper, then prove the fork child contains only the new branch                                                                      |
| `v4-compact`          | waits for `[compact]`                        | legacy debug-text oracle; the V4 marker status is `success`                                                                                                                                   | timeline row exposes marker type/status/origin; helper asserts structured attributes, never English/Chinese copy                                          |
| `v4-background-work`  | running item never appears                   | the unified status panel is `mini` in a narrow pane; items mount only in the expanded terminal/agent section; after cancel the running item must disappear                                    | read the panel shell typed running count first, then expand the section; after cancel assert ACK and item removal                                         |
| `v4-goal`             | legacy goal banner never appears             | goal moved to the unified status panel; the old banner/TID has no production reference                                                                                                        | panel shell exposes goal objective/status in both mini and expanded; helper reads pane-scoped                                                             |
| `v4-delete`           | delete TID missing                           | the WIP header slimming removed the UI entry and the SessionPane command wiring of the frozen protocol                                                                                        | restore a touch-accessible delete action; return to draft only after accepted/noop, not on failed                                                         |
| `v4-rename`           | rename input missing                         | same WIP slimming as delete                                                                                                                                                                   | restore the header rename input/submit and the `renameSession` ACK wiring                                                                                 |
| `v4-sidebar`          | rename input missing                         | same as rename                                                                                                                                                                                | after restoring the entry, keep verifying the sessions-index custom title and list convergence after delete                                               |
| `v4-load-older`       | expected 70 raw rows, got unit count 1       | `data-row-count` drifted from raw projection rows to turn render units; one turn with 70 blocks cannot prove pagination                                                                       | separate window / raw total / render unit / mounted unit; fixture uses multiple completed turns; anchor verified by turn unit                             |
| `v4-scroll`           | expected 50 raw rows, got unit count 1       | same as load-older; a single turn cannot form a stable long list                                                                                                                              | multi-turn history plus a controlled-stream new turn; counts in different units are never compared                                                        |
| `v4-split-persist`    | ratio not restored after refresh             | after a draft split is promoted to a group, a `paneLayout` shadow owner remained and the divider wrote the wrong store                                                                        | a successful promotion consumes the source layout; the group persists its own ratio; remote compact does not enable groups                                |
| `v4-split`            | pane revives after close                     | after group GC the fallback hit the uncleaned shadow split                                                                                                                                    | same ownership-transfer root fix as split-persist; after close only a single pane remains                                                                 |
| `v4-stop-queue` B08   | provider request failed                      | first send while the draft prewarm ACK is pending; the fallback session creation read the not-yet-hydrated `draftConfigRef`, lost provider/model/thought and fell to builtin / a real request | fallback merges, in order: synchronous initial config, user draft config, app followupMode; guarded by a pending-prewarm unit test and the B08 strict E2E |
| `v4-turn-navigator`   | `Browser.getWindowForTarget` unknown command | the WDIO/Electron window-rect API is incompatible with the current ChromeDriver                                                                                                               | reuse the cross-platform viewport helper; product turn-navigator semantics unchanged                                                                      |

## Visible projection and test attributes

- A V4 `timelineMarker` row root exposes `data-row-kind="timelineMarker"`, `data-marker-type`, `data-status`; compact also exposes `data-origin`.
- The unified status panel shell keeps the same semantic attributes in both `mini` and `panel` branches: goal status/objective and running background count. Expanded children only affect visible detail, not shell authority.
- The timeline exposes raw `windowRowCount`, raw `totalRowCount` and logical `renderUnitCount`; mounted units are counted by a separate turn-unit attribute. Raw row counts and turn-unit counts must not be compared.
- Entries and command ACKs for edit/retry/fork/delete/rename are verified through stable TIDs / command probes; the main composer draft and the inline edit draft are independent states.

## Split ownership

```text
draft / ungrouped split
  owner = paneLayout:v2
       |
       | second pane binds a normal session and promotion succeeds
       v
multi-session workbench group
  owner = workbench-groups:v1
  paneLayout:v2 = single primary (consumed source)
       |
       +-- divider ratio -> group.root
       +-- refresh -> group.root
       `-- close to one pane -> group GC -> ordinary single pane
```

`workspaceIdentity?.trim() || workspacePath` stays the group/session isolation key. This state exists only in the renderer-local desktop / ordinary Web workbench; mobile `/remote` (`web-remote-replayable`) never creates, restores or persists a group.

## Pagination and cold boundary

Multiple text blocks in one provider turn are not a stable persisted-history construction: live shows several raw segments while the cold transcript may merge them into one persisted text part. The load-older/scroll fixtures must build history from multiple real completed turns so live and cold share the same turn-unit semantics.

Separate bug candidate (open): if the raw-row tail is cut in the middle of a huge single turn, the UI unit key, the prepend anchor and automatic loadOlder when the viewport is not full need a small unit test; E2E must not hide it with manual fake scrolling.

## Acceptance order and pruning

- Accept: the 14 existing formal cases, fixing product semantics or test materialization.
- Do not add: Docker admission, mobile replayable E2E, a full status-panel visual cross-product, a cross-product of all window-manager APIs.
- Do not prune: edit rerun, rename/delete, split close/ratio, loadOlder, scroll, B08 and turn navigator all stay formal.
- Order: focused unit RED to GREEN per failure group, then the strict single-spec run, then the 29-spec strict batch and the default CI-style batch.
- Docker is not run this round; the desktop batch proves only `desktop-continuous` and does not claim `web-remote-replayable` mobile coverage.
- Formal CI runs the conversation admission audit first and uses strict case-local fixture mode. The summary must cover every expanded spec file (not just `tests.total > 0`), and no legacy replay fallback may mask a missing matcher.

## Outcome (2026-07-11)

All 14 first-round failing specs are green under the strict fixture pool, individually:

- `background-work`, `compact`, `delete`, `edit`, `fork-edit-branch`, `goal`, `rename`, `sidebar`: run `v4-ui-formals-strict-20260711-032153`, 8/8.
- `load-older`: `v4-load-older-strict-20260711`, 1/1 (25 turns, 75 raw rows, cold tail 60, prepend anchor pass).
- `scroll`: `v4-scroll-strict-20260711`, 1/1 (14 turns, controlled stream, no pull-back, return to bottom).
- `stop-queue`: `v4-stop-queue-strict-after-prewarm-fix-20260711`, 3/3 (includes B08).
- `turn-navigator`: `task6-turnnav-fix-final-20260711`, 1/1.
- `split`: `v4-split-strict-after-owner-fix-20260711`, 1/1.
- `split-persist`: `v4-split-persist-strict-dynamic-owner-20260711`, 1/1; also proves a dynamic single owner for the promoted group and the sidebar ordinary split.

Both full desktop non-Docker batches pass:

- Strict provider pool: `task6-strict-green-20260711`, 29 specs, 34/34 tests, 0 failed (only `common.json` plus 29 case-local fixtures).
- Default CI-style automatic fixture resolution: first run 33/34; the only failure was scroll waiting only for the render unit and reading 41/42 before the last turn's assistant/timeline rows were fully materialized. A full 3-row turn barrier fixed it: single-spec `v4-scroll-ci-barrier-fix-20260711` 1/1, full rerun `task6-ci-style-green-rerun-20260711` 29 specs, 34/34, 0 failed.

Review additions SWG10/SWG11 and formal CI strictness do not roll back the product contract: deleting a group primary must return to draft; `web-remote-replayable` must bypass group restore/create/persist/consume; CI must run admission audit, strict case-local fixtures and expected-spec file coverage. These are guarded by targeted UI tests and CI/config tests; mobile replayable is not passed off as desktop E2E evidence.
