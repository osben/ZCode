# Bugfix 09: Kimi Multimodal Capability Evidence Correction

> Status: Completed
>
> Date: 2026-09-01
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-09-kimi-multimodal-evidence-correction.md`

## Problem and Cause

The Built-in Config recorded wrong model capabilities, and `packages/provider-node/test/zcode-builtin-integrity.test.ts`
asserted the first two wrong values, so the error passed tests:

| Model            | Was                      | Official fact                                                           | Target       |
| ---------------- | ------------------------ | ----------------------------------------------------------------------- | ------------ |
| `kimi-k3`        | Image=false, Video=false | Native visual; image and video understanding                            | true / true  |
| `kimi-k2.7-code` | Image=false, Video=false | Kimi official FAQ: Text, Image, Video                                   | true / true  |
| `k3-256k`        | Image=true, Video=true   | Kimi Code model table: Image only                                       | true / false |

Cause: the 2026-08-28 Built-in refresh recorded only K3's context length in its research summary; "not recorded"
was read as "not supported" and positive values were demoted to `false`. This is not a Resolver, Overlay or Adapter
problem but an incomplete human projection rule from release evidence to Config.

## Rules

1. Correct the Model Match Rules (no Provider/Model specialized code); the integrity test pins the three official
   facts.
2. Increment the Built-in revision so running Config Sources observe the new published fact.
3. Built-in maintenance gate: missing data cannot overturn an already-published positive capability.
4. Record the revision and current official sources in the release evidence report.
5. Flow: Built-in Model Match Rules -> Effective Model Config -> Provider Registry / Active Model.properties ->
   settings page, model selector, Runtime input check, Adapter encoding. No new capability DTO; capability is never
   inferred from Model ID at Runtime. Already-created Active Models stay frozen; Models created after the Config
   refresh use the new fact. Video remains bounded by both `input_format.support_video` and the Adapter's actual
   encoding capability. Desktop continuous, Web Remote replayable, Session Selection and queue semantics unchanged.

## Verification

Real Built-in Config parse of K3, K2.7 Code and K3-256K media capabilities; `@zcode/provider-node` targeted unit
test and typecheck; root `pnpm typecheck`, `pnpm lint`; config/doc format check and `git diff --check`.
