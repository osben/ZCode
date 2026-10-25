# Conversation Session V4 E2E Migration

> Migration plan and ledger for the conversation-session E2E suite after the v4 refactor.
> Waves 1-5 completed 2026-07-11; case rewrites (Tasks 3-8 below) and non-Docker full-gate
> verification remain open.
> Full history: git show aac4755666d09fdcd70272fcf063c077a639015f:docs/superpowers/plans/2026-07-09-conversation-session-v4-e2e-migration.md

**Goal:** Retire old ChatView-helper assertions, rewrite still-valid product semantics
against v4 helpers, and keep the case catalog plus coverage matrix ahead of executable test
changes.

## Migration Contract

- `docs/conversation-session-case-catalog.md` is the product-semantics source of truth;
  `docs/testing/conversation-session-e2e-coverage-matrix.md` is the coverage ledger. Both are
  updated before creating, rewriting, or deleting any conversation-session E2E spec.
- Formal v4 E2E must use `packages/desktop/test/e2e/helpers/v4-conversation.ts` and
  `TID_V4_*` for root/composer/message/queue/action state, with case-local fixtures and
  deterministic replay. Specs calling `prepareConversationE2E()` or importing the old
  aggregate helper are migration corpus only (they live under `manual-review/pending`).
  Compatible tool/history/toolbar/summary-panel test ids and focused helper submodules may
  remain in V4 formal specs — do not use a blanket `TID_CHAT_*` ban as the gate check.
- A migrated case is either a v4 formal spec, a documented `manual-review/pending` item, or a
  documented product-semantics deletion. `manual-review/pending` specs are migration corpus
  or manual-review evidence, never "current V4 formal gate passed".
- Case-local fixtures only; no new shared `provider-basic` style fixtures. Missing helpers
  are added to the v4 helper layer first, not duplicated inside specs.
- Desktop `desktop-continuous` and mobile `web-remote-replayable` boundaries are preserved;
  replayable recovery is not asserted against the desktop continuous main chain unless the
  catalog says so.
- Promotion to the formal gate requires the coverage audit, typecheck, lint, focused replay,
  and Docker headless verification.

## Ledger Outcome (2026-07-11)

- Suite totals: 121 conversation-session specs — 29 formal, 92 `manual-review/pending`.
  Zero formal specs import the old aggregate helper or call `prepareConversationE2E()`.
- All 29 V4 formal specs passed the admission inspector: case manifest + case-local fixture
  = 29/29/29 (85 synthetic requests total: 75 `fast-text`, 10 `controlled-stream`, incl. 32
  title sidecars). Admission proves deterministic input only; it does not raise coverage
  status.
- 32 legacy formal specs were moved unchanged to `manual-review/pending`;
  `conversation-session-fork-merged-assistant.test.ts` stayed formal;
  `conversation-session-v4-load-older.test.ts` stayed formal with `selectV4TaskById`
  replacing its legacy import.
- Audit guard (`pnpm audit:conversation-session-coverage --check` plus a reusable formal
  admission inspector): legacy-helper usage and manifest/fixture/path/policy/synthetic-ledger
  gaps block admission. State after Task 4: 29 admitted / 0 rejected / 92 pending.
- CI/Docker paths (Task 5): macOS/Windows manual CI use the direct-root formal glob (old
  quarantine removed); Docker default smoke drops the old conversation paths;
  `conversation-session-verified` is explicitly unavailable without current V4 Docker
  evidence.
- Task 6 (run case-local/default replay, fixture check, coverage audit, typecheck, lint, and
  applicable non-Docker full gates; Docker risk tracked separately) is still pending.

## Evidence Flow

```text
catalog product semantics
  -> coverage matrix row status
  -> old formal / pending spec inventory
       +--> obsolete product behavior ----> catalog/matrix deletion note
       +--> still-valid behavior ---------> v4 helper rewrite
       +--> covered by newer v4 spec -----> matrix evidence merge
  -> focused replay fixture run
  -> desktop continuous gate evidence
  -> optional mobile replayable check where the catalog requires it
```

## P0 Formal Old-Helper Triage (historical baseline of 28, superseded by the 32-spec inventory)

| #   | Old formal spec                                                       | Action                                                                                                                                                |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `agent-step-message-scope`                                            | Rewrite as v4 formal with projection/timeline + provider request assertions; keep as turn-scoping guard.                                              |
| 2-7 | `ask-user-question-*` (custom click/enter/mixed, keyboard navigation) | Merge into v4 AskUserQuestion custom-answer and keyboard-navigation specs; keep manual-typing path (IME regressions) and click path as distinct rows. |
| 8   | `background`                                                          | Split: keep notification/queue/stop/goal semantics as smaller v4 specs + native projection tests; drop obsolete old-row rendering assertions.         |
| 9   | `bash-read-state`                                                     | Rewrite against v4 tool cards + filesystem evidence; keep formal.                                                                                     |
| 10  | `built-in-subagent-model-overrides`                                   | Rewrite as v4 send + child provider request inspection.                                                                                               |
| 11  | `composer-prefix-routing`                                             | Rewrite only uncovered `@`/`$`/subagent/skill routing; merge duplicated slash coverage.                                                               |
| 12  | `file-tools-atomic-write`                                             | Rewrite with filesystem mode assertions; provider fixture local.                                                                                      |
| 13  | `fork-merged-assistant`                                               | Keep formal; priority failing probe for `E10` until it passes with provider replay + handoff file evidence.                                           |
| 14  | `markdown-table-layout`                                               | Rewrite only v4 `MessageResponse` behaviors still present; move pure visual parity to UI component tests.                                             |
| 15  | `model-switch-image-strip`                                            | Rewrite with v4 composer/model controls + provider request verification.                                                                              |
| 16  | `native-file-picker-attachments`                                      | Rewrite with v4 composer attachment surfaces; desktop-only picker stays formal.                                                                       |
| 17  | `oversized-inline-image-attachment`                                   | Rewrite with v4 attachment validation; keep provider non-send assertion.                                                                              |
| 18  | `plan-approval-feedback-user-message`                                 | Rewrite with v4 plan approval dialog + user row assertion.                                                                                            |
| 19  | `plan-file-compact-continuity`                                        | Rewrite with v4 compact flow; desktop continuous compact must not adopt replayable gap recovery.                                                      |
| 20  | `plan-mode-capabilities`                                              | Split into runtime policy assertions + one v4 UI decline-flow spec.                                                                                   |
| 21  | `plan-mode-mcp-permission`                                            | Rewrite or move to native protocol test; keep permission dialog evidence only for the visible path.                                                   |
| 22  | `read-session-context-timeout`                                        | Prefer native runtime/protocol test + one v4 timeline completion assertion.                                                                           |
| 23  | `subagent-interaction-delegate`                                       | Rewrite against v4 interaction/permission dialogs; preserve owner/delegation semantics.                                                               |
| 24  | `subagent-prompt-assembly`                                            | Rewrite as v4 send/provider request evidence.                                                                                                         |
| 25  | `subagent-provider-registry-cold-start`                               | Rewrite with v4 send helper + registry evidence; keep cold-start isolation fixture.                                                                   |
| 26  | `title-generation-timeout`                                            | Rewrite with v4 title/sidebar evidence; generous timeout, deterministic fixture.                                                                      |
| 27  | `tool-error-surface`                                                  | Rewrite with v4 tool card selectors + sibling completion assertion.                                                                                   |
| 28  | `webfetch`                                                            | Rewrite with v4 tool card + provider/tool-result evidence.                                                                                            |

## Pending Old-Helper Batch Order

| Batch                | Count | Scope / decision                                                                          |
| -------------------- | ----: | ----------------------------------------------------------------------------------------- |
| main-queue-stop      |    11 | Triage first; merge into `conversation-session-v4-queue*` / `-stop-queue*` where covered. |
| compact              |     7 | Migrate after plan-mode P0 cases share helpers.                                           |
| goal                 |     6 | Migrate with the background split (goal verifier interacts with background work).         |
| fork-edit            |     3 | Handle `E10` failing fork case first, then port remaining rows.                           |
| model-provider       |    22 | Migrate after image-strip and subagent provider cases establish fixture patterns.         |
| tools-subagent-plan  |    21 | Migrate in small semantic groups; no giant resurrection PR.                               |
| composer-rendering   |     5 | Migrate only uncovered rows after the v4 composer/toolbar/table audit.                    |
| other                |     7 | Triage after the formal gate is clean.                                                    |
| multi-session-config |     1 | Keep pending until v4 multi-pane/session binding coverage is confirmed.                   |

## Open Tasks (3-8)

- Task 3: rewrite AskUserQuestion cases — catalog rows, v4 dialog helper selectors, two specs
  (custom answer persistence, keyboard navigation), focused replay.
- Task 4: split background/queue/stop/goal coverage by state owner; projection/native tests
  for state transitions, WDIO only for visible UI; record the delivery boundary per row.
- Task 5: rewrite tool/runtime/filesystem cases (`v4-tool*`, `v4-bash*`, `v4-webfetch`,
  `v4-file-tools*`) with stable tool-card selectors and on-disk mode/content assertions.
- Task 6: rewrite provider/model/subagent cases — one fixture per semantic row (no shared
  mutable state); WDIO only for user-visible delegation dialogs.
- Task 7: rewrite composer/attachment/markdown/plan/compact/fork/title cases; merge overlap
  with existing `v4-composer-toolbar`, `v4-fork*`, `v4-compact*`, `v4-permission*` specs;
  keep `E10` a visible failing probe until fixed.
- Task 8: promote and verify — coverage audit, typecheck, lint, focused E2E group, Docker
  headless gate before broad promotion.
