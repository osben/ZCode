# Todo 73: Sidebar Account Plan Badge: Decouple Personal and Team Entitlement

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Sidebar graphical E2E debt is consolidated in Todo 78; this Todo keeps the feature implementation and unit-test record.

> Status: done (related unit tests, typecheck and lint pass; desktop graphical E2E to be rerun on a Mac).
>
> Source: 2026-09-03 MacBook Air feedback; the personal-tier / Team badge next to the username at bottom left disappeared.
>
> Relation: Provider Account Access consumer closeout; independent of the implementation of Todo 68-72.

## 1. Confirmed problem and evidence

The badge component still exists; the designer branch `fix/model-settings-ui-polish` did not remove it, and it is not a CSS problem.

The Air's `~/.zcode/v2/logs/2026-09-03.log` at 15:51:36.836 recorded account sync results: `account:bigmodel-individual-coding-plan.access.entitled = false`; `account:bigmodel-team-coding-plan.access.entitled = true`. The Team quota query succeeded at the same time, so the account does have Team entitlement; the missing badge cannot be read as "no plan". Evidence is logs and code only; no post-fix Air verification and no CDP snapshot of the component's in-memory state were obtained.

`WorkspaceSidebarFooterUsageSummary.tsx` called `resolveEntitledAccountProviderAccessFingerprint()` with the Individual Provider and used that fingerprint as the enabled precondition of `useEnterpriseCodingPlanProducts()`. With no personal entitlement it returns an empty string, which disables the Team query; `subscribedTeamProducts` is then empty and the avatar badge returns null. Z.ai has the symmetric problem.

```text
no personal plan entitlement -> Individual fingerprint empty
-> Team pricing query disabled -> Team badge data empty, even with Team Provider.entitled = true
```

The personal query gate was kept historically; the Provider refactor split personal/Team identity without decoupling it, and `bec05c983c` tightened the read interface to entitled semantics, so the wrong dependency persists. `resolveEntitledAccountProviderAccess()` must not be loosened; the caller should read the right product's facts.

## 2. Behavior and state ownership

```text
current account Family + Ready ProviderSettingsView
  +--> Individual access.entitled + personal-tier query --> personal tier badge
  `--> Team access.entitled ------------------------------> Team badge candidate
Display priority: a confirmed personal tier wins; otherwise Team per the existing loading rule; neither shows nothing.
```

- The Team badge consumes the same Family's Team Provider `effectiveConfig.access.entitled` directly: no personal plan required, no currently-selected Team, no executable model, no API Key, and pricing success is not a precondition of Team account identity.
- The personal tier keeps using the existing personal entitlement snapshot and tier formatting; no new tier inference or replacement copy.
- Keep the existing priority protection while the personal query loads; a not-Ready or failed read is not "confirmed no entitlement".
- Current account Family isolation is unchanged; switching Family, logout and entitlement refresh re-derive the badge; another Family's stale Team state is never shown.
- The badge is display only: no write back to the Account Overlay, no change to model selection / credentials / quota, no new persisted state or polling.
- Team pricing still owns organization, project, price and upgrade-entry info; do not delete all related queries just because the avatar no longer depends on it.

## 3. Impact brief

Mode: planning; layers: presentation / validation. Scope: the account plan badge and the shared hook's necessary adjustment.

| Entry / priority                        | Shared implementation and data                                                                  | Boundary                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Avatar badge, must-inspect              | `WorkspaceSidebarFooter` -> `useWorkspaceSidebarFooterUsageSummaryState` -> `resolveSidebarFooterProfilePlanBadge` | read personal/Team facts independently; keep styles and i18n                |
| Footer quota and upgrade, must-inspect  | same UsageSummary hook, `teamSources`, `currentUsageSource`                                     | Team query independent of personal entitlement; org/project sources do not degrade to personal |
| Provider Settings plan cards, should-inspect | Account Access helper, enterprise pricing hook                                             | keep current behavior; do not loosen the helper globally                          |
| Desktop / Web / mobile / remote, invariant-only | existing hooks, service injection and Family boundary                                    | reuse the current account fact source; no new runtime or direct platform API; continuous/replayable chains untouched |

The authoritative fact comes from the account service, projected through Account Overlay / ProviderSettingsView; tier and price keep their own services and caches. The badge has no Composer draft, default-model inheritance, submit command or persistence point. Entries share data but not all display conditions.

Existing test `packages/ui/test/workspaceSidebarFooterWebRemoteControlTooltip.test.ts` covers the badge rules but cannot replace a component/hook regression for "with Team entitlement only, upstream really feeds Team facts".

Graph drift / proposed delta: `capability.plan-entitlements` should add the Footer badge entry and the invariant that Team does not depend on Individual (the graph file was being modified by another task, to be updated in the same direction with a graph integrity check at implementation). The related fact doc `docs/usage-stats-app-coding-plan-split.md` has old Provider ID / enabled / apiKey descriptions that are not the current contract; do not restore the old design, and this Todo does not rewrite that doc.

## 4. Execution checklist (as written; items unchecked in the source)

- Regression first: in a real-shaped ProviderSettingsView with personal false / Team true, mount the Footer and assert the Team badge appears.
- Read personal and Team Account Access of the same Family separately; fix the badge input and the Team query gate; remove misleading variables/comments.
- Check memo dependencies such as `teamSources`: reading Team Access must subscribe to Team fact changes, not only Individual Access.
- Keep the pricing query needed for quota/upgrade entries; subscribed Team projects build without personal entitlement, with no duplicate query.
- Update related spec/graph and tests to state that Account identity, tier and project price are different facts; no new state model.
- Add an interaction E2E; run affected unit tests, `pnpm typecheck`, `pnpm lint`; verify on the MacBook Air and record commit SHA, screenshot and desensitized logs.

## 5. Acceptance cases

Dimensions: Family, personal/Team entitlement, loading/refresh state only.

| Case  | Setup and action                                                    | Expected and evidence                                                                 |
| ----- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 73-01 | BigModel personal false, Team true; cold-start sidebar              | shows Team; component/hook regression + E2E + Air                                     |
| 73-02 | Z.ai with Team entitlement only                                     | shows Team; component/hook regression                                                 |
| 73-03 | personal tier present, with and without Team entitlement            | personal tier wins in both; existing-rule regression                                  |
| 73-04 | neither entitlement, or Start Plan only                             | no forged personal tier / Team; unit test                                             |
| 73-05 | switch from a Team Family to another Family without entitlement, or log out | no stale Team badge; component test                                           |
| 73-06 | personal query loading, Provider View not Ready/failed then recovers; Team entitlement changes alone | unknown is not "confirmed none"; shows the latest facts after recovery without a full page refresh |
| 73-07 | Team only, open Footer quota/upgrade entry; pricing fails           | on success keeps the right org/project; on failure existing error handling without erasing the confirmed Team identity |

Pruned: no model request, no provider replay fixture; no Session/Submission change and no conversation state-space expansion. E2E controls entitlement responses on the existing account/Provider fixture and waits on observable state, no fixed sleep. Light/dark, zh/en and narrow screen get representative checks without redesigning the badge visuals. Remote scenarios keep existing account-source isolation. Cases, coverage and E2E status were planned, archived per e2e-case-lifecycle at implementation; this log investigation is not fix-verification. No open user ruling.
