# Embedded Search and Provider Dependency Investigation

> Status: Investigation complete; no production code modified yet
> Date: 2026-08-10
> Corresponding stage design: [`../steps/01-model-and-request.md`](../steps/01-model-and-request.md)

## Conclusion

Embedded Search is a tool capability provided by the Environment, unrelated to Model Providers. Although current code parses model connections through `ModelConnectionPort`, branch results depend only on feature flags and Bash availability. The Provider dependency can be removed and does not need to be transferred to a new `Model` interface.

The target entry point can be consolidated to:

```ts
resolveEmbeddedSearchBranchCapability({
  bashAvailable,
  embeddedSearchBranchEnabled,
});
```

## Code Facts

`resolveEmbeddedSearchBranchCapability()` currently receives Bash status, shell selection, model refs, and `ModelConnectionPort`. The function parses the Connection and places model, provider kind, base URL, and the Credential-removed Connection into the decision context.

The only things that truly determine the result are:

```text
embedded-search feature flag
             +
       Bash available
             |
             v
 useEmbeddedSearchBranch
```

model refs, provider kind, base URL, Provider options, and shell selection are not involved in the judgment. When Connection parsing fails, the function still returns the same result.

This result is used in three locations:

```text
Main Runtime tool exposure
└─ Decides whether to hide direct Glob / Grep

Tool executor
└─ Writes embeddedSearch.enabled

Subagent Runtime
└─ Decides child tool surface
```

All three callers ultimately only read `useEmbeddedSearchBranch`.

The function is located at `apps/zcode-cli/packages/core/src/embedded-search/capability.ts`; the three call sites are at `runtime/methods/embedded-search-branch.ts`, `tool/executor/call-runner.ts`, and `runtime/methods/subagent.ts`.

Existing tests require retaining some Provider context, on the grounds that branching by model may occur in the future; the historical design also explicitly states first-party currently enabled uniformly, without distinguishing by provider, source, or variant. These contents prove that Provider Connection is reserved information, not a current behavior dependency.

## Cleanup Boundaries

The implementation needs to synchronously modify capability input types, Main Runtime, Tool executor, Subagent call sites, and related tests. Whether shell supports prelude injection continues to be judged by the execution/adapter layer and does not affect the embedded tool surface seen by the Agent.

This cleanup has no UI, persistence, or protocol changes, and does not depend on the landing of a new `Model` interface. The behavior that must be maintained is: when the feature flag is on and Bash is available, hide direct Glob/Grep; when Bash is unavailable or the flag is off, continue exposing direct tools.
