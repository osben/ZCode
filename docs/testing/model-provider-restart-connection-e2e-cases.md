# Model Provider Restart E2E Cases

## Feature scope

This group fixes the model-selection restore boundary on desktop-local `desktop-continuous`: after
an App restart, the full Provider/Model/Reasoning Selection that the user last actually used and
that is still available must be restored. The current structured Provider Family Connection
Selection keeps deciding the Family's current connection; the old `mode/selectedKey` does not take
part in current runtime decisions. Todo88 confirmed it is historical data that must be imported;
this group restores one complete Team identity cold start as a representative to verify that the
read boundary completes the one-way import.

## State authority

```text
Provider Family Connection Selection
          |
          +-----------------------+
                                  |
Persisted Model Selection         |
├─ providerId                     |
├─ modelId                        |
└─ options.reasoningLevel         |
          +-----------------------+
                                  v
                 App cold start -> Selection View
                                  |
                                  v
                       deferred draft -> first request
```

- Tests write the full tuple at once with `seedPersistedModelSelection(...)`.
- Never write model and reasoning in two steps; that would build a torn state users cannot produce.
- Whether a Provider and model are still available is decided by the official
  Resolver/Registry/Selection View.
- The Toolbar gives UI evidence only; the actual first request still proves execution identity.

## Accepted cases

2026-09-07 Todo88 R05 addition: besides the complete old Team key, I26 also restarts from an old key
containing only product/project. The organization is filled from the real `getCustomerInfo` response
of an isolated OAuth mock; assertions: the complete new connection is persisted, old fields are
kept, the original non-first model is unchanged and actually sent. Query failure/ambiguity, no API
Key creation, ordinary settings not waiting for the network, and concurrent saves are covered by
service tests.

| Catalog      | Case                                                            | Setup                                                                                           | Action                                       | Assertions / evidence                                               | Status   |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- | -------- |
| I25 / MP-R01 | Restart keeps an available DeepSeek                             | Full persisted selection points at an available DeepSeek                                        | Restart App                                  | toolbar, deferred draft and first request are all DeepSeek          | covered  |
| I26 / MP-R02 | Restart keeps a non-first model inside Account Provider         | Account Provider exposes several models; full persisted selection points at Highspeed           | Restart App                                  | No fallback to `models[0]`; toolbar/request are both Highspeed      | covered  |
| I27 / MP-R03 | Old Start Plan model falls back to the current Coding Plan      | Family current connection is Team Plan; persisted selection points at an unavailable Start Plan | Restart App                                  | toolbar/request fall back to the current Team Plan default model    | covered  |
| I28 / MP-R04 | Unavailable last-selected falls back to the current connection  | Family current connection is Team Plan; persisted selection points at a deleted model           | Restart App                                  | toolbar/request fall back to the current Team Plan default model    | covered  |
| I29 / MP-S01 | Switching a Family connection keeps other Provider drafts       | DeepSeek draft and BigModel pay-as-you-go API as current connection                             | Switch to Team Plan in settings              | DeepSeek draft and first request unchanged                          | covered  |
| I30 / MP-S02 | Reselecting the current Coding Plan keeps other Provider drafts | DeepSeek draft and Team Plan as current connection                                              | Select the same Team Plan again              | DeepSeek draft and first request unchanged                          | covered  |
| I31 / MP-S03 | Plan reconciliation keeps a non-first model                     | Current Team Plan selection and Highspeed persisted selection                                   | Actively reselect the current Team Plan      | toolbar/request keep using Highspeed                                | covered  |
| I35 / MP-T01 | Turbo off keeps two states after restart                        | Full persisted selection is Turbo/off                                                           | Restart App                                  | toolbar/draft are Turbo; thinking options are only off/enabled      | accepted |
| I36 / MP-T02 | Turbo enabled restart and first send                            | Full persisted selection is Turbo/enabled                                                       | Restart and send                             | toolbar/draft/request are all Turbo + enabled                       | accepted |
| I37 / MP-T03 | Turbo two-state consecutive switching                           | Turbo deferred draft                                                                            | off -> enabled -> off                        | Model does not jump; options stay two-state                         | accepted |
| I38 / MP-T04 | Isolated workspace default late reply                           | Turbo deferred draft                                                                            | Switch reasoning, wait for async config sync | Draft capabilities are not polluted by other models                 | accepted |
| I39 / MP-T05 | GLM-5.2 -> Turbo updates capabilities atomically                | Current GLM-5.2 three-state draft                                                               | Select Turbo                                 | model and reasoning options converge to the Turbo two-state at once | accepted |
| I42 / MP-T06 | Turbo -> GLM-5.2 drops the source level                         | Current Turbo/enabled                                                                           | Select GLM-5.2                               | Uses the target model default level, does not inherit Turbo/enabled | accepted |

## Removed legacy cases

Only I32-I34 were removed. They verified the unreleased old `mode/selectedKey` storage migration,
not the current structured Family Selection:

- I32: old api-key mode repairs the old Coding Plan selectedKey;
- I33: old Team Plan selectedKey identity migration;
- I34: old selectedKey repair when organization is missing.

Todo88 correction: treating all old connection formats as unreleased data and deleting coverage
missed real user migration. I26/MP-R02 now first verifies a new Team selection restart, then changes
it to the old mode/selectedKey of the same identity while the app is closed, restarts, and verifies
that the actual model is still available, new fields are persisted, and old fields are kept only for
rollback. API mode does not fake a plan and a missing organization does not guess a Team identity
(covered by SettingService tests); the combined behavior with account startup coordination still
needs separate acceptance. The I32-I34 removal is historical background and is not grounds for
continuing to reject old data.

I27-I31 verify current-connection fallback, Family switching and model-selection restore, and are
restored per the official structured selection.

## Fixture contract

- Each request uses a stable marker; responses use a case-local replay fixture.
- Restart uses a real Electron reload, proving main/host/renderer/Agent and disk state rehydrate.
- Each case asserts at least the UI Selection and one layer of runtime evidence from the real
  session/request.
- Desktop keeps using the continuous path; this group introduces no mobile replayable state.

## BR117-F01: remote Built-in download failure does not block account connection

- Pending spec: `settings/manual-review/pending/provider-builtin-refresh-failure.test.ts`.
- Setup: isolated local account control plane, valid bundled config, valid BigModel login, personal
  plan as initial selection; the case-local control plane delivers an HTTP Built-in address, which
  the official downloader must reject without overriding the product Active.
- Action: switch to Team in settings, return to the Composer and select a Team model, then select a
  Start model.
- Assert: the config refresh RPC succeeds and a remote-failure warning exists; the Team selection
  keeps its full organization/project identity and is not rolled back; Team/Start models remain
  selectable; no access to the illegal download address.
- This case only proves the desktop-continuous real interaction; shared service unit tests cover
  error classification. Mobile, remote workspace and real paid model requests are not claimed as
  accepted. No external model requests; account responses reuse the local mock.
