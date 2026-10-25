# GLM-5.2 Suffixed Variant Media Fallback

> Stale implementation plan (2026-07-10). Never executed in this tree: the structural
> matcher (`isGlm52SuffixedVariant`) was never committed, and the targeted capability
> resolver path (`apps/zcode-cli/packages/bootstrap/src/app/model-input-capabilities.ts`,
> `resolveRuntimeModelInputCapabilities`) no longer exists after the v3.15.1 upstream update.
> The accepted design, including the 2026-08-14 Highspeed carve-out, remains in
> [the design doc](../specs/2026-07-10-glm-52-suffixed-variant-media-fallback-design.md);
> re-validate its target code paths before implementing.

**Goal (from the accepted design):** keep the fail-closed image fallback for unknown
third-party GLM-family models, but leave unknown `glm-5.2-*` / `glm-5.3-*` suffixed variants
fail-open (capability stays unknown) without encoding any private identifier.

Rules the design still requires, if and when re-implemented:

- Structural exception on the normalized final model ID segment:
  `^glm-5\.(?:2|3)-.+$` stays unknown, except `^glm-5\.(?:2|3)-highspeed$` resolves
  `supportsImages: false` first. Canonical `glm-5.2` (including a local `[1m]` marker) keeps
  the existing fail-closed fallback.
- Capability precedence unchanged: explicit facts > catalog facts > deterministic defaults >
  provider-aware GLM fallback. Explicit `supportsImages: true`/`false` always wins.
- Active-session refresh: the model-limit patch must carry `modelInputMediaCapabilities`
  even when the resolved value is `undefined` — `AgentRuntime.updateConfig(...)` uses
  property presence to clear stale `false` values when a registry revision removes the fact.
- No private model IDs, provider IDs, base URLs, suffix tokens, hashes, or obfuscated
  equivalents in source, tests, docs, fixtures, logs, or comments; neutral fixtures such as
  `GLM-5.2-variant`.
- Catalog `N08` covers only the explicit text-only GLM-5.2 provider-visible strip contract,
  not the unknown-provider fallback boundary (that is unit-test scope).
