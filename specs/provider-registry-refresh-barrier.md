# Provider registry refresh barrier on V4 commands

Status: implemented for `sendConversationCommandV4`. The other upstream call sites are a follow-up (see the end).

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
was a merge decision, not a product rule, and this spec reverses it for V4 commands.

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

Tests: `packages/services/test/zcodeAgentService.providerRegistry.test.ts`, `packages/services/test/runtimeCapabilitySupport.test.ts`.

## Follow-up (not in this change)

Upstream also refreshes on the legacy `createSession`, `resumeSession`, `sendPrompt`, `generateWorkspaceText`,
`testModelConnectivity`, cold `conversation/subscribe` and the provider-ready startup path. Those paths still send
Account Config only. Taking them changes latency and failure behavior on paths with no reported symptom and needs
its own review.
