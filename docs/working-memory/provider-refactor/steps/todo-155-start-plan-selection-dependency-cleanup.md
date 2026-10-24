# Todo155: Start connection dependency cleanup and model-switch plan badge

> Status: initial issue list, superseded by [Todo156](todo-156-start-plan-followup-final-decisions.md).
> The 2026-09-16 investigation history is kept but is not the current implementation scope; standing
> decisions, deferred team governance and final verification are in Todo156 (conflicts resolve to Todo156).
> Source: Air feedback after [Todo154](todo-154-start-plan-independent-provider.md), the connection-dependency
> audit and a model-switch hint screenshot. Baseline `f2b40bda8c`, branch `start-plan-independent-provider`.

## 1. Goal and state ownership

Start is an independent Provider and no longer needs the global "connection mode" to select Start. State
sources follow the owner of the displayed fact (not all switched mechanically to the input box):

| Scenario                              | Correct source                                              |
| ------------------------------------- | ----------------------------------------------------------- |
| Input-box quota; same-model plan recommendation at submit | effective Provider and model of the current input box/form |
| Session balance / error reminders     | the session's executing Provider, model and error facts     |
| Historical model-switch divider hint  | fromProvider/fromModel and toProvider/toModel in the record |
| Start availability; settings entitlement | current logged-in account's Start entitlement and model config |
| Settings personal/team connection; team usage scope | global paid connection and complete team identity |

```text
logged-in account -> Account Source -> Start entitlement / Registry
input effective Provider + model -> matching quota display / submit recommendation
session executing Provider + model -> session balance / business-error reminders
history switch record front/back identity -> historical plan-name display
global personal/team choice -> paid access context and team scope (not a gate for Start availability/display)
```

No new mutable state owner; original commit, cache and recovery contracts stay; desktop continuous vs
phone replayable boundaries stay.

## 2. Problems (T155-01..07)

- **T155-01 Input-box Start balance still needs a global Start connection**: `resolveV4ContextPlanConnection` in `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` returns none for both brands when Start is selected in the input and the global connection is personal/team/unset (only legacy start-plan returns Start). Fix: Start determined by the current effective Provider, not requiring a selection or kind start-plan; keep personal/team quota dependence on the real paid scope; check final visibility in `contextUsage.tsx` and the Start hover balance/refresh entry. The ring also carries context usage, so its presence is not the Start state.
- **T155-02 Legacy team info completion failure drags Start down**: chain `settingService.prepareLegacyAccountConnections` -> `node.ts` readAccountProviderSettings -> `accountProviderConnectionResolver.ts`; a legacy team missing organizationId with failed completion marks that brand's Start unknown (cold start with no successful snapshot may make Start unselectable). Fix: remove the whole-brand short circuit of `unresolvedFamilies` and query Start entitlement independently; keep the restriction on paid-team queries when team identity cannot be confirmed (no guessing organization/project, no migration). Not reproduced on Air and not the explanation of the earlier Air plan-expiry issue.
- **T155-03 Session balance / plan identity queries lack `accountAccess`**: `useV4SessionQuotaBanner.ts` (source = the session's executing Provider) and `usePlanIdentitySnapshot.ts` Start/paid queries; `useUsageEntitlement` forwards parameters verbatim and `BigModelUsageQuotaProvider` does not supply `accountAccess` from `preferredProviderId`, so a Start query without it returns `not_configured` with provider=null, quota=null. Affects balance-driven low/exhausted reminders (server-error-driven reminders have their own branch; do not claim all error hints fail). Cover cold cache, refresh and existing cache so other entries filling the cache do not mask the missing parameter; keep the plan-identity statistics meaning.
- **T155-04 Start without entitlement shown as not connected / config missing**: Start is excluded from the explicit no-plan branch and falls back to disconnected; detail only goes to the Start branch on available/purchased, otherwise shows `accountProviderConfigMissing` just because a settings view exists. Fix `providerFamilyConnectionVisibility.ts`, `Detail.tsx`, `StatusCards.tsx` together: distinguish not logged in, explicit no entitlement/expired, pending, query failure and truly missing config; no connect/disconnect prompt for Start; claim, purchase and model-management entries follow real conditions, not `disconnected` (also check the claim-card gate so entries do not vanish).
- **T155-05 Team connection dropdown misreads the personal Provider's `current`**: check the three construction branches of the team navigation item (expanding the personal template and only replacing presetId still inherits the personal provider); `ProviderFamilyModeHeader.tsx` selects by the real team Provider and team identity, with a placeholder where an empty selection is needed. With personal current=false and actual team current=true the select may get an empty value and render an arrow-only box (no placeholder). This control owns the global paid connection and must not follow the input box's Start choice.
- **T155-06 Model-switch hint shows the plan type**: confirmed by the user: switch hints in the session use `GLM-5.3(个人套餐)`, `GLM-5.3(体验套餐)`, `GLM-5.3(团队套餐)` (other models the same format); each side is labeled by the recorded Provider ID so same-model cross-plan switches stay distinguishable; BigModel and Z.ai both; independent of the current global connection, input draft or catalog availability; history records not rewritten; ordinary custom Providers keep the original display; i18n, desktop/phone and both themes, long names wrap. Check whether the adjacent first-use hint and switch toast share the rule (candidates in the pre-pause draft); the whole model menu, input labels and Subagent labels are not renamed. Example: `模型已切换 GLM-5.3(团队套餐) → GLM-5.3(体验套餐)`.
- **T155-07 Clean up deprecated flows, keep compatible reads**: re-check `manualClaimPlanModelGuideStore` and the old Toolbar claim guide (no production requester found but the consumer still requires start-plan and auto-selects a model; retire it, never restore auto model switching after claiming); re-check old Start navigation filters such as `filterStartPlanItemsByEntitlement` (production already excludes Start before calling; separate unreachable branches from valid compatibility paths); keep the ability to read the legacy `kind: start-plan`, with no bulk rewrite of sessions, tasks, automations or Subagent data; align formal spec and feature graph that still describe Start as a connection option or auto-fall-back to personal on invalidation (the Todo154 independent-Provider decision is authoritative).

## 3. Unchanged boundaries

No full personal/multi-team coexistence (Todo101) and no merge of the two brands' Provider IDs; Start
requests keep using the current account JWT, and no entitlement never silently consumes paid quota; model
menu, exact Start resolution, request auth and submit plan recommendation stay (regression after fixes); no
complex account race barrier, auto-resend, second quota/connection state or extra data migration; task
triggers, background execution, run-now and Bot add no submit recommendation; same-model plan switching
keeps thinking-option compatibility validation; the plan type is display only and does not change model options.

## 4. Acceptance matrix

| ID    | Scenario and expectation                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------- |
| SC-01 | Two brands x global personal/team/unset/legacy Start: choosing Start in the input shows quota by its entitlement  |
| SC-02 | New session with zero context and session with usage: ring/hover correct; after switching back to paid, quota follows the real Provider |
| SC-03 | Legacy team organization completion fails: team stays restricted, a logged-in Start with entitlement is independently usable; no migration |
| SC-04 | Start low balance, exhausted, query failure, cold cache and refresh: access parameters correct; original error hints not regressed |
| SC-05 | Start not logged in, no plan/expired, pending, unknown, truly missing config shown distinctly; claim entry and model management have no misleading connection copy |
| SC-06 | Team current=true, personal current=false: dropdown shows the real team; legacy Start users can still actively choose the only paid plan |
| SC-07 | Two brands x three plan types, same/different model names: both sides' suffix correct; changing current connection, missing catalog or history replay never changes plan type |
| SC-08 | Ordinary custom Provider keeps the original label; zh/en, desktop/phone narrow, light/dark without truncation or overflow |
| SC-09 | Claiming/browsing Start changes no model or global paid connection; legacy settings stay readable; unavailable Start has no paid fallback |

Failing tests first, then fixes. Required checks: root typecheck, lint, `architecture:check --changed`,
affected tests; interaction E2E via Pro admin SSH as the user required; a narrow desktop window is not full
phone shared-host E2E; record uncovered items and review everything at the end.

## 5. Evidence and pause state

- The audit's existing 5 files / 118 tests passed, but the ring test still requires a global Start and the legacy team-completion test still asserts Start unknown; those passes do not prove the independent semantics.
- Eight input groups run against baseline functions: both brands return a Start quota context only for legacy start-plan connections; a service-method probe lacking `accountAccess` returns an empty `not_configured` snapshot.
- Before the pause only T155-06 had an uncommitted draft: `modelTriggerDisplay.ts`, `ConversationRowView.tsx`, `SessionPane.tsx`, `v4ConversationRowViewTimelineMarker.test.ts`, plus a paragraph in the formal Start spec; kept in the workspace, not a completed delivery. Its tests first showed 7 expected failures, then 2 related files / 28 passed; full typecheck, lint, visual/end verification and final review were not done; no commit or push.
- T155-01..05 and 07 were not implemented; per the user's latest request this round only recorded the new Todo and entry links.
