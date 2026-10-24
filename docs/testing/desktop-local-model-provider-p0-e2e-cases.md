# Desktop Local Model Provider P0 E2E Cases

This document records, case by case, the design, verification items and run conclusions of the P0 E2E cases for chat-box model providers in a desktop local workspace. Scope: desktop local only; remote workspace, mobile `/remote`, replayable recovery and remote runtime header fallback are excluded.

Every case must:

- Cover one explicit positive product semantic; adjacent queue, stop, remote or fault semantics are not mixed into the same case.
- Have independent setup, action and assert; a test path merely passing through the related state does not count as coverage.
- Have core verification that includes at least one of: UI-visible state, a real provider request or capture, or the session/store terminal state.
- Before formalization, have a case-local fixture and manifest; a case already on the formal path must rerun the fixture check and replay to prove the contract still holds.

## Common fixture contract (formal replay cases P0-01 to P0-10 unless a case says otherwise)

- The title-generation request is a `common` synthetic fixture, used only to stabilize titles, and is not part of the case's product semantics.
- The first-send main request is a `main` synthetic fixture whose matcher must contain the case marker and exclude title-generation and compact-summary prompts.
- Formal replay must depend only on `common.json` and the case-local fixture, never on the dedicated fallback of the legacy `provider-basic.json`.

## Todo144: connection test succeeds with 1 token and no body

2026-09-15 Pro verification: the pending specs C91-04 and Todo95 together passed 2/2. The no-body success fixture explicitly returns completion_tokens=1, so it is not confused with the existing Adapter retry scenario of "no content and no usage"; the formal retry policy is unchanged.

- Extends C91-04 pending `settings/manual-review/pending/provider-connectivity-prompt.test.ts`: real model-row click; a case-local loopback returns an SSE with no body and finish_reason=length; asserts success feedback, Chat wire max_completion_tokens=1 and the original fixed Prompt unchanged; the second response returns 400 and asserts failure with config/selection unchanged.
- Accepted combinations: the lowest level and the budget/error boundary are covered by Core unit tests; the budget fields of the three protocols by Adapter unit tests. E2E uses Chat as the representative; it does not widen to all brands, themes, remote/mobile devices, nor claim full upstream compatibility. Still synthetic/fast-text, locally isolated, pending, not promoted.

## Todo95: unknown model configures only the reasoning level

- Todo147 extension: the same pending case, when adding an unknown model, checks the recommended window `1000000` and output cap `128000`; after saving it confirms these two are not written to Personal. It keeps the original connection-test budget and does not enlarge the actual probe request because the recommended cap rose. The three protocols, known-model coverage and alias order are covered by config-layer tests; no new UI state or theme layout.
- Pending: `settings/manual-review/pending/provider-reasoning-fallback.test.ts`. Local `desktop-continuous` only; not mobile or remote device proof.
- Setup: independent loopback Chat Completions synthetic SSE service, a custom Provider with an empty model list; no personal reasoning Map written; no account or real quota.
- Action: in the real settings page add an unknown `E2E_T95_UNKNOWN`, change only the default disabled level to high, keep smart configuration; after saving click the inline connection test.
- Assert: Personal stores only values and does not freeze the recommended Map; the final wire-format request carries the four compatible fields for high, the original model ID and the fixed probe Prompt; no manual thinking budget. Then the existing SC90-01 verifies fixed configuration/edit read-back and C91-04 verifies default disabled and that failure does not change the selection.
- Pruning: legal levels and override order of the three Schemas / all dedicated Maps are enumerated by config and request-layer unit tests; this interaction picks Chat high as the representative and does not repeat three UIs. The rename work line C still awaits a security-boundary ruling and this case cannot claim compatible renaming is done.
- Fixture class: synthetic / fast-text; the fixed allowlisted Prompt cannot carry a marker, so it is identified by the separate model ID `E2E_T95_UNKNOWN`; the separate local service only returns a fixed ok and touches no external model.

## P0-01: Local default workspace DeepSeek first-send smoke

| Field | Content |
| --- | --- |
| Catalog | `I07` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-upstream-workspace-smoke.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-upstream-workspace-smoke.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-upstream-workspace-smoke.json` |
| Status | promoted, formal-path replay case |

Scenario: the user starts the desktop app and opens the default local workspace; the DeepSeek custom provider was written into the isolated app data by the E2E helper. The user opens the chat-box toolbar model list, confirms the target model exists under the DeepSeek provider, selects it and sends the first plain text message. Only the minimal positive chain "local default workspace + configured DeepSeek + empty-draft first send" is verified; queue, stop, model switching, edit/fork, remote workspace and provider faults are not covered.

Steps: (1) clean and prepare E2E app data, start the desktop local default workspace; (2) wait for the default workspace and an interactive chat view; (3) open the chat-box model list; (4) find the target model under the DeepSeek provider group; (5) select it; (6) send plain text with the `E2E_UPSTREAM_WORKSPACE_SMOKE` marker; (7) wait for the user message, the DeepSeek request capture, the assistant reply and the final idle state.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-01-A | Default local workspace open and chat view present | Starts from a real interactive entry, not a service-layer call |
| P0-01-B | Model list button clickable | Chat model selection entry works |
| P0-01-C | DeepSeek provider group exists or can expand | Target model comes from the right provider group, not a bare model-name false match |
| P0-01-D | Target model visible in the list | The current Environment Model Selection View is projected to the chat box (exact test id, custom encoded value supported) |
| P0-01-E | After selection the toolbar current model is the target | The selection is written into the current chat config |
| P0-01-F | After sending, the input clears and the user message is visible | Plain first send goes through the real composer |
| P0-01-G | A DeepSeek main request containing this marker is captured | The assistant reply is not faked locally |
| P0-01-H | The prompt in the request body equals the user input | First-send context contains the right user message |
| P0-01-I | The request body uses the target DeepSeek model | The UI selection really affects the provider request |
| P0-01-J | If the provider declares a thought level, the request carries the current one | Thinking depth config is synced to the provider request |
| P0-01-K | The assistant reply contains the agreed token | The replay response is consumed and rendered correctly |
| P0-01-L | After round one the session is idle and queue=0 | The first-send chain closes fully, no residual busy or wrong queueing |

Verification outcome (2026-07-02): fixture check, `typecheck:e2e`, strict common + case-local fixture replay (1 case passed; log shows `model_name=e2e-upstream/deepseek-v4-flash`, `model_provider=e2e-upstream`, final `state=idle`, `queueCount=0`) and the default replay path all passed. The `upstream-workspace-smoke-title` fixture has no E2E marker, which matches the non-business semantics of the title common fixture. The case is already on the formal path; no promotion was repeated.

## P0-02: Add a custom provider on the settings page, then select it in chat and send

| Field | Content |
| --- | --- |
| Catalog | `I08` |
| Spec | `packages/desktop/test/e2e/conversation-session/conversation-session-model-provider-add-send.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-provider-add-send.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-add-send.json` |
| Status | promoted, formal-path replay case |

Scenario: in the desktop local default workspace the user opens settings and adds a custom provider with a unique name, filling the DeepSeek replay endpoint, API Key and target model. All fields of the add-model dialog are flat: context window default 1,000,000, max output default 128,000; input type defaults to and locks Text, Image/Video can be selected, Audio/PDF are not shown yet; output type is currently fixed Text. After typing the target model the catalog query status is shown and max output is auto-filled; the user selects Image, overrides the filled value and saves; after the provider is created the user enters the edit-model dialog again, cancels Image and changes max output. After saving, back in the chat box the user selects the new model and sends. This verifies the shortest positive chain "settings add provider and model metadata -> local config persisted -> chat-box provider/model registry synced -> real provider request". Catalog no-match, undeclared, query failure and late results are covered by interaction unit tests; E2E does not treat the DeepSeek provider preset at startup as "added", and does not cover remote, queue, stop, fork, provider faults or multi-session isolation.

Steps: (1) prepare E2E app data, start the desktop local default workspace; (2) enter the settings model-provider section; (3) click the "add custom provider" nav item; (4) fill a unique provider name, the DeepSeek replay Base URL and API Key; (5) confirm the model metadata dialog fields are all flat, Context=1M, Max Output=128K, input Text and output Text locked; (6) type the target model ID, confirm loading during the query, max output still editable and save disabled; wait for the real catalog to fill max output tokens and confirm Context still 1M; (7) select Image, override max output and submit the model draft; click "add provider", wait for modalities and values to be written to local config; (8) re-enter the model edit dialog, confirm Image and max output read back; cancel Image, change max output, submit and wait for persistence; (9) back in the chat box open the model list and select the target under the new provider; (10) send plain text with the `E2E_MODEL_PROVIDER_ADD_SEND` marker; (11) wait for the user message, DeepSeek request capture, assistant reply and final idle.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-02-A | Default local workspace open, chat view interactive | Starts from a real desktop local entry |
| P0-02-B | Settings model-provider section reachable | User configures the provider through the real UI |
| P0-02-C | The add-custom-provider form accepts name, Base URL, API Key | The add entry works without relying on preset config |
| P0-02-D | The add-model dialog has no "Advanced" fold; fields flat; Context=1M, Max Output=128K | New defaults and flat information architecture through the real UI |
| P0-02-E | Input Text selected by default and not deselectable, Image/Video toggle, Audio/PDF not shown, output shows locked Text only | Type selection and current output boundary |
| P0-02-F | After typing the target ID: pending/loading, max output editable but save disabled; real catalog fills max output and Context stays 1M | Catalog timing, user input priority and submit protection |
| P0-02-G | After the user selects Image and overrides the filled value the model can be submitted | Atomic model metadata submission |
| P0-02-H | New provider persists apiKey, endpoint, max output, `input=[text,image]`, `output=[text]` and an explicit source marker | Modalities and source are really persisted |
| P0-02-I | Edit dialog reads back Image and max output flat; cancel Image, change max output and save | Edit mode reads and updates existing model metadata |
| P0-02-J | Edited max output tokens persisted again | The changed value follows the existing provider save chain |
| P0-02-K | Chat model list shows and can select the model under the new provider | The Model Selection View takes effect after the current Environment Registry refresh |
| P0-02-L | Toolbar currentValue keeps the new provider id | Same-name models do not degrade into bare model-name matching |
| P0-02-M | After sending, input cleared and user message visible | Plain first send goes through the real composer |
| P0-02-N | A DeepSeek main request containing this marker is captured | The assistant reply comes from a real provider request |
| P0-02-O | The request body uses the target model, current thought depth and the edited max output tokens | Advanced model config finally enters the real runtime request (`max_tokens`) |
| P0-02-P | The assistant reply contains the agreed token | The replay response is consumed correctly by the UI |
| P0-02-Q | After round one the session is idle and queue=0 | New-provider first-send chain closes fully |

Fixture contract: the common contract above, with the marker `E2E_MODEL_PROVIDER_ADD_SEND`.

Verification outcome: 2026-07-02 add, promotion (spec moved from pending to the formal `conversation-session/` path; promotion moves only this spec and generates the case provider fixture and manifest), fixture check, strict common + case-local replay (log shows `modelCurrent=<new provider id>/deepseek-v4-flash`, final `state=idle`, `queueCount=0`) and the default replay path (log shows `model_provider=<new provider id>`, proving the request did not fall back to the preset `e2e-upstream`) all passed; Docker admission not executed by agreement. 2026-07-25 after adding advanced model config and re-promotion: dry run, `--apply`, fixture check and explicit replay all passed; the real provider request had `max_tokens=64000`, matching the edited model value. 2026-08-21 after the flat-dialog settings: typecheck, fixture check and the formal spec passed; the real UI covers flat fields, 1M/128K defaults, Text lock, Image select/cancel, modality source persistence, active registry update and the first-send request; after hiding Audio/PDF and retitling "input type / output type" the default formal replay passed again; after removing the generic hint that conflicted with the Video attachment capability the real dialog no longer renders the hint row, and spacing of the input/output type groups, button wrapping and dialog height stay normal in zh dark and en light.

## P0-03: Chat model list shows only available providers/models

| Field | Content |
| --- | --- |
| Catalog | `I09` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-model-provider-list-filtering.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-provider-list-filtering.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-list-filtering.json` |
| Status | pending; expanded on 2026-08-25 to the Provider refactor semantics, awaiting real replay, human review and promotion |

Scenario: when the desktop local default workspace starts, the E2E seed provides at the same time an available provider, a hidden provider, a visible provider containing a hidden model, a disabled/incomplete provider, and the real `builtin:zai/glm-5.3` with a same-identity Personal Overlay. When the user opens the chat-box model list, hidden or non-executable members must not appear; when Built-in and Personal share a name, the Built-in model must stay selectable and executable and complete a real send using the Overlay's Effective Endpoint. Only "model list visibility filtering + visible model can send" is covered; settings-page add provider, provider save, remote, queue, stop, edit/fork and multi-session recovery are not.

Steps: (1) prepare E2E app data, start the desktop local default workspace; (2) the WDIO seed injects the available DeepSeek provider, available alt provider, hidden provider, visible provider with a hidden model, disabled/incomplete provider and the Personal Overlay of `builtin:zai/glm-5.3`; (3) open the chat-box model list; (4) check the available provider groups and the target model item exist; (5) check the hidden provider, disabled, missing-API-Key and missing-endpoint provider groups and model items do not exist; (6) expand the visible provider, check the visible companion model exists and the hidden model does not; (7) expand `builtin:zai`, check `glm-5.3` is not isolated by the same-identity Personal Overlay; (8) exactly select `builtin:zai/glm-5.3`, confirm the toolbar keeps the composite Provider/Model identity; (9) send plain text with the `E2E_MODEL_PROVIDER_LIST_FILTER` marker; (10) wait for the request capture, assistant reply and final idle, and confirm the request uses `glm-5.3` and the Overlay's case-local Endpoint.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-03-A | Default local workspace open, chat view interactive | Starts from a real desktop local entry |
| P0-03-B | Available DeepSeek provider group exists | A normal provider is not hurt by filtering |
| P0-03-C | In a visible provider the companion model exists, the hidden model does not | Model visibility takes part independently in menu projection |
| P0-03-D | Available alt provider group exists | A same-name model of another available provider keeps its provider identity |
| P0-03-E | Hidden provider not shown | Provider visibility takes part independently in menu projection |
| P0-03-F | Disabled provider not shown | `enabled=false` is filtered from the menu |
| P0-03-G | Provider missing API Key not shown | A provider that needs credentials does not enter chat selection unconfigured |
| P0-03-H | Provider missing endpoint not shown | A provider with no sendable endpoint does not enter chat selection |
| P0-03-I | With Built-in/Personal same identity `builtin:zai/glm-5.3` is still shown | Personal Overlay does not wrongly isolate the Built-in member |
| P0-03-J | After selection toolbar currentValue keeps the composite identity `builtin:zai/glm-5.3` | Selection does not degrade to a bare modelId |
| P0-03-K | Request uses `glm-5.3` and hits `/builtin-personal-conflict` | The Built-in model runs along the Effective Provider Config |
| P0-03-L | The assistant reply contains the agreed token; after round one idle and queue=0 | The send chain of the filtered visible model closes fully |

Fixture contract: the common contract above; the main matcher must contain both `E2E_MODEL_PROVIDER_LIST_FILTER` and `/builtin-personal-conflict`.

Verification outcome: 2026-08-25 the case was expanded to the visibility and Overlay semantics after the Provider refactor. Fixture contract check and E2E typecheck passed; the environment had no usable Xvfb/Docker, so the real replay, human review, promotion and Docker admission of the expanded version are not done and the case stays pending. The 2026-07-02 results (add, promotion, fixture check, strict and default replay passed; negative-sample providers did not leak into the menu, `model_provider=e2e-upstream`) prove only the old version of the case and are not green evidence for the expanded assertions.

## P0-04: Empty draft switches model, then the first send uses the new model

| Field | Content |
| --- | --- |
| Catalog | `I10` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-draft-model-switch-first-send.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-draft-model-switch-first-send.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-draft-model-switch-first-send.json` |
| Status | promoted, formal-path replay case |

Scenario: the desktop local default workspace is open, the chat box is an empty draft, and the DeepSeek provider has both a primary and a secondary model. Before sending anything the user switches the current model to the secondary model from the chat-box list and picks the secondary thought depth, then sends the first plain text. Verifies the minimal chain "draft-state model selection is future session config". Not covered: model switching after completed history, running queue consumption, held queue after stop, edit/fork, remote.

Steps: (1) prepare E2E app data, start the local default workspace; (2) ensure the DeepSeek provider contains the secondary model; (3) new empty draft, confirm no session/task binding; (4) select the secondary model; (5) select the secondary thought depth; (6) assert toolbar currentValue / display text is the secondary config; (7) send plain text with the `E2E_DRAFT_MODEL_SWITCH_FIRST_SEND` marker; (8) wait for the user message, request capture, reply and final idle.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-04-A | Default local workspace open, chat view interactive | Real desktop local entry |
| P0-04-B | DeepSeek secondary model exists in provider config | The test does not select an unconfigured model |
| P0-04-C | After new, an empty draft with no session/task binding | The action happens in the pre-send draft state |
| P0-04-D | After selecting secondary, toolbar currentValue keeps provider + model identity | Selection is written to the draft's future config, not only text display |
| P0-04-E | After selecting secondary thought depth the toolbar shows it | The requested depth also updates with the draft config |
| P0-04-F | After sending, input cleared and user message visible | First send goes through the real composer |
| P0-04-G | A DeepSeek main request containing the marker is captured | The reply comes from a real provider request |
| P0-04-H | Request body uses the secondary model and secondary thought depth | The draft switch really affects the first-send runtime request |
| P0-04-I | Assistant reply contains the agreed token | The replay response is consumed correctly |
| P0-04-J | After round one idle and queue=0 | The draft-switch first-send chain closes fully |

Fixture contract: common contract, marker `E2E_DRAFT_MODEL_SWITCH_FIRST_SEND`.

Verification outcome (2026-07-02): add, promotion (spec moved to the formal path, case fixture and manifest generated), fixture check, strict common + case-local replay (log: `model_name=e2e-upstream/deepseek-v4-pro`, `model_provider=e2e-upstream`, final idle, queue 0) and default replay passed; the request did not fall back to primary `deepseek-v4-flash`. Docker admission not executed.

## P0-05: A new session inherits the last model selection

| Field | Content |
| --- | --- |
| Catalog | `I11` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-new-session-inherits-model.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-new-session-inherits-model.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-new-session-inherits-model.json` |
| Status | promoted, formal-path replay case |

Scenario: in the desktop local default workspace the user switches the chat-box model to DeepSeek secondary and completes one plain session, then clicks new task into an empty draft, does not switch the model again and sends the next plain text. Verifies "a new session inherits the latest chat-box provider/model/thought selection". Not covered: multi-session config isolation, queue, stop, edit/fork, remote.

Steps: (1) start the local default workspace, ensure the DeepSeek secondary model exists; (2) in an empty draft switch to the secondary model and thought depth; (3) send plain text with marker `E2E_NEW_SESSION_INHERITS_MODEL_A` and wait for completion; (4) click new task into an empty draft; (5) without selecting a model, assert the toolbar is still the secondary config; (6) send marker `E2E_NEW_SESSION_INHERITS_MODEL_B` and wait for completion; (7) assert both A and B provider requests use the secondary model and thought depth, final idle and queue=0.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-05-A | Secondary model exists and can be selected in the first draft | The inheritance source config really exists |
| P0-05-B | First send request uses the secondary config | The source is not a toolbar illusion |
| P0-05-C | After new task: empty draft and toolbar still secondary | The new draft inherits the latest selection |
| P0-05-D | Second direct first-send request uses the secondary config | The inherited config really affects the runtime request |
| P0-05-E | After both sends idle and queue=0 | The inheritance chain closes fully |

Fixture contract: common contract, except both plain sends share one `main` synthetic fixture whose matcher contains `E2E_NEW_SESSION_INHERITS_MODEL` with `maxMatches=2`.

Verification outcome (2026-07-02): promotion, fixture check, strict replay (A and B requests both `model_name=e2e-upstream/deepseek-v4-pro`, final idle, queue 0) and default replay passed. Docker admission not executed.

## P0-06: Multi-session provider/model config isolation

| Field | Content |
| --- | --- |
| Catalog | `I12` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-model-provider-session-isolation.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-provider-session-isolation.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-session-isolation.json` |
| Status | promoted, formal-path replay case |

Scenario: in the desktop local default workspace the user creates two plain sessions: Session A completes a round with the DeepSeek primary model and primary thought depth; Session B completes one with the secondary model and thought depth; then the user switches back to A and B and continues sending plain text. Verifies that provider/model/thought config of different sessions in one local window is isolated. Not covered: running concurrency, queue, stop, remote, new-draft inheritance.

Steps: (1) start the local default workspace, ensure the secondary model exists; (2) in the Session A empty draft select primary model and depth, send A round one and wait; (3) create Session B, select secondary model and depth, send B round one and wait; (4) switch back to A, assert the toolbar restores primary, send A follow-up; (5) switch back to B, assert the toolbar restores secondary, send B follow-up; (6) assert the four provider requests use their own session's model and thought depth, final idle and queue=0.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-06-A | A round-one request uses the primary config | A's initial session config is really written to the runtime |
| P0-06-B | B round-one request uses the secondary config | B's config differs from A's and is really written |
| P0-06-C | After switching back to A the toolbar restores primary | UI restore is per session, not the global latest selection |
| P0-06-D | A follow-up request keeps the primary config | B's secondary selection did not pollute A |
| P0-06-E | After switching back to B the toolbar restores secondary | B's session config keeps provider/model identity |
| P0-06-F | B follow-up request keeps the secondary config | A's restore and later send did not pollute B |
| P0-06-G | After each round idle and queue=0 | No residual busy or wrong queueing |

Fixture contract: common contract; each of the four sends (A/B/A-follow/B-follow) has its own `main` synthetic fixture whose matcher exactly contains the matching `E2E_MODEL_PROVIDER_SESSION_ISOLATION_*` marker.

Verification outcome (2026-07-02): promotion, fixture check, strict replay (A/A-follow primary, B/B-follow secondary, final idle, queue 0) and default replay passed. One `electron-service:bridge` context id timeout log appeared at exit but the spec result was passed and product assertions were unaffected. Docker admission not executed.

## P0-07: After cross-provider switching the request uses the alternate provider's model

| Field | Content |
| --- | --- |
| Catalog | `I13` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-same-model-provider-identity.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-same-model-provider-identity.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-same-model-provider-identity.json` |
| Status | promoted to the formal path, strict/default replay done |

Scenario: the desktop local E2E seed provides both a primary DeepSeek provider and an alternate DeepSeek provider. The primary exposes `deepseek-v4-flash`, the alternate exposes `deepseek-v4-pro`. The user selects `deepseek-v4-pro` under the alternate provider and sends the first plain text. Verifies "cross-provider selection really changes the provider request model": the chat-box `data-model-current-value` exactly asserts the alternate provider identity and the request capture asserts the body `model` is `deepseek-v4-pro`, avoiding a weak proof from the same URL and model name.

Steps: (1) start the local default workspace; (2) open the model list, select `deepseek-v4-pro` under the alternate provider; (3) assert toolbar currentValue is the provider-backed value of alternate provider + `deepseek-v4-pro`; (4) send plain text with the `E2E_SAME_MODEL_PROVIDER_IDENTITY` marker; (5) assert the toolbar still keeps the alternate provider identity; (6) assert the request body uses `deepseek-v4-pro` and not the primary provider's `deepseek-v4-flash`, the reply is normal, final idle and queue=0.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-07-A | `deepseek-v4-pro` under the alternate provider can be selected | The menu shows the alternate provider's model, not the primary's `deepseek-v4-flash` |
| P0-07-B | Before sending, currentValue keeps alternate provider id + `deepseek-v4-pro` | Provider identity and model did not degrade |
| P0-07-C | After sending, currentValue still keeps alternate provider id + `deepseek-v4-pro` | Config was not overwritten by the primary after session creation |
| P0-07-D | First-send request uses `deepseek-v4-pro` and contains the user input | Cross-provider selection really affects the runtime request model |
| P0-07-E | Assistant replies and returns to idle, queue=0 | The chain closes fully |

Fixture contract: common contract, marker `E2E_SAME_MODEL_PROVIDER_IDENTITY`; the request assertion verifies `model=deepseek-v4-pro`.

Verification outcome (2026-07-02): promotion (dry run and apply), fixture check, strict replay (alternate currentValue exactly `e2e-upstream-alt/deepseek-v4-pro`; log `model_name=e2e-upstream-alt/deepseek-v4-pro`, `model_provider=e2e-upstream-alt`) and default replay passed. Docker admission not executed.

## P0-08: Switch model before the running queue is consumed; auto drain uses the latest provider config

| Field | Content |
| --- | --- |
| Catalog | `N02`, `I03` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-model-switch-queue.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-switch-queue.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-queue.json` |
| Status | already on the formal path; fixture check and strict/default replay done in the top10 round |

Scenario: the first request of a desktop local session keeps streaming; while running the user types a second text, forming a queue. Before the queue item is consumed the user switches the chat box to the secondary model and secondary thought level. The in-flight first request must not be rewritten; the new request started by queue auto drain must use the session's latest model config.

Steps: (1) start the local default workspace; (2) select the primary model and primary thought level; (3) send a slow-stream request with `E2E_MODEL_SWITCH_QUEUE_RUNNING` to stably enter streaming; (4) type a second plain text with `E2E_MODEL_SWITCH_QUEUE_AUTO_DRAIN` and confirm it enters the queue; (5) before queue consumption switch to the secondary model and thought level; (6) wait for the queue to auto drain; (7) assert the queued request uses the secondary model and thought level, final idle, queue=0.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-08-A | The running first round keeps streaming | Stably creates the switch-before-consume window |
| P0-08-B | The second text enters the queue | The later request is not sent directly |
| P0-08-C | After switching to secondary model/thought the queue is consumed | Switching does not stall the local queue |
| P0-08-D | Queued request uses the secondary model | The queued turn reads the latest session config |
| P0-08-E | Queued request uses the secondary thought level | The provider parameter is updated, not only the model name |
| P0-08-F | Final idle, queue=0 | The chain closes fully |

Fixture contract: `upstream-model-switch-queue-running-slow` is a controlled-stream synthetic fixture that stabilizes the running window; `upstream-model-switch-queue-auto-drain-secondary` is the fixed reply of the queued turn, the business assertion being the model/thought in the request capture; `upstream-model-switch-slow-marker-contract` only lets the fixture checker cover the generic slow-stream marker.

Verification outcome (2026-07-02): fixture check, strict replay (1 spec / 2 cases passed; `running 中 queued text 消费前切模型，auto drain 应使用 secondary 配置` passed; the queued turn used the secondary model/thought) and default replay passed. Docker admission not executed.

## P0-09: After stop, switch model on the held queue and send now; the request uses the latest provider config

| Field | Content |
| --- | --- |
| Catalog | `M07h`, `N02`, `I03` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-model-switch-queue.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-switch-queue.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-queue.json` |
| Status | already on the formal path; fixture check and strict/default replay done in the top10 round |

Scenario: the first request of a desktop local session keeps streaming; the user types a second text forming a queue, then clicks stop. After stop the queue item stays held in the queue and must not secretly start a request. The user switches to the secondary model and thought level and clicks "send now" on the queue head. The clicked queue item must be sent with the latest secondary config.

Steps: (1) start the local default workspace; (2) select the primary model and thought level; (3) send a slow-stream request with `E2E_MODEL_SWITCH_HELD_RUNNING` to stably enter streaming; (4) type a second plain text with `E2E_MODEL_SWITCH_HELD_SEND_NOW`, confirm it enters the queue; (5) click stop, confirm streaming exits and the queue remains; (6) within a short window confirm the held marker was not sent early; (7) switch to the secondary model and thought level; (8) click send-now on the queue head; (9) assert the send-now request uses the secondary model and thought level.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-09-A | The running first round keeps streaming | Stably creates the stop + held queue window |
| P0-09-B | The second text enters the queue | The held item exists |
| P0-09-C | After stop streaming exits and the queue is kept | Stop did not delete the queue by mistake |
| P0-09-D | The held marker sends no request after stop | Consumption must be triggered by "send now" |
| P0-09-E | Send-now on the queue head consumes the right item | The wrong queue item was not consumed |
| P0-09-F | The send-now request uses the secondary model/thought | Send-now reads the latest session config |

Fixture contract: `upstream-model-switch-held-running-slow` is a controlled-stream synthetic fixture that stabilizes the pre-stop queue; `upstream-model-switch-held-send-now-secondary` is the fixed reply of the send-now turn, the business assertion being model/thought in the request capture. The same spec covers P0-08 and P0-09; strict replay must depend only on common + `conversation-session-model-switch-queue.json`.

Verification outcome (2026-07-02): fixture check, strict replay (1 spec / 2 cases passed; `stop 后 held queue 切模型再立即发送，应使用 secondary 配置` passed; the held marker made no request after stop and used the secondary model/thought after "send now") and default replay passed. Docker admission not executed.

## P0-10: After completion switch model; later edit/fork requests use the latest provider config

| Field | Content |
| --- | --- |
| Catalog | `N03`, `N04` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-model-switch-edit-fork.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-switch-edit-fork.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-edit-fork.json` |
| Status | promoted to the formal path, strict/default replay done |

Scenario: a desktop local session is already completed; in the same session the user switches to the secondary model and thought level. Then two frequent history operations: (1) edit an old user query and resubmit the rerun; (2) fork a completed assistant message and send a follow-up in the derived session. Verifies that completed-history operations use "the current session provider config at the time of the action", not the primary config at the original message's creation.

Steps: (1) start the local default workspace; (2) select primary model/thought, send `E2E_MODEL_SWITCH_EDIT_SOURCE`, wait for completed; (3) switch to the secondary model/thought; (4) edit the old user query to `E2E_MODEL_SWITCH_EDIT_RERUN`, after submit assert the rerun request uses the secondary config; (5) new task, select the primary config, send `E2E_MODEL_SWITCH_FORK_SOURCE`, wait for completed; (6) switch to the secondary config, click fork on the assistant message; (7) wait for the derived session idle with queue=0, send `E2E_MODEL_SWITCH_FORK_FOLLOWUP`; (8) assert the post-fork follow-up request uses the secondary config.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-10-A | Edit source completes with the primary config | Establishes the completed-history baseline |
| P0-10-B | After completion the toolbar can switch to the secondary model/thought | The session config is updated before the action |
| P0-10-C | Edit rerun request uses the secondary model | Edit does not reuse the old turn's model snapshot |
| P0-10-D | Edit rerun request uses the secondary thought level | Provider parameters follow the config |
| P0-10-E | After fork the derived session is idle with queue=0 | Fork does not copy the parent queue nor continue the original task |
| P0-10-F | The fork-derived session toolbar inherits the secondary config | Fork inherits the current session config |
| P0-10-G | Fork follow-up request uses the secondary model/thought | The derived session's later requests use the inherited config |

Fixture contract: common contract; the edit branch has `edit-source` and `edit-rerun-secondary` main fixtures, the fork branch has `fork-source` and `fork-followup-secondary`; matchers must separate source/rerun/follow-up by different markers so a source fixture cannot preempt a rerun or follow-up.

Verification outcome (2026-07-02): promotion, `typecheck:e2e`, fixture check, strict replay (edit rerun and fork follow-up both used the secondary model/thought; the fork-derived session idle with queue=0) and default replay passed. Docker admission not executed.

## P0-11: GLM-5.2 OpenAI-compatible thinking-level request fields

| Field | Content |
| --- | --- |
| Catalog | `I14` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-glm52-reasoning-request-shape.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-glm52-reasoning-request-shape.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-glm52-reasoning-request-shape.json` |
| Status | promoted, formal-path replay case |

Scenario: in the desktop local default workspace the user adds a custom OpenAI-compatible provider with model ID `GLM-5.2`, Base URL pointing to the local replay server and an E2E dummy API Key. Back in the chat box the user selects `GLM-5.2` under that provider, picks the `max` thinking level and sends plain text; after round one the user switches the level to `nothink` and sends a second plain text. Verifies that the thinking intensity of GLM-5.2 maps directly to the top-level `reasoning_effort`, where the UI level `nothink` maps to the provider value `none`. Only the positive contract "UI selection -> session config -> agent providerOptions -> OpenAI-compatible request body"; no real BigModel/Z.AI online service availability; no crossing with queue, stop, edit/fork, remote or compact.

Steps: (1) prepare E2E app data, start the local default workspace; (2) add a custom provider on the settings page, API format `openai-chat-completions`, model `GLM-5.2`; (3) back in the chat box select `GLM-5.2` under the new provider; (4) select the `max` level; (5) send plain text with `E2E_GLM52_REASONING_MAX` and wait for completion; (6) select `nothink`; (7) send plain text with `E2E_GLM52_REASONING_NOTHINK` and wait for completion.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-11-A | The new provider is saved as OpenAI-compatible / Chat Completions and contains the `GLM-5.2` model | The case's provider precondition is right, not a misused default DeepSeek/Anthropic provider |
| P0-11-B | The chat model list selects `GLM-5.2` by the new provider's identity | The model comes from the target provider, not a bare name or another provider |
| P0-11-C | After selecting `max` the toolbar/store thinking level is `max` | The session config is updated before sending |
| P0-11-D | The `max` first-send request path is `/chat/completions`, body `model=GLM-5.2` and contains the user marker | The request goes through the OpenAI-compatible Chat Completions transport and the prompt is not lost |
| P0-11-E | The `max` first-send request writes top-level `reasoning_effort=max` | GLM-5.2 depth maps to the right provider-visible field |
| P0-11-F | The `max` round-one assistant reply visible, after completion `idle && queue=0` | The replay response is consumed correctly and the chain closes |
| P0-11-G | After switching to `nothink` the toolbar/store level is `nothink` | Turning off thinking is really written to config, not just a visible menu item |
| P0-11-H | The `nothink` request still uses the same provider/model and the body contains the second marker | After completion in the same session a level switch affects only later requests and keeps provider identity |
| P0-11-I | The `nothink` request writes top-level `reasoning_effort=none` with no leftover `max/high` | The UI off level maps to the provider's canonical `none` |
| P0-11-J | The round-two assistant reply visible, after completion `idle && queue=0` | The no-thinking request completes fully with no residual busy or queue |

Fixture contract: the title-generation request uses a `common` synthetic response, and its matcher also verifies that the GLM-5.2 title sidecar writes top-level `reasoning_effort=none` with no `extra_body`, `chat_template_kwargs` or `thinking`. The `max` and `nothink` main requests each have a `main` synthetic fixture whose matcher contains `E2E_GLM52_REASONING_MAX` / `E2E_GLM52_REASONING_NOTHINK`. Main responses use the OpenAI Chat Completions SSE shape so an Anthropic Messages SSE shortcut does not pollute transport semantics. Formal replay depends only on `common.json` and the case fixture.

Verification outcome: the 2026-07-02 run belonged to the old wrapper contract (`extra_body.chat_template_kwargs`) before the canonical direct-field switch and is historical only (it also found and fixed that `openaiCompatible.extra_body` did not enter the SDK provider namespace; the Docker run failed at pulling `docker.io/docker/dockerfile:1.7` with a TLS handshake timeout, a Docker Hub network issue ignored by agreement). Current direct-field regression (2026-07-22): fixture check and strict replay passed (1 case); P0-11-A to P0-11-J are covered; the main requests `max` / `nothink` generate top-level `reasoning_effort=max` / `reasoning_effort=none`, the title sidecar generates `reasoning_effort=none`, none contains `extra_body` or `chat_template_kwargs`, and both main rounds end `idle && queueCount=0`. The desktop E2E uses `apps/zcode-cli/packages/cli/dist/zcode.cjs`, so the agent bundle must be rebuilt (`pnpm --filter @zcode/adapters build && pnpm --filter @zcode/cli build`) before formal replay verifies the latest adapter behavior. Docker admission is not executed because of the network issue.

## P0-12: DeepSeek V4 OpenAI-compatible thinking-level request fields

| Field | Content |
| --- | --- |
| Catalog | `I15` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-deepseek-v4-reasoning-request-shape.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-deepseek-v4-reasoning-request-shape.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-deepseek-v4-reasoning-request-shape.json` |
| Status | promoted, formal-path replay case |

Scenario: in the desktop local default workspace the user adds a case-local custom DeepSeek OpenAI-compatible provider with target model `deepseek-v4-flash`, Base URL pointing to the local replay server and an E2E dummy API Key. The model record saved by the form carries no reasoning metadata; the user selects the model under that provider from the chat-box list and sends first with the Agent resolver's default `max`. After round one completes and the session projection is established, the user switches the thinking level to `high` and sends a second plain text. Verifies that the thinking intensity of DeepSeek V4 is a provider parameter on the OpenAI-compatible Chat Completions request: the depth value goes into top-level `reasoning_effort` while top-level `thinking.type=enabled` keeps thinking on. Not covered: GLM-5.2 `reasoning_effort=none`, Anthropic-compatible `thinking.budget_tokens`, real DeepSeek online availability, crossing with queue, stop, edit/fork, remote or compact.

Steps: (1) prepare E2E app data, start the local default workspace; (2) add a custom provider on the settings page, API format `openai-chat-completions`, model `deepseek-v4-flash`; (3) in the chat box select `deepseek-v4-flash` under the new provider; (4) send plain text with `E2E_UPSTREAM_V4_REASONING_MAX` directly, verifying the Agent resolver default `max`; (5) wait for round one and the authoritative session projection; (6) select the `high` level; (7) send plain text with `E2E_UPSTREAM_V4_REASONING_HIGH` and wait for completion.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-12-A | Default local workspace open, chat view interactive | Starts from a real desktop entry |
| P0-12-B | The new provider is saved as OpenAI-compatible / Chat Completions and contains `deepseek-v4-flash` | The precondition is right, not the default Anthropic-compatible DeepSeek provider |
| P0-12-C | The chat model list selects `deepseek-v4-flash` by the new provider's identity | The model comes from the target provider |
| P0-12-D | With no reasoning metadata injected in the form, the first-send request path is `/chat/completions`, body `model=deepseek-v4-flash` and contains the `MAX` marker | The request goes through the target custom provider's OpenAI-compatible transport and consumes the Agent resolver default |
| P0-12-E | The default first-send request writes top-level `reasoning_effort=max` and `thinking.type=enabled` | The default DeepSeek V4 level maps to the right provider-visible fields |
| P0-12-F | The default first-send request has no `extra_body` or `chat_template_kwargs` | The case covers the canonical direct-field contract |
| P0-12-G | The `max` round-one reply visible, after completion `idle && queue=0` | The replay response is consumed and the chain closes |
| P0-12-H | After the projection is established, switching to `high` makes the toolbar/store level `high` | The explicit selection is written to the session config |
| P0-12-I | The `high` request still uses the same provider/model and the body contains the `HIGH` marker | Switching level after completion affects only later requests and keeps provider identity |
| P0-12-J | The `high` request writes top-level `reasoning_effort=high` and `thinking.type=enabled` | Explicit high really overrides the default max |
| P0-12-K | The `high` request has no leftover `reasoning_effort=max`, no `extra_body` or `chat_template_kwargs` | Depth switching does not cross levels or fall back to the wrapper |
| P0-12-L | The round-two reply visible, after completion `idle && queue=0` | The high request also completes fully |

Fixture contract: the common contract with a `main` synthetic fixture each for `high` and `max` (matchers containing `E2E_UPSTREAM_V4_REASONING_HIGH` / `E2E_UPSTREAM_V4_REASONING_MAX`); main responses use the OpenAI Chat Completions SSE shape.

Verification outcome: the 2026-07-02 run belonged to the old wrapper contract (`extra_body.thinking.type`) and is historical only (Docker run failed at pulling `docker.io/docker/dockerfile:1.7`, a network issue ignored by agreement). Current direct-field regression (2026-07-22): fixture check and strict replay passed (1 case); P0-12-A to P0-12-L are covered; the custom provider without reasoning metadata uses the default `max` for the first send and later switches to `high`; the two rounds generate top-level `reasoning_effort=max/high` and `thinking.type=enabled`, neither contains `extra_body` or `chat_template_kwargs`, and the end state is `idle && queueCount=0`. Docker admission is not executed because of the network issue.

## P0-13: Claude Anthropic Messages fixed-budget thinking-level request fields

| Field | Content |
| --- | --- |
| Catalog | `I16` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-claude-anthropic-reasoning-budget.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-claude-anthropic-reasoning-budget.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-claude-anthropic-reasoning-budget.json` |
| Status | promoted, formal-path replay case |

Scenario: in the desktop local default workspace the user adds a case-local custom Anthropic Messages provider with target model `claude-sonnet-4`, Base URL pointing to the local replay server started by this case and an E2E dummy API Key. The user selects the model under that provider from the chat-box list, picks the `low` thinking level and sends plain text; after round one the user switches the level to `xhigh` and sends a second plain text. Verifies that the fixed-budget thinking intensity of Claude-family models is a provider parameter on the Anthropic Messages request: `thinking.type=enabled`, `thinking.budget_tokens` and `output_config.effort` must change with the level. Not covered: OpenAI-compatible `reasoning_effort`, GLM-5.2 `chat_template_kwargs`, real Anthropic online availability, crossing with queue, stop, edit/fork, remote or compact.

Steps: (1) start this case's local replay server and write the dummy key, Base URL and capture artifact into the E2E environment; (2) prepare E2E app data, start the local default workspace; (3) add a custom provider on the settings page, API format `anthropic-messages`, model `claude-sonnet-4`; (4) in the chat box select `claude-sonnet-4` under the new provider; (5) select `low`; (6) send plain text with `E2E_CLAUDE_ANTHROPIC_REASONING_LOW` and wait for completion; (7) select `xhigh`; (8) send plain text with `E2E_CLAUDE_ANTHROPIC_REASONING_XHIGH` and wait for completion.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-13-A | The new provider is saved as Anthropic Messages format and contains `claude-sonnet-4` | The precondition is right, not a misused OpenAI-compatible provider |
| P0-13-B | The chat model list selects `claude-sonnet-4` by the new provider's identity | The model comes from the target provider |
| P0-13-C | The `low` request uses `/messages`, body `model=claude-sonnet-4` and contains the user marker | The request goes through the Anthropic Messages transport and the prompt is not lost |
| P0-13-D | The `low` request writes `thinking.type=enabled`, `thinking.budget_tokens=4000`, `output_config.effort=low` | The low level maps to the right provider-visible fields |
| P0-13-E | The `low` request has no `reasoning_effort`, `extra_body` or `chat_template_kwargs` | The Anthropic contract is not polluted by OpenAI-compatible fields |
| P0-13-F | The `xhigh` request still uses the same provider/model and the body contains the second marker | After completion in the same session a level switch affects only later requests and keeps provider identity |
| P0-13-G | The `xhigh` request writes `thinking.budget_tokens=32000`, `output_config.effort=xhigh` | xhigh really overrides the previous low |
| P0-13-H | Both rounds' replies visible, after completion `idle && queue=0` | The replay response is consumed correctly, no residual busy or queue |

Fixture contract: common contract with `main` synthetic fixtures for `low` and `xhigh` (matchers containing `E2E_CLAUDE_ANTHROPIC_REASONING_LOW` / `E2E_CLAUDE_ANTHROPIC_REASONING_XHIGH`); main responses use the Anthropic Messages SSE shape. Formal replay: the spec starts its own case-local replay server and loads only `common.json` and the case fixture.

Verification outcome (2026-07-02): `typecheck:e2e`, fixture check and strict replay passed (1 case). The `low` body had `thinking.type=enabled`, `thinking.budget_tokens=4000`, `output_config.effort=low`; the `xhigh` body had `thinking.budget_tokens=32000`, `output_config.effort=xhigh`; neither wrote OpenAI-compatible or GLM-specific fields; both ended `idle`, queue 0. Docker admission not executed because of the network issue.

## P0-14: GPT OpenAI-compatible `reasoning_effort` request field

| Field | Content |
| --- | --- |
| Catalog | `I17` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-gpt-openai-compatible-reasoning-effort.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-gpt-openai-compatible-reasoning-effort.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-gpt-openai-compatible-reasoning-effort.json` |
| Status | promoted, formal-path replay case |

Scenario: in the desktop local default workspace the user adds a case-local custom OpenAI-compatible provider with target model `gpt-5`, Base URL pointing to this case's own local replay server and an E2E dummy API Key. The user selects the model under that provider, picks `low` and sends plain text; after round one the user switches to `xhigh` and sends a second plain text. Verifies that GPT-family models under the OpenAI-compatible Chat Completions transport express thinking intensity only through top-level `reasoning_effort`. Not covered: DeepSeek V4 top-level `thinking.type`, GLM-5.2 `reasoning_effort=none`, Claude `thinking/output_config`, real OpenAI or compatible vendor online availability.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-14-A | The new provider is saved as OpenAI-compatible / Chat Completions and contains `gpt-5` | Precondition provider facts are right |
| P0-14-B | The chat model list selects `gpt-5` by the new provider's identity | Selection does not degrade into a bare model name |
| P0-14-C | The `low` request path is `/chat/completions`, body `model=gpt-5` and contains the user marker | The request goes through the OpenAI-compatible transport and the prompt is not lost |
| P0-14-D | The `low` request writes only `reasoning_effort=low`, not `thinking`, `output_config`, `extra_body` or `chat_template_kwargs` | The GPT contract is not polluted by adjacent provider fields |
| P0-14-E | After switching to `xhigh` the round-two request writes `reasoning_effort=xhigh` and still no adjacent provider fields | The level switch really overrides the previous low and does not cross provider semantics |
| P0-14-F | Both rounds' replies visible, after completion `idle && queue=0` | The replay response is consumed correctly, no residual busy or queue |

Fixture contract: common contract with `main` synthetic fixtures for `low` and `xhigh` (matchers containing `E2E_GPT_OPENAI_REASONING_LOW` / `E2E_GPT_OPENAI_REASONING_XHIGH`); main responses use the OpenAI Chat Completions SSE shape; the spec starts its own case-local replay server and loads only `common.json` and the case fixture.

Verification outcome (2026-07-02): `typecheck:e2e`, fixture check and strict replay passed (1 case); the `low` body had `reasoning_effort=low` and the `xhigh` body `reasoning_effort=xhigh`, neither wrote DeepSeek, GLM or Claude-specific fields, both ended `idle`, queue 0. Docker admission not executed because of the network issue.

## P0-15: Opus 4.7 Anthropic Messages adaptive-thinking request fields

| Field | Content |
| --- | --- |
| Catalog | `I18` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-opus47-anthropic-adaptive-reasoning.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-opus47-anthropic-adaptive-reasoning.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-opus47-anthropic-adaptive-reasoning.json` |
| Status | promoted, formal-path replay case |

Scenario: in the desktop local default workspace the user adds a case-local custom Anthropic Messages provider with target model `claude-opus-4-7`, Base URL pointing to this case's own local replay server and an E2E dummy API Key. The user selects the model under that provider, picks `medium` and sends plain text; after round one the user switches to `max` and sends a second plain text. Verifies that an adaptive-thinking model such as Opus 4.7 does not reuse the Sonnet fixed-budget contract: the Anthropic Messages request must contain only `thinking.type=adaptive` and `output_config.effort`, and no `thinking.budget_tokens`. Not covered: OpenAI-compatible `reasoning_effort`, DeepSeek V4 top-level `thinking.type`, GLM-5.2 `reasoning_effort=none`, real Anthropic online availability.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-15-A | The new provider is saved as Anthropic Messages and contains `claude-opus-4-7` | Precondition provider facts are right |
| P0-15-B | The chat model list selects `claude-opus-4-7` by the new provider's identity | Selection does not degrade into a bare model name |
| P0-15-C | The `medium` request path is `/messages`, body `model=claude-opus-4-7` and contains the user marker | The request goes through the Anthropic Messages transport and the prompt is not lost |
| P0-15-D | The `medium` request writes `thinking.type=adaptive`, `output_config.effort=medium`, and no `thinking.budget_tokens` | The medium level uses the adaptive thinking contract |
| P0-15-E | After switching to `max` the round-two request writes `thinking.type=adaptive`, `output_config.effort=max`, still no `thinking.budget_tokens` | The level switch really overrides the previous medium and does not cross into the fixed-budget contract |
| P0-15-F | Neither round writes `reasoning_effort`, `extra_body` or `chat_template_kwargs` | The Anthropic adaptive contract is not polluted by adjacent provider fields |
| P0-15-G | Both rounds' replies visible, after completion `idle && queue=0` | The replay response is consumed correctly, no residual busy or queue |

Fixture contract: common contract with `main` synthetic fixtures for `medium` and `max` (matchers containing `E2E_OPUS47_ANTHROPIC_REASONING_MEDIUM` / `E2E_OPUS47_ANTHROPIC_REASONING_MAX`); main responses use the Anthropic Messages SSE shape; the spec starts its own case-local replay server and loads only `common.json` and the case fixture.

Verification outcome (2026-07-02): `typecheck:e2e`, fixture check and strict replay passed (1 case); the `medium` body had `thinking.type=adaptive`, `output_config.effort=medium` and the `max` body `thinking.type=adaptive`, `output_config.effort=max`; neither wrote `thinking.budget_tokens` nor OpenAI-compatible, DeepSeek or GLM-specific fields; both ended `idle`, queue 0. Docker admission not executed because of the network issue.

## P0-16: Same-name model draft default does not bounce back across provider identity

| Field | Content |
| --- | --- |
| Catalog | `I22` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-same-model-draft-provider-identity.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-same-model-draft-provider-identity.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-same-model-draft-provider-identity.json` |
| Status | manual-review pending candidate case |

Scenario: in the desktop local default workspace the user builds, for each of `glm-5.2` and `deepseek-v4-flash`, a primary and an alternate custom provider; the two providers of the same model use different Base URLs. For each model family a session is first completed with the primary provider; then new task opens an empty draft, the user selects the same-name model under the alternate provider in the chat-box list and sends plain text. Pins the workspace-default echo boundary and the real request routing: after the draft default model is written, toolbar `currentValue`, the selected state of the reopened model menu and the workspace draft config must keep the alternate provider id + current model; the post-send provider request URL must also hit the alternate provider's Base URL and not bounce back to the previous provider just because the same workspace still has an active session. Not covered: queue, stop, edit/fork, remote workspace, real BigModel/Z.AI/DeepSeek availability.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-16-A | `glm-5.2` and `deepseek-v4-flash` each have a primary/alternate case-local provider, with different Base URLs for the same model | Reproduces the same-modelId cross-provider trigger and lets the request URL distinguish vendors |
| P0-16-B | Each model family first completes round one with the primary provider and leaves an active session | Reproduces a state in which the workspace state builder sees an active session |
| P0-16-C | After new empty draft select the same-name model under the alternate provider | Covers the real chat-box model menu selection path |
| P0-16-D | Toolbar `data-model-current-value` keeps the alternate provider/model encoding | The UI does not echo back to the old provider by bare modelId |
| P0-16-E | Reopening the chat-box model menu, the alternate provider group and the same-name model item are still selected | Directly covers the reported problem "model list shows the previous model provider" |
| P0-16-F | The model currentValue of the workspace draft configOptions keeps the alternate provider/model encoding | The protocol echo did not rewrite the workspace-default state to the active session runtime model |
| P0-16-G | After selecting the alternate provider and sending plain text, the real request URL hits the alternate provider Base URL | Not only the UI display is right, the runtime request also switched to the target vendor |

Fixture contract: the title-generation request is a `common` synthetic fixture that only stabilizes the session title. `glm-5.2` and `deepseek-v4-flash` each have primary-seed and alternate-send `main` synthetic fixtures with stable `E2E_*_PRIMARY` / `E2E_*_ALTERNATE` markers in the matchers. The alternate draft switch itself must produce no provider request; the post-switch send request is the real routing assertion entry and must verify that `record.url` hits the alternate provider Base URL. The spec is in `manual-review/pending` and is promoted through the promotion flow after human review.

## 2026-07-22 I62 / I64 planning confirmation

The user confirmed to fill in bugfix E2E in audit-priority order, keeping the catalog's accepted product semantics and pruning. This batch handles only I62 and I64; the two cases share the custom OpenAI-compatible/replay helper but are not merged into one scenario: the former is a modelId encoding invariant, the latter a provider registry cold-start timing invariant.

```text
I62: select OpenRouter modelId(:free)
       -> toolbar currentValue
       -> V4 draft intent
       -> provider request.model(:free)

I64: Personal Config(custom GLM)
       -> Host Process Registry ready
       -> Worker Process Registry ready
       -> V4 createSession(custom GLM)
       -> first prewarm projection / toolbar / request = custom GLM
                                      X no DeepSeek fallback preference write
```

Pruning: I62 runs only desktop local empty draft, a single custom OpenRouter provider and a single first send, without crossing thought, queue, fork, restart, remote, theme or locale. I64 runs only desktop local `desktop-continuous` cold-restart draft prewarm and does not repeat settings-page delete/disable (I61), existing-session recovery (I40) or remote shared-host combinations. The protocol-call readiness gate of I64 is proven by Process Registry focused tests; the Desktop E2E adds the first observable projection, toolbar, localStorage and the real Provider request, without a Renderer mock faking Host/Worker timing.

## P0-17: OpenRouter modelId containing a colon stays intact end to end

| Field | Content |
| --- | --- |
| Catalog | `I62` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-openrouter-model-id-colon.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-openrouter-model-id-colon.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-openrouter-model-id-colon.json` |
| Status | manual-review pending candidate case |

Scenario: in the desktop local default workspace the user adds a case-local custom OpenRouter provider whose model ID is fixed as `nvidia/nemotron-3-ultra-550b-a55b:free`, then selects that model from the chat toolbar by provider identity and sends the first plain text. `:` is part of the model ID; only `$` can express the ZCode configOptions variant separator.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-17-A | The provider/model saved on the settings page keeps the full `:free` | The upstream catalog did not truncate the modelId first |
| P0-17-B | Toolbar `data-model-current-value` equals the shared encoding of provider + full modelId | The user selection and the renderer intent were not split on `:` |
| P0-17-C | The provider/model of the V4 draft intent is the target provider + full modelId | The renderer intent before the config command did not lose the suffix; the first-send barrier and request then prove the Agent authority converged |
| P0-17-D | The `model` of the first-send `/chat/completions` request body exactly equals the full modelId | The runtime/provider transport finally received the same model identity |
| P0-17-E | The assistant reply is visible and the pane returns to a non-stoppable state | The replay response was fully consumed by the UI |

Fixture contract: the title request reuses `common.json` (not part of the case semantics). The only `main` synthetic fixture matches strictly on the `E2E_OPENROUTER_MODEL_ID_COLON` marker, the request body must contain the full modelId, and the response only stably returns `upstream-e2e-ok`. The spec stays in `manual-review/pending`; the `spec` of the fixture manifest still points at the canonical formal target.

Pending replay verification (2026-07-22): fixture check, E2E TypeScript check and real Electron replay passed (1 spec / 1 case); the actual request and the Agent telemetry model name are both `nvidia/nemotron-3-ultra-550b-a55b:free`. Awaiting human review; not promoted.

## P0-18: Draft prewarm waits for the process provider registry to be ready

| Field | Content |
| --- | --- |
| Catalog | `I64` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-provider-registry-prewarm.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-provider-registry-prewarm.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-provider-registry-prewarm.json` |
| Status | manual-review pending candidate case |

Scenario: first let the versioned Personal Config and the Renderer global last-selected hold a case-local custom GLM-5.2, then fully cold-restart Desktop/Host/Worker. Host and Worker each initialize the Process Registry from the same Environment Config; the V4 `createSession` of the automatic draft prewarm must wait for the Registry to be ready and must not depend on the Host delivering an old Provider Snapshot.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-18-A | Before the cold restart the versioned Personal Config contains the custom GLM | Host and Worker initialize the Registry independently from the same Environment fact |
| P0-18-B | After the cold restart the first observable V4 draft config has `source=prewarm-projection` and provider/model exactly the custom GLM | The prewarm did not first create a session with the runtime default DeepSeek |
| P0-18-C | Toolbar currentValue stays custom provider + GLM-5.2 | The UI authoritative selection did not fall back |
| P0-18-D | The renderer atomic last-selected tuple is still the custom GLM | A transient DeepSeek did not overwrite the user's global preference |
| P0-18-E | The first-send request hits the case-local provider, request body `model=GLM-5.2` | The prewarmed session's real runtime provider/model is right |
| P0-18-F | The assistant reply is visible and the pane returns to a non-stoppable state | The post-cold-start conversation chain closes fully |

Fixture contract: the title request reuses `common.json`. The only `main` synthetic fixture matches strictly on the `E2E_PROVIDER_REGISTRY_PREWARM` marker and requires the request body to contain `GLM-5.2`; the response only stably returns `upstream-e2e-ok`. The Process Registry focused tests keep the initialization-barrier proof; this spec does not replace that evidence with a UI mock. The spec stays in `manual-review/pending`; promote after human confirmation of the real cold-start behavior and artifacts.

Pending replay verification (2026-07-22): fixture check, E2E TypeScript check and real Electron cold-restart replay passed (1 spec / 1 case); the actual model identity in the run log is `e2e-provider-registry-prewarm/GLM-5.2` and the first-send request and UI closing assertions passed. Awaiting human review; not promoted.

## P0-19: Switching model during an ordinary streaming response does not change the current request's usage attribution

| Field | Content |
| --- | --- |
| Catalog | `N16` |
| Spec | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-running-model-switch-usage.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-running-model-switch-usage.json` |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-running-model-switch-usage.json` |
| Status | manual-review pending regression case |

Scenario: an ordinary desktop local conversation starts a request with the primary model. A case-local controlled stream keeps a deterministic window after the provider has received the request; before the response ends the user switches the current session to the secondary model, without sending a second message. The old request then returns a fixed usage, and E2E queries the Agent SQLite `model_usage` of the current session directly.

State and timing contract:

```text
primary request started ── SSE running ─────────────── primary response + usage
                              │                                      │
                              └── session default -> secondary       └── usage.model = primary
```

| ID | Item | Why valid |
| --- | --- | --- |
| P0-19-A | Before the switch the capture shows the primary main request and the session is still streaming | The switch hits the real in-flight provider window, not a UI tail animation |
| P0-19-B | During streaming the model selection successfully becomes secondary | The session's mutable default config is really updated before the old request completes |
| P0-19-C | After completion the provider capture still shows primary | The in-flight request's model identity is immutable |
| P0-19-D | The `main_turn` usage token of the current session equals the fixed fixture value, with provider/model both primary | The usage fact is bound to the model actually executed, not the session default read at request end |

Pruning and fixture contract: the only `main` synthetic fixture uses `controlled-stream` because an online model is not slow enough to create the switch window stably. No queued prompt is sent; the later-request-reads-secondary semantics are covered by `N02/MQ`. Compact and idle tasks have their own execution-model snapshots and are not crossed with this ordinary main-conversation representative case. Stop/cancel/error scenarios with no positive usage are covered by focused core tests; remote/mobile only change delivery/recovery and do not change the invariant `usage.model === request.executionModel`. The spec stays in `manual-review/pending`; the `spec` of the fixture manifest points to the canonical formal target.

Repro and fix verification: on 2026-08-05 a strict replay before the fix showed in the provider capture that the request actually used `e2e-upstream/deepseek-v4-flash`, but the `main_turn` usage of the same session in SQLite was recorded as the post-switch `e2e-upstream/deepseek-v4-pro`, stably reproducing the misattribution. After the fix, the same fixture rerun (1 spec / 1 case passed) attributed usage to `e2e-upstream/deepseek-v4-flash` with a fixed token total of `132`. Still in manual-review pending, awaiting human review before promotion.

## P0-20: Model provider no-model state and add-provider hint

MP-UI-01 also verifies the two-column content-adaptive layout: temporary DOM height probes simulate tall navigation/detail content and, in wide and narrow windows, assert minimum 36rem, equal column heights, no inner scroll, and wheel scrolling driving the outer main. The probes verify CSS geometry only, do not represent provider API data verification, and are removed so the original flow continues.

MR !2618 CR-01: MP-UI-06 uses the real model save-success feedback; it injects long-navigation/long-detail probes and, at 1280x600 and 600x500 windows, asserts at the top/middle/bottom that the feedback lies fully inside the main viewport and the detail column. Feedback state/timeout are unchanged; success and failure share the same positioning container.

| Field | Content |
| --- | --- |
| Catalog | `MP-UI-01`, `MP-UI-02` |
| Spec | `packages/desktop/test/e2e/settings/settings-ui-polish.test.ts` |
| Provider fixture | none; only seeds local settings and provider files, no model request |
| Status | human-reviewed and promoted |

Scenario: part one verifies the footer from the add-custom-provider entry: hint and Info icon on the left, add button on the right, a semantic divider above them; with no model added the button stays disabled. Part two seeds a custom provider with a single model, deletes the last model through the real settings page, and verifies the editor keeps the dashed empty state and the Add Model action. Coding Plan models are synced automatically from the login state and cannot be deleted by hand in settings; its zero-model connection judgment is covered by resolver unit tests and a non-existent E2E operation is not faked.

| ID | Item | Why valid |
| --- | --- | --- |
| P0-20-A | The Add provider footer has `border-t`, the Info icon and the reminder text | The add hint goes through the real settings page |
| P0-20-B | The hint is to the left of the button and the button is disabled with no models | Layout agrees with the existing validation state |
| P0-20-C | A custom provider can delete its last model through the real delete button | The empty state comes from the real editing chain |
| P0-20-D | The dashed empty hint and Add Model are visible together | The user still has a real entry to restore the config |

Pruning: provider requests, chat first send and persistence are covered by P0-02 and are not repeated. The equivalent resolver branches of Z.ai/BigModel and Start/Coding get pairwise coverage in unit tests; the Coding Plan list is server-synced and read-only, so the delete operation of custom providers is not wrongly applied to the plan page. Theme, locale and mobile do not change the connection judgment; semantic tokens, bilingual copy and responsive classes are covered by unit tests.

Verification outcome (2026-08-19): after promotion the formal-path run passed all 3 cases with no manual-review switch; the earlier pre-promotion run also passed all 3 cases.
