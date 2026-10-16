# Bugfix 09: Kimi Multimodal Capability Evidence Correction

> Status: Completed
>
> Date: 2026-09-01

## Problem

The Built-in Config writes the following model capabilities incorrectly:

| Model            | Current Value            | Current Official Fact                                                                                           | Target Value |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------ |
| `kimi-k3`        | Image=false, Video=false | The Kimi API and the K3 release materials clearly state native visual, supporting image and video understanding | true / true  |
| `kimi-k2.7-code` | Image=false, Video=false | The Kimi official FAQ clearly supports Text, Image, Video                                                       | true / true  |
| `k3-256k`        | Image=true, Video=true   | The Kimi Code model table clearly states Image only                                                             | true / false |

The `packages/provider-node/test/zcode-builtin-integrity.test.ts` also asserts the first two incorrect values, allowing the incorrect configuration to stably pass the test.

## Root Cause

The Built-in data refresh on 2026-08-28 only recorded the K3's context length in the research summary, without recording the multimodal capability. During implementation, "not recorded in this data" was incorrectly interpreted as "the model does not support it," demoting the original positive value to `false`. This is not a problem with the Resolver, the Overlay, or the Adapter; it is the incomplete human projection rule from the release evidence to the Config.

## Fix

1. First modify the integrity test, fixing the three official facts and proving the old Config fails.
2. Correct the corresponding Model Match Rules, without adding the Provider/Model specialized code.
3. Increment the Built-in revision to ensure the running Config Source can observe the new published fact.
4. Add the capability degradation gate in the Built-in maintenance design: missing data cannot overturn the already-published positive capability.
5. Record this revision and the current official source in the release evidence report.

## Impact Scope

```text
Built-in Model Match Rules
            |
            v
Effective Model Config
            |
            v
Provider Registry / Active Model.properties
        |                    |
        v                    v
The settings page and the model selector       The Runtime input check / Adapter encoding
```

- No new capability DTO is added; the capability is not inferred by the Model ID at Runtime.
- The already-created Active Model continues to freeze; the new Model created after the Config refresh uses the new fact.
- The Desktop continuous, Web Remote replayable, Session Selection, and queue semantics remain unchanged.
- The Video is still constrained by both the `input_format.support_video` and the Adapter's actual encoding capability.

## Verification

- The real Built-in Config parses: the K3, K2.7 Code, and K3-256K media capabilities.
- The `@zcode/provider-node` targeted unit test and typecheck.
- The root `pnpm typecheck`, `pnpm lint`.
- The configuration and document format check, the `git diff --check`.
