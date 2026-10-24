# Subagent Provider Registry Cold Start

> Historical implementation plan (2026-07-03), kept for the root cause and the provider
> registry sync contract. The acceptance E2E case remains under
> `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-subagent-provider-registry-cold-start.test.ts`.

**Goal:** Fix the case where a subagent profile binds a provider the main session has never
used and the CLI child runtime cannot resolve that provider's config in desktop local and
remote workspaces.

## Root Cause

- Subagent profiles can reference providers the main session never selected. A single
  `runtimeModel` only overrides the current main-session model and cannot substitute for the
  full provider registry, so the registry must be injected at the workspace/modelAdapter
  layer.
- The child runtime reuses the parent runtime's `this.modelAdapter`
  (`apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`). On local cold start the
  CLI workspace catalog only carried the primary provider, so resolving an alternate provider
  threw `Model provider is not configured: e2e-deepseek-alt`.

## Design Rule

Any agent runtime that executes subagents must own the full app provider registry before its
turn:

- Local desktop: the agent service injects the full `providerRegistrySource` registry into the
  current CLI workspace before `createSession`, `resumeSession`, `readSession` and
  `readWorkspaceState`, and hot-pushes registry changes to active local workspace clients.
- Remote workspaces keep the existing `remoteWorkspaceProviderSync` dedicated path; remote
  subagents rely on the remote preflight that delivers the full registry before
  prepare/create/resume/send. Local behavior must not be mixed into remote replayable
  semantics.
- Subagents do not inject providers themselves; they keep reusing the parent runtime's
  `modelAdapter`.
- Identity isolation uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`;
  provider config never enters provider-visible tool input, child prompts or tool results.

## Stale Snapshot Guard

- `ProviderRegistrySnapshot.revision` is a `sha256:*` content fingerprint with no ordering.
  All entry points converge on `workspace/updateProviderRegistry`, so the stale guard is a
  best-effort `generatedAt` waterline at the agent apply boundary
  (`providerRegistryGeneratedAt` on the workspace model catalog record): an incoming registry
  whose `generatedAt` is older than the applied one returns the current catalog as
  `unchanged` and never overwrites the provider map. Legacy `workspace/upsertModelProvider` /
  `workspace/removeModelProvider` mutations clear the waterline.
- A local synchronizer serializes delivery per workspace/client with a single drain worker,
  skips snapshots older than the current pending/applied `generatedAt`, and caches a registry
  as the workspace provider registry only when
  `result.appliedProviderRevision === params.registry.revision`.
- Registry sync must not run in the `sendPrompt` runtime headers hot path.
- Known limitation: same-millisecond snapshots, system clock rollback and cross-machine clock
  drift remain best-effort; the long-term fix is a protocol CAS / monotonic source sequence.

## Non-Goals

- Do not generalize the remote provider sync helper (v3-era
  `packages/ui/src/lib/remoteWorkspaceProviderSync.ts`, since removed by the v4 protocol
  migration) into a shared local + remote helper.
- Do not sync the registry unconditionally in `getClient()`.
- Do not change CLI subagent profile parsing or child runtime model selection.
- No Docker preset admission in this fix; Docker admission is handled separately.
