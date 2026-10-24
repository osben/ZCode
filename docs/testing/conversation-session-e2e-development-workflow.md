# Conversation Session E2E Development Workflow

Defines the development pipeline for a conversation session from "coverage enumeration" to "formal E2E". The goal is that a new case advances through fixed steps, with no ad-hoc edits of shared replay fixtures at promotion time and no waiting through long E2E runs only to find a data mismatch.

## Two pipelines

### Coverage generation

Coverage generation answers "what needs testing":

1. Extract state dimensions from the feature spec, the existing case catalog and the coverage matrix.
2. Use the `feature-boundary-planner` skill and the formal-proof basis to help enumerate permutations and combinations.
3. Prune in dialogue with product or developers, confirming which combinations are accepted, undefined or pruned.
4. Produce or update `docs/conversation-session-case-catalog.md`, `docs/testing/conversation-session-e2e-coverage-matrix.md` and the related decision documents.

This layer produces only documents and cases to cover, not formal E2E directly.

### E2E landing

E2E landing answers "how to test stably":

1. Write or generate a `manual-review/pending` spec for an accepted case.
2. Run manual/capture, which executes the user path automatically and leaves UI, network, log and session artifacts.
3. A human reviews the product behavior to confirm the case semantics.
4. Curate the provider replay fixture and file fixtures into the formal test contract.
5. Move the spec to `packages/desktop/test/e2e/conversation-session/`.
6. Run the local default replay.
7. To enter a Docker suite, first run a single spec under `replay-isolated`, then register it in the Docker preset.
8. Routine Docker regression runs by suite in batches, reusing the same image, container and WDIO build entry.
9. MR and GitLab Web pipelines run the default replay of the formal directory through a manual optional job: the shared-macOS and dedicated-macOS runner jobs are single-instance, and only the Windows job uses four GitLab/WDIO native shards. All three entries reuse direct-root globs such as `ZCODE_E2E_SPEC=./test/e2e/conversation-session/*.test.ts`; these globs are non-recursive and collect only specs promoted to the formal directory, never `manual-review/pending`.
10. Docker CI collects only suites that are already stably automated.

The default Desktop full entry excludes candidates uniformly by a `manual-review` directory at any level, not by enumerating known domains, or a new bots/settings/feedback directory would be wrongly collected by the single-process full run. An explicit spec or manual-review mode can still run candidates; the formal set of the default single process and of shards must be identical, and a candidate lacking the capture environment is not recorded as a formal regression failure.

## Shared initialization contract

### Formal replay contract maintenance (2026-10-15)

- TUI input and Enter run separately: use the terminal paste protocol and wait for this input to be painted; a new animation frame must not be taken as input completed. Command completion waits for its explicit receipt; incremental terminal painting may output only the changed suffix of placeholder text, and the full placeholder is not required to repeat.
- A provider may merge adjacent system messages; an incoming reminder is verified on the wire for full text, role and uniqueness and need not occupy a system text block alone. The user's system-reminder wrapper still requires a complete standalone block and paired tags.
- The project-create helper waits only for the unique empty draft of the main pane; the input of an auxiliary conversation may coexist and does not count in the main-pane switch decision.
- Marketing touch is a global app UI: the isolated fixture presets an account that has completed occupation onboarding, so the startup dialog cannot steal onboarding focus; after cold start wait for the app-settings entry to be ready and do not require activating a fixed project. When the window is restored to an unselected-project draft, a fixed-cwd wait wrongly terminates beforeEach and the whole marketing suite cannot continue.
- The Coding Plan data-plane proxy starts per the current worker's spec, after the upstream replay network configuration and before HOME seeding. In a mixed batch containing ToolSearch, only the ToolSearch worker uses its own capture proxy; it must not turn off the account model replay of other workers.
- Team Providers share a Provider ID and model-menu items are grouped by the full team connection identity; dedicated helpers get the connection key from the fixture and must not still locate a team row via `registry-provider:<id>`. A blank Composer does not save an uncommitted re-selection; when verifying an uncommitted selection across tasks or restart, keep a non-empty text draft.
- After the Plugin mention icon moved to CSS decoration variables, read the actual URL of `--mention-image` and no longer look for the removed child `img`. The store trial creates a separate draft, so later fixed-cwd cases must re-prepare the fixture project.
- Test app artifacts must be independent of the shared `out`: use copy-on-write (normal copy when the filesystem does not support it), never hard links. If the source build is overwritten in place by `tsc -b`, or a single isolated copy is written by a test, other replay copies must stay unchanged. After the typecheck, re-run the E2E build; do not reuse the Host entry overwritten by TypeScript emit.
- The I68 case must explicitly provide the four-level reasoning Option Spec and the request protocol mapping; it no longer relies on the retired Agent catalog completion. The model editor's inheritance test removes the generic replay's exact `disabled` override, keeps the current recommended configuration, and explicitly expands the advanced section on each reopen.
- Reasoning Option Spec `values` are ordered low to high; the last item is the default highest level when the model is switched actively; the I20 fixture explicitly provides the `off/low/high/max` it asserts and must not follow the old default-value-first rule. The coverage test of the official-plugin read-only profile uses the current `documents:visual-judge` and no longer looks for the retired `document-skills:judge`.
- After a Subagent save, the form closes first and then the list refreshes asynchronously. Re-editing must wait for the row to restore `role="button"`, not click as soon as the row exists, while it is still refreshing and has no edit handler bound.
- Formal settings cases match entries by stable identity: I23/I24 create a Personal Provider from the BigModel Template and check API Key and model hydration by the new instance ID, and do not query the retired Family API Key connection item. Subagent scope is chosen by `data-plugin-scope-key` as `user` or the target workspace key; the display name contains device information, so a bare project name cannot be used to judge identity. The formal MCP case reuses the V4 initialization and keeps real Agent negotiation and wire assertions.
- Background-task telemetry collection resets the HTTP mock and ARMS buffer per case; a cursor must not be reused across cases, or an intermediate case without telemetry assertions is counted into the next case's exact-count assertion.
- Background-task row visibility uses the browser-native `checkVisibility`. V4's `display: contents` ancestors have no layout box of their own but do not hide children; requiring each ancestor to have a non-zero rectangle would mistake a visible running/stop control for disappeared.

Test data prepared for a formal case must satisfy the current product contract; failures must not be removed by lowering assertions, skipping the case or editing business logic:

- Fixed-directory file, Hook and cold-recovery scenarios keep the cwd through the project's new-task entry; the global new-task still verifies an independent directory; the two entries are not mixed.
- The model preference must be declared in the fixture's `reasoningLevel.values`; a case that verifies request thinking parameters also provides a non-empty Option Map, while ordinary replay keeps an empty map.
- `/plan` is the local action `app-slash:plan`; the formal session identity only requires non-empty and non-draft, not a `sess_` prefix.
- A Markdown selection enters the request as a structured quote; verify the source path and body inside `<conversation_quote>` and the history quote, and no longer require the old `# userselect` wrapper.
- The Bot integration fixture uses the project repository's session-create reservation contract; ToolSearch collects the full body when the real request event arrives and keeps archiving the Adapter's raw Model IO; in-memory event statistics trimmed afterwards cannot be taken as the message body.
- When configuring a Provider on the settings page, first blur the input and check that the connection fields are persisted, then operate the API format menu. Whether a format is selected is decided by the menu's `data-state=checked`; a Personal overlay default may inherit the Template's protocol format, so the old snapshot default must not be used to skip the switch.
- After a Fork the session identity switches first and the model capability projection arrives later; wait for the target capability set to be ready, then assert levels and the real request; an empty set at the switching instant is not the final capability.
- When a batch fails but a single scenario passes, first check the stable boundaries of the preparation, cleanup and navigation owner; do not add fixed waits. Real product exceptions such as permissions keep the original assertion and are listed as blockers.

```text
case directory and model requirements -> project entry / Provider fixture -> current draft ready
                                                   |
                               real user operation -> wire / persistence / UI assertions
```

The preparation step of the default `env` replay Provider chooses `high`, and its Personal Config must declare both `high` / `max` thinking levels; the Composer toolbar case must also declare these two levels under other presets. Do not seed only `disabled` and let the toolbar pick a non-existent option; ordinary replay still uses an empty parameter mapping and injects no real-model thinking parameters into requests.

The Coding Plan mock must start in the launcher's `onPrepare` stage and pass its address to workers via `runnerEnv`. Besides concrete spec names, the selector also recognizes the two supported batch entries `test/e2e/**/*.test.ts` and `test/e2e/conversation-session/*.test.ts`, normalizing path separators and an optional `./` prefix before comparison. Formal CI's directory globs are not yet expanded and cannot rely on a tool name appearing in them. Workers still use or clean the mock environment per concrete spec, and unrelated specs do not enable the mock because of this fix.

```text
launcher receives batch glob -> onPrepare starts mock -> runnerEnv passes the address
                                                |
worker receives concrete spec -> use / clean mock env as needed -> run the case
```

Entry regressions must use a formal-directory glob and narrow the cases with exclude; running only a feature-name glob cannot prove CI's initialization path. This contract concerns only the E2E startup layer and does not change the production implementation.

Project operations in `automations-create-manage` use the current `automation-project-select` and `role=option`. Per [virtual project spec B18](../superpowers/specs/2026-09-09-virtual-project-design.md), candidates come from local virtual projects, no longer from the conversation draft menu; the isolated fixture should list only `ZCodeProject`. The create, edit, pause, resume and delete assertions are kept, and the old "work outside a project" (「不在项目中工作」) entry is not a precondition of the current form.

Specs under the formal directory use `prepareV4ConversationE2E` to bring the test to a "sendable empty draft"; `manual-review/pending` candidates during migration may still use `prepareConversationE2E`. A promoted spec must not import the legacy `helpers/conversation-session.js`: V4 pane/composer/timeline operations come from `v4-conversation.ts`, tool-block assertions from `conversation-session-tool.ts`, provider-request assertions from `conversation-session-network.ts`. This boundary only converges the formal evidence implementation and does not change the catalog's product state combinations.

Before a formal promotion is merged two more mechanical contracts must hold: the spec's composer, message, queue, runtime-state and task-switch operations may read only the V4 helpers / the split dedicated helpers; and the case manifest's `requests` must mirror the `id` and full `metadata` item by item in the array order of the case-local provider fixture. When a fixture changes matcher order, `kind`, `timingPolicy` or `syntheticReason`, the manifest must be synced in the same commit, so the two replay contracts do not drift apart. `pnpm audit:conversation-session-coverage` is the final admission gate; relaxing the formal admission rules to let a legacy helper or a ledger mismatch into the direct-root suite is not allowed.

`prepareV4ConversationE2E` only brings the test to a "sendable empty draft" and must stay idempotent; the initialization itself must not count as a "new task" product operation. If after workspace cold start or reactivation `activeTaskId=null`, the V4 pane `data-session-id="draft"`, idle and a visible composer already hold, reuse that draft once the provider configuration is done; click new task only when the current pane is still bound to an existing session, on a non-draft page, or the composer does not exist.

Preparation of fixed-file fixtures must also confirm that the navigation owner's cwd is the `ZCodeProject` primary directory and that this precedes Provider initialization. An initial empty draft on that directory is reusable even without a project label; do not create a new one to add the label, which would trigger a pre-warmed owner generation change. Global new task creates an independent directory per virtual project spec D3 and must not be used to initialize a fixed-directory fixture; an existing session, another cwd or a non-empty draft returns to the fixture directory through the existing project row's new-task entry. `skipShellReady` keeps the semantics of the caller preparing its own workspace and does not force selecting the local fixture. An explicit `startNewV4Draft` still clicks the global new-task entry.

The full-access preparation of tool cases reuses `switchV4Mode("yolo")` and confirms the command round-trip from the current V4 composer's `data-mode`; it must not query the old Select option or aggregate other workspaces' config to judge the current permission.

Window-size preparation reuses `setCurrentElectronRendererContentSize`, which picks the window by the current WebDriver URL, sets the content-area size and verifies the renderer viewport against the actual zoom factor. The content area must not be estimated as outer size minus a fixed error. Background-output and background-task responsive cases use an 800px content height, keeping the original wide/narrow breakpoints and scroll assertions, and do not depend on the host display fitting a 900/1000px-tall window.

```text
workspace shell ready -> inspect fixture project draft
                              | empty and idle -> reuse
                              | otherwise -> project New Task
                              v
                         provider setup
                              v
                         recheck draft -> select model and thought level
```

`startNewTask` still denotes an explicit user action in a test step; it must really click the new-task entry and wait for the same draft conditions, and cannot be replaced by the idempotent initialization. Shared helpers prefer V4 test id / pane / renderer store for the composer, send/stop controls, messages and runtime state, with legacy ChatView only as a compatibility fallback. When initialization or explicit new-task fails, the helper must carry the pane/store state, whether the composer exists and the currently visible test ids in the error, so a before hook does not leave only a context-free "element not displayed" timeout. When the V4 pane is a draft, the helper must take `workspaceKey = activeWorkspaceIdentity?.trim() || activeWorkspacePath` from the current window's navigation TabStore and read exactly that bucket, and must not guess among several draft workspaces with `activeTaskId=null`; when the pane is bound to a task, Goal metadata and `stopRequested` must reuse the optimistic/cache read semantics of the task store snapshot and not be faked as empty. This contract adds no case state combination and follows the three confirmed boundaries of the catalog: TSL08 workspace draft, H Goal state and I11 new-task action.

## Data contract

A capture artifact is evidence, not the final test contract. Formal E2E expresses the stable contract with case-local fixtures.

Recommended layout:

```text
packages/desktop/test/e2e/fixtures/upstream/common.json
packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case-name>.json
packages/desktop/test/e2e/fixtures/fs/conversation-session/<case-name>/
packages/desktop/test/e2e/fixtures/cases/conversation-session/<case-name>.json
```

- `upstream/common.json`: auxiliary responses truly reused across cases, e.g. title generation.
- `upstream/conversation-session/<case-name>.json`: a spec's own provider replay data.
- `fixtures/fs/...`: real filesystem input the case needs.
- `fixtures/cases/...`: the case manifest recording the spec, provider fixture, file fixtures, request sources and timing policy.

### Cross-platform runtime path contract

`.e2e-home` is the isolated user directory of Desktop E2E; case files must not be scattered into the system `/tmp`. Files that a spec creates, reads, modifies or waits on at runtime all live under `.zcode-e2e/<case>` inside the workspace `ZCodeProject` where the Agent actually executes:

```text
.e2e-home/ZCodeProject/               Agent workspace cwd
└── .zcode-e2e/<case>/                case-owned runtime files
```

- Node file operations use native absolute paths generated by the shared helper.
- Absolute paths of Read/Write/Edit/Glob/Grep etc. in provider fixtures use `{{e2eRuntimeRoot}}/<case>/...`; the replay server expands the variable before request matching.
- Bash commands use workspace-relative POSIX paths `.zcode-e2e/<case>/...`; relying on `/tmp`, the implicit conversion from a Windows drive to a Git Bash mount, or the user's TEMP directory is forbidden.
- `fileFixtures[].path` of the case manifest uses a workspace-relative path.

```text
spec native path -------------┐
fixture absolute tool path ---┼-> ZCodeProject/.zcode-e2e/<case>/file
Bash relative path -----------┘
```

This contract makes Node/spec, tool execution and the shell barrier point to the same file under macOS, Linux and Windows Git Bash. When adding or changing a conversation E2E, besides the fixture contract check it must pass the bare `/tmp` audit.

The `spec` in the case manifest and the case-local provider fixture always denotes the **canonical formal target**, written as `./test/e2e/conversation-session/<case>.test.ts`. It is not the physical path of the file during the pending phase; the current path is expressed by the coverage matrix and the `--spec` passed to commands. So the fixture contract stays stable from pending to formal, and promotion only moves the spec without rewriting or overwriting fixture content already curated by hand.

```text
manual-review/pending/<case>.test.ts   current file under review
                 | fixture check reads the current file and the canonical fixture contract
                 v
fixture JSON: spec=conversation-session/<case>.test.ts
                 | human review + promotion
                 v
conversation-session/<case>.test.ts   canonical formal target becomes the current file
```

A pure UI case that verifies only renderer interaction such as the input box, menus, keyboard selection and sends no prompt may explicitly write `noProviderRequests: true` in the manifest and keep `requests: []`; the case-local provider fixture may then be empty, expressing "no provider contract" rather than a forgotten fixture.

Loading the legacy `provider-basic.json` / `provider-conversation-tool-cross-product.json` is still allowed during migration, but a new case should not keep appending dedicated responses to the legacy shared pool.

A pure composer, native picker or other formal case that triggers no provider request may keep an empty case-local provider fixture but must explicitly declare `"providerRequestPolicy": "none"` in the manifest and keep `"requests": []`. Such a case still needs `e2e:fixture:check` and a local replay; the declaration only means the spec's stable contract is "no model request" and does not skip formal verification.

## Request classification

Recording may capture everything; when turning it into a fixture, only necessary requests enter the contract.

| Class       | Meaning                                                                                             | Handling                                                         |
| ----------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `main`      | Requests the case's core assertions depend on, e.g. edit rerun, compact summary, goal verifier      | Put into the case-local fixture                                  |
| `common`    | Auxiliary requests stably needed by several cases, e.g. title generation                            | Put into the common fixture                                      |
| `ignore`    | Requests that appear in the capture but are not part of the test contract                           | Not in the case-local fixture; explain in the manifest if needed |
| `synthetic` | Timing/faults that real capture cannot stabilize or construct, e.g. slow stream, broken stream, 429 | Put into the case-local fixture and write `syntheticReason`      |

Tools can suggest classification automatically from markers, paths, prompt content and request order, but product semantics are reviewed by the developer.

## SSE Timing

Different cases use different replay policies, so not every test is slowed by slow streams and performance cases are not washed out by one-shot body replay.

| Policy              | Applicable scenario                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `fast-text`         | Ordinary functional assertions; a fast return suffices                                                                 |
| `controlled-stream` | Cases such as stop, queue, interrupted that need a stable streaming window                                             |
| `recorded-stream`   | Performance, Markdown rendering and stream-rhythm cases that must keep real `responseEvents` / `responseChunkTimeline` |
| `fault-stream`      | Fault injection such as broken stream, half packet, socket destroy                                                     |

Synthetic controlled/fault streams must state the reason. Typical example: the real model is too fast to cover the stop window stably.

Replay capture artifacts belong to the request lifecycle: the `pending` at request start, the normal response terminal state and fail-closed terminal states such as a missing fixture variable must all wait for the matching artifact to be written before the handler returns. If the atomic-replace retry finally fails, the rejection must enter the replay server's unified handler catch; even if the 500 response has already ended, the diagnostic persistence Promise must not be left as a fire-and-forget unhandled rejection. This error path is covered by a focused test with an injectable artifact writer, avoiding a dependence on Windows file-lock race timing. The replay server's startup follows the same lifecycle: if the first artifact write after a successful `listen` fails, startup must first wait for the HTTP listener to close and the current artifact write queue to settle, then rethrow the original write error; a failed fixture initialization must not leave a port or a background server behind.

## Promotion admission

Before a case moves from `manual-review/pending` to the formal path it must at least satisfy:

1. The catalog/matrix already has accepted semantics.
2. The manual/capture artifact has been reviewed, or the synthetic reason is explained in the manifest.
3. The case-local provider fixture and file fixtures are ready.
4. `e2e:fixture:check` passes.
5. The local default replay passes.
6. The document path is updated from pending to the formal spec.

When a pending case already has a case-local fixture, its contract can be checked directly before promotion; the checker reads the markers in the pending spec and requires the `spec` of both fixture JSONs to point at the canonical formal target:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- \
  --spec ./test/e2e/conversation-session/manual-review/pending/<case>.test.ts
```

Pending manual-review chooses the isolation mode by whether the case already has a case-local fixture: replay when a fixture exists, live/capture when it lacks one. To override the fixture set temporarily you can still pass fixture paths explicitly; that variable also switches the provider transport to replay but keeps the `ZCODE_E2E_MANUAL_REVIEW=1` pending-spec run boundary, so replay evidence is not mistaken for real provider capture:

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case>.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec \
  './test/e2e/conversation-session/manual-review/pending/<case>.test.ts'
```

If the case's product semantics are that it triggers no provider request, the manifest must say so with `providerRequestPolicy: "none"`; otherwise an empty case-local fixture cannot be promoted.

Before entering a Docker preset these also hold:

1. Docker `replay-isolated` passes.
2. The artifact path is written into the run record or PR description.
3. A spec under `manual-review/pending` is not added to a Docker preset directly.
4. Use `e2e:docker:admit` to sync the Docker preset and the admission document.

## Skill entry

This document is the landing instance for the conversation session domain; the generic process is carried by two skills:

- `.agents/skills/feature-boundary-planner`: produces the case documents that need coverage from feature changes, matrix, formal-proof and pruning dialogue.
- `.agents/skills/e2e-case-lifecycle`: the stabilization flow from a manual-review spec, capture/replay fixtures, promotion and Docker admission to CI.

## Tooling flow

A reviewed pending case is mechanically promoted with the promotion tool:

```bash
pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/manual-review/pending/<case>.test.ts --reviewed --apply
```

The promotion tool does deterministic scaffolding only:

1. Move the spec from `manual-review/pending` to the formal `conversation-session/` directory.
2. Fix common relative helper imports.
3. Generate an empty case-local provider fixture shell and case manifest shell when missing; an existing fixture keeps its content, and its `spec` must already be the canonical formal target.
4. Update the spec's pending path in the coverage matrix to the formal path.
5. Run `pnpm audit:conversation-session-coverage` inside the same file transaction; the promotion result is kept only when the audit passes.
6. On audit failure or an execution exception, restore the pre-promotion snapshot of the spec, fixture, manifest and coverage matrix with exit code 1, so no formal-admission half state remains.
7. Print the follow-up commands for fixture check, case-local replay, default replay and Docker admission.

The promotion tool does not decide product semantics and does not take a capture artifact directly as the contract. Since `--apply` runs the formal audit inside the promotion transaction, the developer must fill `fixtures` / `requests` in the pending phase according to human review and request classification, and make the `spec` of the manifest and provider fixture both point at the canonical formal target; without an audit pass the promotion does not complete. After promotion run:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/<case>.test.ts

E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case>.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/<case>.test.ts'

pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/<case>.test.ts'
```

The first replay command explicitly loads only the common + case-local fixtures, proving the formal case does not depend on the dedicated fallbacks of the legacy `provider-basic.json`.

Before entering a Docker suite, first run a single-spec offline-container proof:

```bash
E2E_SPEC=./test/e2e/conversation-session/<case>.test.ts \
  pnpm run test:e2e:container
```

After it passes, register it in `conversation-session-verified`:

```bash
pnpm --filter @zcode/desktop e2e:docker:admit -- \
  --spec ./test/e2e/conversation-session/<case>.test.ts \
  --verified \
  --artifact packages/desktop/.e2e-artifacts/<run-id> \
  --apply

pnpm run test:e2e:container:conversation
```

`e2e:docker:admit` only registers mechanically: it updates the `conversation-session-verified` preset in `scripts/test-desktop-e2e-container.sh` and syncs `docs/testing/conversation-session-docker-automation-plan.md`. It does not replace the single-spec Docker proof and does not let a `manual-review/pending` spec enter the suite directly.

Once in a suite, routine regression no longer builds/runs Docker per case. `conversation-session-verified` passes several specs into one WDIO run, reusing the Docker image, container start, desktop app build and agent server build cost. Single-spec Docker runs are kept for admission proof and failure location; cases that are real capture, fault-stream, performance/timing-sensitive, pollute global configuration or depend on special network/filesystem state are split to separate presets or containers.

## Current MVP

The first phase builds only the infrastructure of the E2E landing pipeline:

1. WDIO automatically loads case-local provider fixtures.
2. `conversation-session-edit` is the template moved out of the legacy dedicated fixture.
3. `conversation-session-running-actions` is the second template, covering the combination of a generic read-only tool call, a case-local final response and a controlled slow stream.
4. A seconds-level `e2e:fixture:check` command checks JSON shape, manifest, fixture id and spec marker coverage.
5. `e2e:promote` scaffolding reduces the repetitive work of moving the spec, fixing imports and creating the manifest.
6. `e2e:docker:admit` scaffolding reduces the repetitive work of maintaining the preset and admission document.

Later, capture-to-fixture will convert a capture artifact automatically into a main/common/ignore/synthetic draft for review.

### Current UI and build constraints for formal cases

- The I68 main input box uses the merged model menu and thinking slider; Subagent settings keep a separate level control. Both verify the actual level set and request parameters.
- CTP-02B verifies the Team label inside the avatar menu; the settings batch closes the settings layer left by the previous case before each preparation.
- MP-UI-06 follows Todo141: ID, context and max output are shown by default, advanced configuration is collapsed by default, and after a click expands it, the capability checkboxes, reasoning editing and save are verified.
- The model control of I24 uses the shared custom: codec; the protocol provider/model value is not taken as a UI value, and manual model selection is not used to bypass the automatic hydration assertion.
- CLH-02 injects failure for all setting.json writes on the target Host, so the default single-shot fault is not consumed by an initialization write.
- The shared parent build of a shard does not contain the dynamic web mock origin of child processes. A child that configures a web mock must rebuild after the port is allocated; the shared build lock is held from the build through copying the isolated artifacts. An ordinary child without a mock may reuse the parent build.

```text
child allocates mock port -> acquire build lock -> compile matching origin -> copy isolated artifacts -> release lock -> replay
```
