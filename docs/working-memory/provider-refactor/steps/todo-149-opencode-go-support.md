# Todo149: OpenCode Go preset and request-config support

Status: code and offline verification done; native UI / live Go testing pending (2026-09-14). Nothing was
published and no user config was changed.

## Goal and known problem

Support OpenCode Go through the existing Provider config system, for both preset-created Providers and
Providers whose Go address was typed manually. No new Access type, config Schema, dedicated Runtime or
database migration.

On 2026-09-14 an Air instance `new-provider / glm-5.3` correctly used `https://opencode.ai/zen/go/v1` and
Chat Completions in the connectivity test but returned HTTP 400 rejecting `enable_thinking` and
`reasoning`. The cached revision 25 had no GLM Chat/Go site mapping and fell to the generic mapping that
produces `thinking`, `enable_thinking`, `reasoning_effort` and `reasoning` together (request ID
`2546e69c-330c-4653-9b70-c57088425cf7`). This proves only that two fields were rejected, not that the
other parameters, responses and tool calls are compatible after removing them.

## Requirements

### 1. Three preset templates

In the "Add provider" "Other" group next to Zen, reusing the existing OpenCode light/dark icons and create flow:

| Template ID             | Name                       | API type                  | Main series in the official access table |
| ----------------------- | -------------------------- | ------------------------- | ---------------------------------------- |
| `opencode-go-chat`      | OpenCode Go (Chat)         | `openai-chat-completions` | GLM, Kimi, DeepSeek, MiMo, LongCat, Hy   |
| `opencode-go-messages`  | OpenCode Go (Anthropic)    | `anthropic-messages`      | MiniMax, Qwen                            |
| `opencode-go-responses` | OpenCode Go (Responses)    | `openai-responses`        | GPT, Grok, Muse                          |

- Common Base URL `https://opencode.ai/zen/go/v1`; Access `api-key`; a single API-key link `https://opencode.ai/auth`.
- Server-original Model IDs are kept (no `opencode-go/` client namespace prefix); models are grouped by Go's official protocols and the full Zen list is not copied (Go's MiniMax must not go in the Chat template).
- No change to existing Zen templates, existing Provider IDs/Keys, personal config or historical Selections.

### 2. Unified config matching, covering self-built Providers

```text
Go template creation  --+
                        +--> Built-in rule by address + API type + Model ID
manual Go URL ----------+            -> existing personal override / manual mode -> Registry -> Model -> request
```

- Go differences live in `providerSiteRules`, keyed by the full Go Base URL, API type and model range, using the existing URL normalization (trailing slash covered; no false match on Zen, lookalike domains or other paths).
- With the same Provider API and model and no personal override, template and manual creation resolve to identical execution parameters; Template-specific rules carry only template facts such as default member enablement, never hidden protocol-compatibility fixes.
- Accurate shared model/API rules are reused; Go differences override through site rules; the wrong reasoning mapping expression is replaced, not appended to.
- Personal mappings and manual mode keep the current priority (old overrides are not silently cleared), so new config fixes self-built Providers that inherit recommendations but not already-frozen wrong manual config.
- Runtime consumes only the resolution result: no protocol guessing by Provider name, no automatic switch of protocol/model/Zen address after failure, and no field stripping in the connectivity test (formal chat and other consumers use the same rules).

### 3. Model catalog and parameters

- Resolve the known GLM-5.3 problem first and cover GLM-5.3-Flash; confirm the exact fields Go accepts before adding mappings. Context, max output, input capabilities, tool calls, reasoning levels and mappings are checked per "model series x API type"; MiniMax/Qwen Messages parameters are not assumed identical to Claude or OpenRouter.
- Membership is cross-checked against the Go official endpoint table and catalog at implementation time; the public `/models` gives only IDs and basics and proves neither capability nor entitlement nor request success. Models only in the catalog with unconfirmed protocol/capability are deferred.
- Zhipu Coding Plan search / image-video bridging capabilities are not ported to Go. No global reasoning-mapping rework and no `none/disabled` standardization here.

### 4. Headers and config delivery

- Reuse the common `User-Agent: ZCode/<version>`, version headers and native session headers; verify actual requests, no impersonated client. Go recognizes ZCode's native session headers; `x-opencode-session` is not newly required (the baseline already provides it via `3b67992023`, and it was verified consistent with native `x-session-id`).
- Ordinary API-key auth; no Zhipu Sig; no OAuth/plan-account/quota-query system.
- Only the production Built-in is edited; the test config is generated by `pnpm provider:config:sync-test` (Go URLs are identical in both environments); revision updated per existing rules; the final config contains the templates and site rules.
- No automatic publishing of remote config or editing Air user config; real-machine fixes use explicitly authorized config and isolated scenarios.

## Impact

| Entry                               | Shared change                          | Unchanged state / commit boundary                                                        |
| ----------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Add Provider, model settings        | Template list, recommended model config | page drafts saved to Personal via the Settings Service; unedited recommended fields not materialized |
| Connectivity test                   | Registry resolution and formal Adapter request parameters | existing prompts, budget, stream-completion rule; session model selection untouched |
| Chat, automation, Subagent, Wiki... | Registry candidates and Model request config | each entry keeps its own default, inheritance, validation, commit and persistence |
| Remote workspace and phone          | same execution rules after existing config delivery | no new sync chain; desktop continuous vs phone replayable unchanged |

No change to Provider/Model Schema, persistence format, account identity, session recovery or frozen
in-flight Model semantics. Codegraph was unavailable (no depth-2 call-graph scan); the above rests on source
and current logs, not full test coverage.

## Implementation decisions

- 25 models confirmed against the Go official endpoint table and models.dev `opencode-go` metadata; LongCat-2.0's request switch is unconfirmed and the two Muse Contributor models (extra data terms) are not preset; catalog aliases without a stated protocol are not added.
- Chat: GLM-5.3/Flash/5.2, DeepSeek V4 series, Kimi K3 and Hy use the Go-declared effort value range and a separate `reasoning_effort` (not the generic four mixed parameters). GLM-5.1, Kimi K2.6/K2.7 Code and MiMo use the server's inherent thinking mode (a single `enabled`, empty parameter mapping) without pretending an unconfirmed off option.
- Messages: MiniMax M3 uses adaptive/disabled; M2.7/M2.5 inherent thinking mode with no Claude effort injected. Qwen reuses the existing model/API mapping (enabled/disabled; 3.8 also carries `output_config.effort`) with no fixed thinking budget.
- Responses: GPT 5.6 Luna and Grok 4.6 use `reasoning.effort`. Go capacity/modality/level differences are all in site rules; undeclared Schema output is not inferred from model names.
- Default enabled (current main models): GLM-5.3/Flash, Kimi K3/K2.7 Code, DeepSeek V4.1 Flash/V4 Pro, MiMo V2.5/Pro, MiniMax M3, Qwen3.8 Max/Flash, GPT 5.6 Luna, Grok 4.6; other older and experimental/preview models default off and can be enabled manually.
- Accepted E2E scenario G149-01: the real add menu shows three Go templates; creating each verifies protocol, address, model members and the single Key entry; an isolated fake Key saves and reads back. Network protocol/response are covered by offline SDK tests (no real Go access with fake keys); existing connection-button interaction stays with C91-04.
- Sources: [models.dev model metadata](https://models.dev/api.json), [vendor-compatible Messages parameters](https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages), [Go docs](https://opencode.ai/docs/go/), [Go public model catalog](https://opencode.ai/zen/go/v1/models); current specs `docs/working-memory/provider-refactor/design/registry/settings.md` and `request-compatibility-and-access-protocols.md`. Public config does not mean every model was tested online.

## Evidence and review (2026-09-14)

- Built-in revision 27: Chat 15, Messages 8, Responses 2 (25 models); 13 default on, 12 default off; enabled members listed before disabled; production/test kept in sync by the generation script. Product change is Built-in config only; the existing Resolver handles URL + API + model and personal overrides still apply last; no new Runtime, Schema, account logic, auto-retry or protocol switching.
- Red first: config cases 13 failures, formal SDK cases 8 failures (missing templates, wrong four-group parameters, wrong public ranges, Go capacity differences, MiniMax mixed with Claude effort). Then config 5 files **56/56**; Adapter Go / new-model / common-header 3 files **81/81**; config build and sync scripts **20/20** (157 total). 30 new Go SDK cases enumerate public levels and 1/4096 token budgets and cover three-protocol body / tool intent / usage decoding on synthetic offline responses (not live Go success proof).
- `pnpm typecheck`, Adapter `tsc --noEmit`, `pnpm --filter @zcode/desktop typecheck:e2e` pass; root lint 0 errors / 42 existing warnings; new files format-clean; architecture 0 baseline / 0 new violations. Production and test configs staged via `stageBuiltinProviderConfig` both give revision 27 / 3 templates / 25 models. Semantic diff: removing the three Go templates, 25 site rules and 25 template-member default rules and restoring the revision gives a config deeply equal to HEAD; Zen, ordinary API and the global mixed fallback are untouched.
- G149-01 is written to `packages/desktop/test/e2e/settings/manual-review/pending/provider-opencode-go.test.ts` (E2E typecheck passes); the native Electron case was not run (Linux without DISPLAY/Xvfb/Docker). 2026-09-15 push-gate note: the historical Todo95 Map equivalence test checks only the original baseline, so Go exact-site match rules are separated from its scope; their members, public levels and request parameters stay verified by `opencode-go.test.ts` and `opencode-go-wire.test.ts`; the historical baseline snapshot and product config are unchanged.

## Open items

- [ ] UI E2E for template creation, Key entry, model list/selection and connection feedback, including themes and narrow screens.
- [ ] Live retest of the Air GLM-5.3 self-built Provider problem, then connection, chat and tool calls for representative models of each protocol and reasoning mapping (record version, Builtin revision, result and request ID, never the Key).
- [ ] Targeted coverage of auxiliary model calls without changing system prompts; mark untested/blocked if server limits or permissions block.
- Technical items still to confirm: per-series Go native mappings, capability values, output-budget limits, and LongCat-2.0's request switch. If new SDK adaptation, a wider generic mapping change or changed override semantics becomes necessary, give the evidence and scope and get a separate decision.
- Not deployed remotely and Air config not overwritten; Air will not get the rules from a local commit; the draft does not include the unrelated uncommitted Todo144 changes.
