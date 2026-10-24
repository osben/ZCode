# Embedded Search and Provider Dependency Investigation

> Status: Investigation complete; no production code modified yet
> Date: 2026-08-10
> Corresponding stage design: [`../steps/01-model-and-request.md`](../steps/01-model-and-request.md)

## Conclusion

Embedded Search is a tool capability provided by the Environment, unrelated to Model Providers. The current code parses model connections through `ModelConnectionPort`, but branch results depend only on the feature flag and Bash availability. The Provider dependency can be removed without transferring it to the new `Model` interface. The target entry point consolidates to:

```ts
resolveEmbeddedSearchBranchCapability({
  bashAvailable,
  embeddedSearchBranchEnabled,
});
```

## Code Facts

`resolveEmbeddedSearchBranchCapability()` at `apps/zcode-cli/packages/core/src/embedded-search/capability.ts` currently receives Bash status, shell selection, model refs, and `ModelConnectionPort`, and parses the Connection into the decision context. The only true inputs are:

```text
embedded-search feature flag
             +
       Bash available
             |
             v
 useEmbeddedSearchBranch
```

Model refs, provider kind, base URL, Provider options, and shell selection are not involved; when Connection parsing fails the function still returns the same result. Three callers, all reading only `useEmbeddedSearchBranch`:

```text
Main Runtime tool exposure (runtime/methods/embedded-search-branch.ts)
└─ Decides whether to hide direct Glob / Grep

Tool executor (tool/executor/call-runner.ts)
└─ Writes embeddedSearch.enabled

Subagent Runtime (runtime/methods/subagent.ts)
└─ Decides child tool surface
```

Existing tests require retaining some Provider context on the grounds that branching by model may occur in the future; the historical design also states first-party is uniformly enabled without distinguishing by provider, source, or variant. This proves Provider Connection is reserved information, not a current behavior dependency.

## Cleanup Boundaries

The cleanup synchronously modifies capability input types, Main Runtime, Tool executor, Subagent call sites, and related tests. Whether a shell supports prelude injection continues to be judged by the execution/adapter layer and does not affect the embedded tool surface seen by the Agent.

No UI, persistence, or protocol changes, and no dependency on the new `Model` interface landing. Behavior to maintain: feature flag on + Bash available → hide direct Glob/Grep; Bash unavailable or flag off → keep exposing direct tools.
