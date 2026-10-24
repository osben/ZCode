# Todo 78: Consolidated Closeout of Provider-Related Desktop E2E Debt

> Status (2026-09-09): this verification Todo is closed; remaining items are owned solely by [Todo102](todo-102-verification-debt-closeout.md). The statuses and failures below are historical; closing does not mean the original failures passed.

> Status: done (executable regressions closed on the Air; off-peak keeps an explicit fixture/Account entitlement block)
>
> Date: 2026-09-04
>
> Environment: the MacBook Air's independent clean worktree `/Users/dev/Desktop/projects/z-code-e2e`; all later Provider/Desktop E2E ran on that machine for the time being. Baseline: the commit under test synced to that worktree, not the Air's old `z-code` directory.

## 1. Purpose

Consolidate the "pending Mac run" items scattered across Todo 34, 40, 62, 73, 75, 77 and the off-peak Todos. Only this list judges E2E debt; old Todos are not re-scheduled. This Todo covers real Desktop graphical E2E runs, failure diagnosis and necessary fixes; it does not reopen core Provider/Conversation E2E that already has passing evidence, and static typecheck, fixture check or a successful build is not graphical E2E evidence.

## 2. Failures found and resolution

| Case | Initial result | Phenomenon | Final state |
| --- | --- | --- | --- |
| `MP-UI-06` model settings reasoning levels and Mapping | fail | test expected English "Model capabilities" but the run language was Chinese ("模型能力") | stale language/model-row/capability-count/default assertions cleaned up in `settings-ui-polish.test.ts`; passes (7 passing, 1 skipped); no product code change |
| `QR-E2E-09` first opportunity reminder | fail | no opportunity badge, reminder or request | fixture/preparation fix (select BigModel Coding Plan via the Composer model control and reload the Renderer); passes |
| `QR-E2E-10` urgent opportunity reminder | fail | no urgent reminder or request | the urgent mock now provides a future 120 seconds per status response (a fixed-start 179-second opportunity expired during Electron restart/build); passes. `coding-plan-team-usage.test.ts` 18/18 then 19/19 with CTP-02B |
| `off-peak-automations-home-layout` | fail | off-peak create entry did not appear | blocked, see below |
| `off-peak-create-manage` (2 cases) | fail | entry missing; the second had not switched to the expected workspace | blocked, see below |
| `off-peak-limit-pre-gate` | fail | create entry did not appear | blocked, see below |
| `SE-01` Subagent create/edit persistence | fail | generated Subagent Markdown differed from form content | test used the old `model`/`thoughtLevel` Markdown snapshot; updated to the current `modelSelection` serialization contract and the wrong `skipProvider` precondition removed; passes |
| `SE-02` Subagent default effort | fail | default effort written to `agents-state.json` without user action | old expectation was opposite to the current design: switching the model materializes that model's catalog default reasoning (`max` observed); test now verifies this; passes |
| `SE-03` delete selected model | fail | Markdown mismatch; delete entry not found | test locator and old assertion (the model row is a `data-testid` text element; the delete helper reads text content and input value); after deleting, the Subagent keeps the historical model text and does not restore a candidate; passes. `settings-subagent-create-edit-persistence.test.ts` 3/3 |

The original 30 pass / 10 fail / 1 skip tally predates the migration and is not the current baseline.

Other results (2026-09-05 on the Air): Repo Wiki settings and generation, both specs pass; CTP-02B independently confirms the sidebar avatar shows the confirmed Team Plan badge (`团队`), covering Todo 73's graphical requirement (`desktop-e2e-20260905-051133-051`, 19/19).

### Off-peak block (explicit, unresolved)

Runtime evidence from the Air's first-round log: at Host start the Registry contained two hidden Off-Peak Providers, but the account-connection snapshot marked them and all other account Providers `entitled:false`; `resolveOffPeakClientConfig` still requires the projected Registry to have a usable model in mock mode, and the mock replaces only exposure/plan state, not Account entitlement. The missing entry sits at the Account Provider availability layer, before ticket availability or the task business chain. To continue, an independent Coding Plan entitlement fixture / availability mock is required; the off-peak UI assertions and production model-selection logic must not simply be changed.

## 3. Scope consolidated from older Todos

- Closed: Todo 34 (three Repo Wiki E2E pass); Todo 40 (Provider upgrade, main Coding Plan quota scenarios, Automation create/manage pass; QR-E2E-09/10 now pass too); Todo 62, 75, 77 (model settings, Template create and reasoning levels covered by `settings-ui-polish.test.ts`); Todo 73 (CTP-02B); Subagent settings persistence (SE-01 to SE-03).
- Remaining environment block: Todo 09 and off-peak-related closeouts (three specs never reach business assertions because the entry gray-release/mock is not hit).
- The 45 Provider/Conversation macOS run evidences previously recorded in Todo 57 stay valid; real SSH Remote Cases stay blocked for lack of credentials and are not forged as passing.

## 4. Execution order and acceptance

Order: test preconditions and language assertions that do not touch product semantics first; then QR and off-peak mock/gray-release data (test preparation vs changed product display condition); then Subagent persistence and Todo 73 sidebar results (change production code only with clear evidence); after each group check the failure really reached business assertions and introduced no new Provider/Selection branch; finally rerun all listed cases in the Air worktree and record pass / fail / skip / environment block.

Acceptance: each case has an independent MacBook Air WDIO result or a recorded precondition block; test failures, unmet test preconditions and environment blocks are recorded separately; assertions are never turned green by changing Provider, Registry, Overlay or model-selection semantics; interaction-code changes come with Desktop E2E plus affected unit tests, `pnpm typecheck` and `pnpm lint`; old Todos' "pending Mac run" wording points here.

Execution conditions (2026-09-04): the code workspace was Linux; formal Desktop E2E used the Air's independent worktree; Linux static checks are not graphical evidence; real SSH Remote stays per Todo 57's credential block.
