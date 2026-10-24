# Todo 106: MCS and Site Capability Rule Correction

> Status: Completed (2026-09-10): implementation, real SDK wire verification and per-item review. Evidence, boundary
> review and real-environment limits: [delivery review](./provider-todos-105-113-delivery-review.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-106-mcs-capability-rule-correction.md`

## Principle

Follows the [Design V2 Match config maintenance principle](../design-v2/design.md): mainstream and official first, no
lowering of default capability for lagging third-party compatible implementations, one site rule per concrete URL. MCS =
mid-conversation system (`supportsMidConversationSystem`).

## Rules

1. The Anthropic official site no longer enables MCS for all `claude-*`. MCS is declared by officially supported models
   and API Schema; Sonnet 5 is never enabled, and the existing native web search is not turned off.
2. `claude-opus-4-8` has model-level MCS support by default under Anthropic Messages, covering the established
   prefix/suffix forms, without requiring proxy sites to opt in; if a proxy does not support it the user turns it off in
   Personal. The old test "Opus 4.8 on an unknown site must be false" is corrected.
3. Two site rules, API `anthropic-messages`, any model, both `supportsMidConversationSystem: true` and
   `supportsNativeWebSearch: true`: `https://zcode.z.ai/api/v1/zcode-plan/anthropic` and
   `https://zcode.z.ai/api/v1/off-peak/anthropic`.
4. Merged-URL site rules touched here (including the ordinary Z.ai / BigModel endpoints) are split per URL, keeping each
   URL's existing independent capability and giving no site another site's capability. No unrelated rule or Runtime refactor.

## Basis and Boundaries

- Actual Built-in resolution checked: official `claude-sonnet-5` MCS true; proxy Opus 4.8, Start and Off-Peak MCS false
  (before this change).
- Before the rewrite (`fe8a3159c7^`), `contracts/src/model/mid-conversation-system.ts` and `contracts/src/tools/websearch.ts`
  allowed `z.ai` and subdomains, so both endpoints used to be declared supporting MCS and native search. This confirms old
  code behavior, not real-gateway testing.
- [Official MCS doc](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) states
  Sonnet 5 does not support MCS; supported models are checked against the official list, not by brand match.
- Runtime consumes only final properties; no old URL allowlist or fast-model special case is restored; Selection, account
  state and retry-after-failure policy are untouched. Personal explicit off still wins over model/site defaults.

## Acceptance (all done)

- Config-resolution regressions: official supported/unsupported models, third-party Opus 4.8, prefix/suffix models, API type isolation.
- The four BigModel / Z.ai Start and Off-Peak Providers end with MCS and native search on; ordinary Coding Plan does not regress.
- URL normalization and negatives (no unrelated domain/path match); Personal off overrides the default.
- At the final request-encoding point: independent system reminder when on, existing user reminder when off, native search tool encoding; not only config booleans.
- Related tests run per batch; rule layers and override order reviewed; real-service verification limits recorded (local request capture is not upstream acceptance).

## Result

- `modelApiRules` declare Opus 4.8/5, Fable 5/5.1, Mythos 5/5.1 per the official list; Sonnet 5 stays off; the official
  URL's broad MCS is removed and its search declaration kept.
- Ordinary Coding Plan, Start and Off-Peak URLs maintain MCS/search separately; the earlier three-URL media rule is also
  split per URL, without extending media capability to Off-Peak.
- `mcs-capability-rules.test.ts` + Builtin integrity + rule-collections: 20 cases (official/proxy, prefix/suffix and dot
  aliases, different APIs, exact-path negatives, trailing slash, Personal false, eight Account Providers).
- `builtin-mcs-search-wire.test.ts`: published rules -> Core reminder projection -> real SDK/Adapter -> mock fetch, 7
  scenarios; with existing MCS wire/WebSearch tests 14 pass. Confirms system reminder and native search tool encoding for
  the four Start/Off-Peak Providers, Sonnet downgraded to user reminder, proxy Opus on and Personal off.
- Review: no Runtime URL/model allowlist, no new auth or retry branch, no Selection write; rule order and Personal
  final override kept. Keys/network in tests are fixtures; no real service was called. Fable 5.1 template/other
  capabilities continue in Todo113 (no duplicate template).
