# Todo154: Independent Start Provider and submit-time trial-plan recommendation

> Status: implemented and reviewed (2026-09-16, executed on user authorization); Pro admin SSH E2E and
> required checks passed; verification scope and platform boundaries are in section 8.
> Final goal: [Design V2 §4.5](../design-v2/design.md#45-start-独立-providertodo154); historical ruling:
> [C25](../design-v2/evidence-and-contradictions.md#c25-start-独立-provider-与现行单连接语义).
> Code facts and investigation corrections: [research](../research/todo154-start-plan-independence-impact.md).
> Follow-up: this Todo keeps the delivery record of its round; Air feedback and the supplementary audit's
> final fix decisions are in [Todo156](todo-156-start-plan-followup-final-decisions.md) (pending unified
> implementation); Todo155 keeps the initial investigation; section 8 does not mean the follow-up problems
> are fixed.

## 1. Confirmed goal

Start uses the current App login, drops the separate connection step, and is available together with the
current personal/team plan. Only Start is split out; Todo101 (full coexistence of personal/multiple teams)
is not started.

| Item              | Final decision                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider identity | keep `account:zai-start-plan` and `account:bigmodel-start-plan`; no ID merge, no virtual Provider                                                   |
| Name and logo     | both Start entries share one display name, each keeping the existing Z.ai / BigModel logo; the current brand filter decides which is shown          |
| Settings location | an independent Provider entry in the existing "Zhipu" group, reusing existing display and detail components                                         |
| Detail            | only Start's connect/disconnect is removed; entitlement, quota, claim and model management stay; opening detail does not change the paid connection |
| Availability      | login, Start entitlement, model enablement and config completeness still pass the original checks; no auto-claim                                    |
| Data              | no model-selection migration, no new migration version, upgrade connection snapshot or bulk rewrite; existing formats stay readable                 |
| New optimization  | at submit/create, when a paid plan's same model has quota on Start and thinking options are compatible, ask whether to switch                       |
| Request race      | existing account protection kept; no new check/abort/resend between identity read and token read                                                    |

Unified display creates no new execution identity. Across brands, a saved old Start ID is not rewritten to
the new brand's Start. Both brands' model configs are kept (no merge of enablement, order or user overrides).

## 2. Account state, model resolution and auth

### 2.1 `current` and entitlement are separate

`current` means "the Provider matches the current account access context", not the current chat model and
not entitlement.

- Start matches the logged-in account's brand and does not depend on personal/team selection. Personal/team match the account brand and the current paid-connection selection.
- Start and one paid plan may both be `current=true`; an unselected personal plan with entitlement is not enabled by this feature. An expired Start can be `current=true`, `entitled=false`, `availability=unavailable`.
- Real login identity, entitlement, model enablement and completeness are still confirmed by the existing Account/Registry chain (leftover brand settings alone do not imply login). Off-Peak's no-current contract stays; Start.current is not omitted to bypass account limits.
- Start's `connectionKey` depends only on account principal, brand and Start type (not the paid connection): switching team keeps Start's identity, switching account changes it. Same-identity LKG, resetPrevious, revision pairing and pre-publish account/settings checks are reused; no new sync state or token copy.

| State                                             | Expected                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Not logged in, no entitlement, pending            | real status shown; no unexecutable Start models; no "connect Start" prompt        |
| Effective with available models                   | Start and the usable paid plan provide models at the same time                    |
| Effective, server explicitly returns empty models | this round's dynamic model list is cleared; the old whitelist is not kept         |
| Same-identity query temporarily fails             | existing last-known fact kept; with no earlier success nothing is faked available |
| Explicit expiry / credential unavailable          | user's selection kept, reason reported, no auto plan switch                       |

### 2.2 Model selection

Start leaves the "find the single current account plan and map" set and resolves by the saved real
Provider ID / modelId / options. Personal/team keep the paid-connection mapping; ordinary Providers and
Off-Peak are unchanged. Host and the managed Worker share the node-facade classification (whether an
internal `account-start` class is used is an implementation detail; no separate identity mapping in UI and
Worker). When Start is unavailable the paid model is not silently used; a user-accepted recommendation is a
new selection submission that may set the entry's model to Start (not an old-data migration, and the global
paid connection is unchanged).

### 2.3 Request auth

Start requests verify the matching brand and login identity and read `zcodeJwtToken` from the existing OAuth
credential store, no longer requiring a selection or kind Start. Personal Key, team full-scope Key and
Off-Peak Ticket keep their paths. A missing Start JWT never falls back to a team/personal Key; existing
refresh and error classification are reused. The user accepted the existing account-switch handling: no
pre-send identity barrier or abort/resend flow is added.

## 3. Startup and the no-migration boundary

- After login or restore Start becomes available through account and entitlement refresh, not by writing `kind: start-plan`.
- New users' paid plans keep the original init order (personal, team, original purchase entry); a saved paid connection persists across restarts.
- Old `kind: start-plan` stays readable but no longer controls Start execution; the empty state caused by deleting the old value is not treated as a first-time user that silently selects a paid connection.
- Saved model selections are interpreted by the new rules: Start keeps its ID, personal/team keep paid mapping; empty selection, inheritance and historical execution facts keep their semantics. Start becoming available again does not preempt a saved model; with no selection at all the existing initialization rule applies.
- Ordinary Sessions persist the selection when execution starts and drafts are written back after accepted, so the earlier inference "all old sessions keep the original Start and need full migration" was withdrawn. Automation long-term config and explicit Subagent config may not be written back; the user accepted keeping their explicit selection: a saved Start that used to depend on paid mapping uses Start after the change, and without Start entitlement the user must re-select. No claim that execution is unchanged for every user across the upgrade.
- No database migration, no one-off business-layer full conversion, no per-store semantic version or upgrade account snapshot; existing history importers are not deleted; tasks, sessions, automations, Bot, Wiki and Subagent files are not bulk rewritten.

## 4. Submit-time same-model trial-plan recommendation

### 4.1 Common check

On the target App/Host's model and quota facts, prompt only if all hold: (1) this effective selection comes from a paid personal/team plan; (2) the current account's Start has the same model and it is executable in the target Registry; (3) the thinking options are compatible (no silent level reset or switch to another model); (4) the same model has clearly usable remaining quota (entitlement=true alone does not prove balance); (5) the user has not turned the recommendation off.

Reuse the existing UsageEntitlement service and same-model quota-bucket logic; no new balance owner. Reading Start quota while a paid plan is selected must work (the query condition that only enables when Start is selected cannot be reused). Unknown or failed quota skips the recommendation and the original submit continues (no quota-sync gate blocking sending); multiple/expired buckets and model matching follow existing rules; unknown is never positive quota.

### 4.2 Copy and buttons

Title: "体验套餐有可用额度" (trial plan has available quota). Body: "你的体验套餐中，{model name} 仍有可用额度，是否切换使用？". Buttons: "切换套餐" / "不了"; checkbox "不再提示". "Switch plan" sets the entry's model selection to Start's same model (compatible options kept) and then continues the submit/save; "Not now" continues the original selection; closing the dialog keeps the draft and does not perform the action. The personal/team connection is never modified by the button. Confirmation completes before the original command is sent; the original Submission, accepted write-back, dedupe and keep-draft-on-failure rules stay (no submit-then-patch, no second accepted queue).

### 4.3 Entry scope

| Entry                                      | Prompt position and side effect                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New-chat first send, new message in a chat | before the original send chain; button/shortcut/attachment share one check; after confirm the Session/draft write-back is reused                                             |
| Newly submitted queued / guide messages    | checked before first submission; already-submitted queue starts do not re-prompt                                                                                             |
| Create scheduled task                      | after form validation, before creation; the result is saved to the task's model config                                                                                       |
| Edit scheduled task                        | when saving changes touching model selection; title/time-only edits do not prompt                                                                                            |
| Save and run now                           | prompt once at the save stage; the run stage does not check again                                                                                                            |
| Wiki manual generation / full regenerate   | before the new generation request; the result is fixed as this round's selection                                                                                             |
| Custom Subagent create/edit                | when creating an explicit model or editing the model, before form save; description/tool-only edits do not prompt                                                            |
| Built-in / plugin Subagent                 | inline model change saves immediately: prompt after the user confirms the new model, before saving; "Not now" saves the just-picked paid model, closing keeps the old config |

A Subagent switch is saved as long-term model config (not a one-off call); built-in/plugin ones use the
existing user-override store, no plugin file edit. Inherit / restore default, thinking-strength-only change
and enable/disable do not prompt; at run time the parent model is inherited or the explicit config used.
Subagent copy: "switch this subagent's model to the trial plan?".

Excluded explicitly: Bot send/receive, scheduled-task list "run now", scheduled triggers, Agent-tool task
creation, background Subagent calls, Wiki auto-refresh, off-peak tasks, immediate send of an existing queue,
retry of the original request, Wiki failure-page fill-in. History edit/retry adds no new model-selection
parameter or switching semantics. The user finally withdrew "run now" from the plan.

### 4.4 Don't ask again

A unified persisted preference of the current App/Host shared by all entries, valid across restarts; a
phone connected to the same Host obeys it. No cross-device cloud sync and no per-session storage. It only
turns off the recommendation, not real errors such as quota exhausted or credential invalid. The next time
each entry still runs its saved model selection ("don't ask again" never means "auto Start later" or
"always paid"). Checked + "Switch plan": this time written as Start through the original flow and reused
next time by that entry; checked + "Not now": the paid selection is kept. Other sessions/tasks/Subagents'
model configs are not changed; only the "off" preference is shared.

## 5. Start invalidation and paid-connection notices

Existing Start low-quota, model/daily-quota exhausted and concurrency-limit banners and recovery stay;
expiry and credential problems show the real reason and never auto-switch to a paid plan. The global
connection-invalidation observer watches only the current personal/team connection and does not treat
Start.current=true as a plan needing manual connection. Existing suggestions to switch between paid plans
stay; the action of switching to Start by writing `kind: start-plan` is removed. Start is expressed by its
own quota feedback, model-unavailable state and settings detail, so users on a paid plan do not get global
invalidation notices about the background Start. No multi-Start / paid notification queue.

## 6. State ownership and chain

| Fact / intent                               | Owner                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Login identity, JWT                         | OAuth service and credential store                                                        |
| Paid-connection selection                   | SettingService                                                                            |
| current, entitlement, dynamic model members | Account Source, State and Overlay published in one revision                               |
| Executable models and effective selection   | target Host/Worker Registry and the shared Selection Facade                               |
| Quota                                       | existing UsageEntitlement service; UI consumes snapshots only                             |
| Whether the recommendation is off           | current App/Host unified setting preference                                               |
| Draft, config and submission                | each entry's original owner; the returned selection goes through the original submit path |

Flow: user confirms submit or create -> the UI reads the same-model Start availability, thinking options and
quota from the target Host service -> if the recommendation is off or no clearly compatible usable quota,
continue with the original selection; otherwise show "switch plan / not now" plus "don't ask again" ->
submit once with the confirmed model -> the original owner writes back by its accepted/save rules. Closing
the dialog does not enter the original submit. Desktop continuous, phone replayable and target
workspaceIdentity isolation stay; model availability is not read from the wrong Host's local cache.

## 7. Steps and acceptance scenarios

P0 this doc + Design V2 converge; P1 tests first, then current / paid-mapping classification / Start request auth together; P2 settings group, unified name and brand icon, independent detail, Start connection action removed; P3 startup keeps old values readable, stops writing the Start connection, limits paid-invalidation observer and suggestions; P4 shared recommendation check and dialog, Host preference, entry wiring; P5 affected regression and desktop/phone interaction verification, formal docs after stabilization.

| ID     | Scenario and key assertions                                                                                                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SIP-01 | Each brand logged in with Start entitlement and no plan selection: Start executes, request uses the JWT                                                                                                                                                                           |
| SIP-02 | Start and the current personal/team both current: same-name models execute separately without mixing credentials                                                                                                                                                                  |
| SIP-03 | Switching personal/team/Team scope does not change Start identity, model intent or connectionKey                                                                                                                                                                                  |
| SIP-04 | Independent Start in the Zhipu group, unified name, brand logo; detail has no connect/disconnect, keeps entitlement and model management; browsing writes no paid connection                                                                                                      |
| SIP-05 | Not logged in, no entitlement, pending, unknown, explicit empty models, model disabled: shown and validated by the original contract                                                                                                                                              |
| SIP-06 | Saved Start keeps its ID after restart; paid selection still maps the current paid connection; unavailable Start does not auto-swap plans                                                                                                                                         |
| SIP-07 | Old kind:start-plan readable and Start auto-available; no model data migration; new-user init does not pick a paid plan; the only non-current personal plan stays user-selectable                                                                                                 |
| SIP-08 | Existing account-switch, logout, LKG and request-credential protection kept; no new identity-read barrier                                                                                                                                                                         |
| SIP-09 | Start quota/concurrency errors keep the original banner; recovery does not preempt other selections                                                                                                                                                                               |
| SIP-10 | With Start and paid both current, global invalidation observes only the paid connection; no suggestion to write a Start connection                                                                                                                                                |
| SIP-11 | After claiming, Start refreshes without overriding the original model or paid connection; deep link opens Start itself                                                                                                                                                            |
| SIP-12 | Automation/Bot/explicit Subagent/Wiki saved selections follow the new resolution; no bulk migration; inheritance and frozen runs not reinterpreted                                                                                                                                |
| SIP-13 | Desktop, phone on the same Host and remote workspace read the right models and quota; continuous/replayable recovery contracts kept                                                                                                                                               |
| SIP-14 | Paid same-model with Start available and quota, compatible levels: recommendation shown; different model, incompatible level, already Start: not shown                                                                                                                            |
| SIP-15 | Unknown, failed, expired-bucket or exhausted quota never reported available; original submit kept, normal paid use not blocked                                                                                                                                                    |
| SIP-16 | Chat first/follow-up sends, attachments, shortcut, new queue/guide submissions: after switching the actual request is Start, sent once; "Not now" keeps the model; closing keeps the draft                                                                                        |
| SIP-17 | Scheduled task create/modify model, save-and-run: prompt only at the save stage and save the result; run-now and background scheduling do not prompt                                                                                                                              |
| SIP-18 | New Wiki generation may prompt; auto-refresh and failure-page fill-in do not; existing generated facts not rewritten                                                                                                                                                              |
| SIP-19 | Subagent custom save and built-in/plugin immediate save follow the button semantics; inherit, restore default, thinking-strength/text-only edits and execution do not prompt                                                                                                      |
| SIP-20 | "Don't ask again" holds across entries, restart and phone on the same Host; after checked switch / "Not now" the next selection still comes from that entry's saved result and other entries' models are unchanged; no new account sync across Hosts; real error hints not masked |
| SIP-21 | Ordinary API Provider, Off-Peak, Bot, original-request retry: no recommendation dialog or new model-switch side effect                                                                                                                                                            |

Gates follow root and child AGENTS: freshness / git status, affected tests, typecheck, lint,
`architecture:check --changed`; App interaction adds desktop/phone E2E and theme/i18n verification; CLI per
its own rules; new E2E follow e2e-case-lifecycle. The formal behavior is synced to the
[Start spec](../../../zai-start-plan-provider.md); I27/MP-R03 are Recent-injection and default-model-restore
tests and are not rewritten as proof that ordinary Sessions must be migrated.

## 8. Delivery and evidence (2026-09-16)

P1-P4 are implemented and the formal Start spec updated. Start keeps the two real IDs and reuses Account
Source and the Host/Worker facade; no database migration, Schema version or bulk config rewrite. The static
Built-in release revision 28 -> 29 only marks the display-name update and the test config is derived by the
original script (not a user-data migration). Work baseline: fast-forwarded to `origin/staging` `2772217134`
(was `c9f959050b`, +672 commits); upstream took Todo153, so this Todo and all indexes were renumbered to
Todo154; branch `start-plan-independent-provider`; the discussion phase's 17 tests and old line numbers are
historical investigation only.

Checks (groups overlap; counts are not independent totals): core and UI targeted regression 16 files / 399
(Account resolver/config source, shared facade, recommendation check and confirmation, accepted write-back,
Session, Automation, Subagent, navigation, startup, invalidation observer); boundary review regression 10
files / 276 (Wiki state/store, request auth, Automation resolution, Web remote lifecycle/failures); Pro
native-dependency unit 11 files / 143; review supplements 2 files / 188 (single unconnected personal plan
keeps an actionable entry; preference read failure skips; write failure still obeys the current button and
warns not saved); early-failure suites closed 11 files / 186; Built-in config sync and consistency checks
plus 8 files / 106 and 1 real node-facade test; root `pnpm typecheck` (incl. desktop E2E and Web); lint 0
errors / 54 existing warnings; `architecture:check --changed` 0 violations; fixture checker passes (4 `_DONE`
response assertion marks without a request matcher are expected). The early broad related scan (1150 files)
had 24 failing files: native-environment ones moved to Pro, mocks/old connection and navigation assertions
for the new hook updated and passing, the pre-existing WorkflowArtifactSidePane timing failure passed on
rerun; the scan is not green evidence and no whole-repo green is claimed.

Pro admin SSH Electron runs (`macbook-pro-admin`, isolated worktree `/Users/dev/zcode-start154-pro-e2e`,
daily dev dir untouched; model/entitlement/signing external dependencies use case-local fixtures; UI,
Host/Worker Registry, submission, SDK request construction and persistence are real code; no real paid
service):

| Spec                                                                                             | Asserted behavior                                                                                                                                                                                                                                                                                                                                                                                                   | Result                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-session/manual-review/pending/conversation-session-start-plan-independent.test.ts` | independent Start navigation, no connect button, paid selection unchanged; Subagent close-restore/confirm-save/thinking-only no prompt; scheduled task create switches to Start (SQLite checked), text edit no prompt; chat "not now"/close/switch, real request Provider and `high` level, sent once, accepted write-back; recommendation-off persists across entries and restart; 1280/390 widths and both themes | release 29 run `desktop-e2e-20260916133532026-p27004-0077916f12a51fd1` passed (earlier extended run `...131850282-p22060-...` passed) |
| `repo-wiki/repo-wiki-model-plan-selection.test.ts`                                               | paid and Start coexist; default paid, "not now" generates with paid persisted; full regenerate switch saves Start in wiki.json                                                                                                                                                                                                                                                                                      | `desktop-e2e-20260916132805627-p25424-cd18c54e0f1f4fc0` passed                                                                        |
| `ui-shell/marketing-touch-entitlement.test.ts`                                                   | old kind:start-plan kept across restart; claim/refresh/browse do not change the connection; the only personal plan can be actively selected; saved Start Subagent model not overridden by paid selection                                                                                                                                                                                                            | `desktop-e2e-20260916133328079-p26502-2678ae04ad3d916c` passed                                                                        |

Run summaries are under `packages/desktop/.e2e-artifacts/<run>/summary.md` in the Pro worktree; four dialog
layout screenshots are local in `/tmp/start154-visual-review/` and were viewed. The new cases stay pending
(no manual promotion or CI admission claimed).

Review conclusions and fixes (whole production diff, shared components and entry side effects reviewed; no
remaining blocker): Account current / connection identity, same-revision state publication, JWT vs paid-Key
split, exact Start resolution and old-data reads were checked with no new token race barrier or silent paid
fallback. A real run showed the recommendation quota read must pass Start `accountAccess` explicitly,
otherwise an empty snapshot results when a paid plan is selected (fixed with a hook contract test, then real
submit E2E passed). The recommendation sits after queue confirmation, command and model validation and
before the original submit; the switch result is remembered through the original accepted/save path; closing
keeps the draft; existing retry / submitted queue / Bot never enter the new path. Fixed: Start deep link
wrongly hit the family container, and the selector hidden for an old Start user with a single paid candidate
(red-then-green, verified by the Pro old-config claim flow, not by migration). Also checked: dialog close vs
"Not now", checkbox reset across dialogs, Enter semantics on button focus, preference read/write failures
and Wiki remembering the model after acceptance. The Wiki old fixture default GLM-5.2 is no longer in the
paid list and falls back to GLM-5.3, so the test now uses GLM-5.3-Flash/high shared by paid and Start (no
production model-list expansion). Built-in content changes bump revision and sync the test config; user
persistence Schema is unchanged.

Coverage by SIP: 01-03, 05-08 resolver for both brands, no/paid/legacy selection, stable connectionKey,
LKG/logout, real node facade exact Start/paid mapping, Pro restart and old Start selection kept with
explicit switch to personal; 04, 10-11 navigation / status card / observer / loss-suggestion unit tests, Pro
independent navigation and claim refresh; 09, 12, 21 original quota/auth and owner reuse, resolution and
affected-boundary regression, no new background notification chain or bulk rewrite; 13 desktop real
Host/Worker E2E, desktop / compactForRemoteControl Session submission tests and Web lifecycle/failures
regression (quota and preference still from the base Host service); 14-15 same-model, brand, thinking,
non-executable, unknown/failed/expired/multi-bucket tests, Pro actual confirmed request; 16 Pro first/
follow-up single request, close draft, accepted write-back; 17-19 Pro task create and text edit, Wiki
generate/regenerate, built-in Subagent immediate save; 20 hook two buttons + suppression preference,
cross-instance and error handling, Pro "not now" persists after restart.

Not run: a physical phone Safari / full Web shared-host joint chain, Windows / Linux Electron, any real-account
paid API. 390px is a narrow check of the same real dialog and does not replace those platform conclusions;
each custom/plugin Subagent form combination was not E2E'd individually (shared save entry plus regression
evidence); SIP dimensions are not all marked as real-machine covered.
