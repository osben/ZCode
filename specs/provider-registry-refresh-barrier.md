# Provider registry refresh barrier

Status: implemented for `sendConversationCommandV4`, legacy `createSession`, `sendPrompt`, `generateWorkspaceText` and
the provider-ready startup path. The other upstream call sites are reviewed and stay delivery-only (see "Per-site
decisions").

## Problem

A Worker builds its Provider Registry from three layers: ZCode Built-in, Personal (a file it polls about once a second)
and the Account Config overlay the Host delivers. Provisioning or a settings change writes the Personal file without
changing the Account Config revision. The Host then skips delivery (the Worker already acknowledged that revision), so
nothing refreshes the Worker before the next command. A `switchModelConfig` or `sendText` that names the new provider
within the polling window is checked against the old Registry:

- `switchModelConfig` fails with `provider.notInRegistry`;
- a `createSession` that carries the new provider downgrades to runtime defaults with only a warning.

Upstream 3.16.2 closes this window with `requiresProviderRegistryRefresh` and `refreshRegistry: true`. The fork
dropped every upstream `provider/refreshRegistry` call during the 3.16.2 sync to keep an older fork test green. That
was a merge decision, not a product rule, and this spec reverses it where a stale Registry has a real effect.

## Rules

1. Before `sendConversationCommandV4` forwards a command whose type is in `requiresProviderRegistryRefresh`
   (`createSession`, `createSelectionSideSession`, `sendText`, `sendGoalCommand`, `compact`, `forkAssistant`,
   `editUserQuery`, `retryTurn`, `sendQueuedNow`, `switchModelConfig`), the Host waits for the Account Config
   delivery and then for `provider/refreshRegistry` on that client. Both run in the existing per-client serial queue
   (`syncAccountProviderConfigToClient`), so no new barrier or timeout is added.
2. A `createSession` with `submissionPreparation` is a reservation that touches no provider. It is exempt, as it is
   today, so the instant first-submission path keeps its latency (`specs/first-submission-instant-ux.md`).
3. The refresh is sent only when the CLI advertises the runtime capability `providerRegistryRefresh: true`
   (`runtime/capabilities`). A remote CLI can lag the desktop build, and one without the capability keeps today's
   behavior: Account Config delivery only. A failed capability read counts as "not advertised".
4. When the CLI advertises the capability and the refresh fails, the command is rejected and not forwarded (upstream
   semantics: never validate a new provider against a Registry that is known to be stale).
5. Commands outside the list (for example `cancelTurn`, `renameSession`) wait for nothing.
6. The legacy entry points `createSession`, `sendPrompt` and `generateWorkspaceText`, and the provider-ready startup of
   a waiting workspace, take the same barrier through `ensureAccountProviderConfigSynced({ refreshRegistry: true })`,
   with the same capability gate (rule 3) and the same failure rule (rule 4). Startup runs under `Promise.allSettled`,
   so a failed refresh there affects only that workspace's startup notice.
7. `resumeSession`, `testModelConnectivity` and cold `conversation/subscribe` keep Account Config delivery only (see
   "Per-site decisions" for why).

## Owners and order

```
Renderer ──v4/command──▶ Host sendConversationCommandV4
                           │ requiresProviderRegistryRefresh(type) && !submissionPreparation ?
                           │   yes ─▶ per-client serial queue:
                           │            1. provider/updateAccountConfig  (skipped if revision already acked)
                           │            2. provider/refreshRegistry      (only if CLI advertises providerRegistryRefresh)
                           │          failure ─▶ reject the command
                           ▼
                         Worker v4/command (validates against the refreshed Registry)

Host createSession / sendPrompt / generateWorkspaceText / provider-ready startup
                           │ ensureAccountProviderConfigSynced({ refreshRegistry: true })
                           │   same per-client serial queue, same steps 1 and 2, failure ─▶ reject the call
                           ▼
                         Worker session/create · session/send · workspace/generateText
                         (startup has no follow-up request; waiting callers then run their own barrier)
```

- Owner of the Registry: the Worker (`registryService`). The Host never sends Registry contents.
- Owner of the order: the per-client queue in `zcodeAgentService.ts`. A later Account Config change queues behind
  an in-flight refresh and vice versa.
- Capability owner: `apps/zcode-cli/.../zcode-protocol/server.ts` (`runtime/capabilities`) and
  `zcodeRuntimeCapabilitiesSchema` in `packages/shared/src/zcode-protocol/index.ts`.

## Acceptance

1. With unchanged Account Config, `switchModelConfig` waits for `provider/refreshRegistry` and is forwarded only
   after it resolves.
2. When that refresh fails, `switchModelConfig` is rejected and `v4/command` is not sent.
3. A CLI that does not advertise `providerRegistryRefresh` gets `switchModelConfig` directly, with no refresh request.
4. A `createSession` with `submissionPreparation` sends neither Account Config nor a refresh.
5. A plain V4 `createSession` sends Account Config, then the refresh, then the command.

6. Legacy `createSession`, `sendPrompt` and `generateWorkspaceText` send Account Config, then the refresh, then their
   own method. A CLI without the capability gets no refresh. A failed refresh rejects the call before the method.
7. The provider-ready startup of a waiting workspace sends the refresh after Account Config.
8. `resumeSession`, `testModelConnectivity` and cold `conversation/subscribe` send no refresh, even when the CLI
   advertises the capability.

Tests: `packages/services/test/zcodeAgentService.providerRegistry.test.ts`, `packages/services/test/runtimeCapabilitySupport.test.ts`.

## Per-site decisions

Upstream 3.16.2 passes `refreshRegistry: true` at seven more sites in `zcodeAgentService.ts`. "Stale symptom" asks
whether the Worker validates or resolves a provider in that call, so that a Registry one poll behind changes the result.

Cost, measured on 2026-10-25: Worker-side `registryService.refresh()` with the bundled Built-in config (183 KB) and 10
configured Personal providers takes p50 1.1 ms and p90 1.3 ms (100 warm runs). On top of that comes one stdio round
trip for a local CLI, or one network round trip for a remote one. The capability read is cached per client
(`runtimeCapabilitySupport.ts`), so it costs one extra round trip per CLI process, not per call. Refreshes do not
coalesce: the per-client queue runs N callers as N sequential refreshes.

| Site                                                         | Stale symptom in the Worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Cost                                                                                                                                         | Decision  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Legacy `createSession` (`session_create`)                    | Yes. `materializeCreatedSession` calls `app.setModel(params.model)` against the Registry, the same failure as V4 `createSession`. Callers: `zcodeSessionService`, the task adapter (automation, import repair), conversation share. None is the instant first-submission path, which uses V4 `submissionPreparation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 1 round trip per create, not on a typing path.                                                                                               | **Port.** |
| `resumeSession` (`session_resume`)                           | Weak. `restorePersistedModelSelection` validates the saved selection and, on a miss, leaves the runtime unbound but keeps the saved intent (warns `session.model_selection.restore_unbound`). The next turn that carries a selection rebinds it (`acceptSubmissionModelSelection`), and that turn now has its own barrier. A command that runs on the bound selection only (for example `compact`) fails with "Select a model" until then, as it does for any unbound restore today. A stale miss needs the session's saved provider to be written to Personal less than one poll ago, which is not a realistic resume. CLI logs from 2026-10-19 to 2026-10-25 hold 1,034 `restore_unbound` events. None can be attributed to a stale Personal layer: most are test fixtures (`provider-a`, `removed`) or missing reasoning levels, and 47 name `account:*` providers, which come from Account Config, not the Personal layer, and are already ordered by delivery. | 1 round trip on the session-restore path that opens a task.                                                                                  | **Skip.** |
| Legacy `sendPrompt` (`session_send`)                         | Yes. The turn resolves `modelSelection` (or the bound selection) in `runPromptTurnInBackground` after `session/send` has been acknowledged, so a stale miss fails after accept, which is worse than V4. Callers: the desktop Host IM/remote entry, bots, the task adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 1 round trip per send, small next to a model turn.                                                                                           | **Port.** |
| `generateWorkspaceText` (`workspace_generate_text`)          | Yes. `createRuntimeModel` resolves the caller's selection against the Registry. The Git commit message generator (`node.ts`) passes the Host's `preferredSelection`, which already includes a provider the Worker may not have polled yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 1 round trip, noise next to an LLM call.                                                                                                     | **Port.** |
| `testModelConnectivity` (`provider_test_model_connectivity`) | Already covered. The Worker refreshes its own Registry before resolving (`workspace-model-runtime.ts`, `refreshProviderRegistry("provider-connectivity")`). A Host refresh would be a second identical refresh.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 1 wasted round trip.                                                                                                                         | **Skip.** |
| Cold `conversation/subscribe` (`conversation_subscribe`)     | Weak, same as `resumeSession`: a cold subscribe of an inactive session goes through `activateSessionForResume` and can only leave the runtime unbound, which the next selection-carrying turn repairs. When the Host has just spawned the CLI (`cliProcessState: "spawned"`), the Worker read its Registry at start, so a refresh is pure cost. The path is read-only (`getReadOnlyClient`): history must open with no ready provider, so upstream's reject-on-failure would turn a refresh error into a task that cannot open. In the one realistic stale case, a read-only CLI started before provisioning, the subscribe runs before the provisioning write, so a refresh at subscribe time would read the same old files; the provider-ready refresh below covers that Worker instead.                                                                                                                                                                          | 1 round trip on every task open (`providerRegistrySyncMs` in `openTiming`), times N for the background fan-out in `groupRuntimeSnapshot.ts`. | **Skip.** |
| Provider-ready startup (`startup_ready:*`)                   | Yes. The ready event is raised by the provisioning write itself, and `startModelExecutionClient` reuses a read-only CLI started before provisioning (`getOrStartReadOnlyClient`), so that Worker can hold the pre-provisioning Registry. The refresh makes the Worker current before any waiting caller proceeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 1 round trip per waiting workspace per ready transition, off the interactive path.                                                           | **Port.** |
