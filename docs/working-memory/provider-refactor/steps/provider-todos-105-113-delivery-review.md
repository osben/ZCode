# Todo 105-113 Batch Implementation and Delivery Review

2026-09-10. Scope: 105, 106, 107, 108, 110, 111, 112, 113; 109 keeps its completed migration semantics; 102's existing
under-testing and 101's undone Draft are out of scope.

Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/provider-todos-105-113-delivery-review.md`

## Item Conclusions

| Todo | Implementation and evidence                                                                                                                                                    | Abstraction and boundary review                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 105  | The four personal/Team Account name lists keep only 5.3/Flash; actual release config and Settings/Registry member tests                                                        | Model-specific rule not deleted; manually adding 5.2/Turbo still parses; Start, idle and historical selection unchanged                                                                                                                    |
| 106  | Sonnet 5 no longer falsely opens MCS; Opus 4.8 model-level enable; normal/plan/Start/idle URLs each have an independent rule; real SDK captures system/search wire             | Runtime does not restore domain-name special judgment; Personal can override; plan media capability is not extended to normal 5.3 or idle                                                                                                  |
| 107  | Provider outer-layer `enabled`, three-color light, delete three-state feedback and retry, connectivity-test success close button, vertical drag, 17 template Key URLs          | Resolver is the only admission source; no per-model disable, no unbind, no selection clearing, no withdrawal of a bound Model; Team menu checks the Settings View by the specific ID, not its inherited Personal Provider                  |
| 108  | Verifier inherits the bound model's reasoning tier; output uses the model upper limit; 5 real Runtime/Adapter request tests                                                    | Other low-cost auxiliary calls unchanged; no special judgment in the general Factory                                                                                                                                                       |
| 110  | Guide still re-parses; compares old Loop Model with new complete Selection to decide whether to rebuild System; 9 real Runtime request tests                                   | Actual output upper limit updates when config changes under the same selection; System is not rebuilt by model-switch logic; Session and Loop are not mixed; the existing model-switch output-style freeze issue is not expanded           |
| 111  | normal/plan x BigModel/Z.ai four templates; new `zhipu-coding-plan-api-key`; dual-domain manual plan enters security verification; normal API does not; SDK/switch/cache tests | Existing instances not migrated; normal API search not opened; Key save keeps the new type; reuses existing security verification, config distribution and account verification path                                                       |
| 112  | Official GLM name list, precise rule and Start name specification; Subagent/Bot/Wiki import adds deterministic rename; SQLite 0021 and App 0003 incremental migrations         | Old migration/checksum untouched; old field, time, body, historical source and idle Ticket unchanged; bad JSON/missing field does not crash; rollback and re-upgrade do not resurrect old selection; custom/unknown models are not guessed |
| 113  | GPT-6 Astra, Fable 5.1, DeepSeek Flash; aggregated template adds only verified IDs; 16 SDK protocol/tier cases                                                                 | New model-specific rule does not extend the old Pro/proxy alias visual; Fable adaptive + auto tools + JSON Schema and inherits cross-model thinking cleanup; no forced tool call and no new beta special judgment                          |

## Key Chain

```text
Switch -> existing Personal Overlay transaction -> ProviderConfigRule.enabled
  -> same config snapshot serialization/distribution -> Resolver -> Settings View / Registry
     (gray/yellow/green light; new Model admission; a bound Model keeps running as is)

Manual plan Key -> shared Key config/save -> explicit access type security-verification admission
  -> existing switch / official-version request security verification -> SDK request
```

The config layer defaults to `enabled=true`; the UI only projects enabled/executable. No new sync system, send
barrier, account query or Runtime. Desktop continuous and mobile replayable boundaries unchanged; remote still uses
the target Host's config and never falls back to local.

## Verification and Limitations

- Final merge batch: 105 test files / 1,091 unit tests passed (Provider/Account service, config rule, database and file
  migration, request security verification, settings UI). Final typecheck, lint (41 pre-existing warnings, 0 errors) and
  architecture check (baseline/new 0) passed.
- The first pre-push full check found an old `legacyProviderUpgrade` test still expecting lowercase `glm-5.3`, which
  contradicts the Todo112 official ID `GLM-5.3`; only the expected value was updated (Key, old file, later edit and
  no-repeat-import assertions kept; old Provider migration semantics unchanged).
- Provider/config/migration/settings first group 507 passed; extended service and UI set 523 passed (3 old expectations
  rechecked after this adjustment). Account combination and Team status light had another regression.
- Adapter 6 files / 42 tests (dual-domain security verification, MCS, DB rollback, Verifier, new model); new model auto
  tools/JSON Schema and reasoning history 2 files / 41 tests; Guide 9 tests; earlier Runtime/tool-loop 186 tests. The sets
  overlap; do not add them into an independent total.
- Shared request security verification Key isolation, concurrent merge, failure degradation, Abort/credential-error
  non-degradation and dynamic switch were re-verified; no real Key or paid model used.
- New `packages/ui/test/browser/manual-review/pending/provider-settings-batch.test.mjs`: real component + isolated
  service adapter; 390px/Chinese/light and 1200px/English/dark pass, covering grouping, non-empty Key entry, enabled
  save, drag, delete failure retry and success close. It is not shared-host real-machine proof.
- Open: the updates to settings-ui-polish, pending provider-settings-write-recovery and Guide GS/P06 expectations; 3
  Electron tests were not fully run this round. The Pro SSH could not be connected; real mobile shared-host + SSH,
  online model response and console login state are not claimed verified, and the user-delayed joint real-machine
  verification is not written as passed. `pnpm typecheck`, CLI adapters/core typecheck and `pnpm lint` passed;
  unified re-verification before the final commit is subject to the MR record. The architecture baseline is not
  updated; unrelated existing issues are not expanded.

## Template Key URL Verification (2026-09-10)

The URL is maintained only in the Built-in template metadata. The four Zhipu entries are documented in Todo111; the
remaining new entries:

| Template             | Official entry                                                      | Layer                                                   |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| Kimi                 | https://platform.kimi.com/console/api-keys                          | Key console                                             |
| MiniMax              | https://platform.minimaxi.com/console/access?tab=api-keys           | Key console                                             |
| Qwen China           | https://bailian.console.aliyun.com/cn-beijing?tab=model             | Official regional console; user deep link not guessed   |
| Qwen International   | https://modelstudio.console.aliyun.com/ap-southeast-1?tab=dashboard | Official international console                          |
| MiMo                 | https://platform.xiaomimimo.com/                                    | Official upper entry; not claimed to reach the Key page |
| OpenRouter           | https://openrouter.ai/keys                                          | Official Keys; redirects when not logged in             |
| OpenCode 3 protocols | https://opencode.ai/auth                                            | Official Zen login, shares the Key                      |

DeepSeek/OpenAI/Anthropic/xAI keep their existing official console URLs; all templates assert an HTTPS link exists.

## Impact-only Review

The actual diff against feature graph codeSeeds hits model-capabilities, model-selection, provider-templates,
plan-entitlements, provider-registry, subagents and provider-settings / conversation-model-control. Settings Facade,
Resolver, Access serialization and ModelFactory/Adapter must be checked, plus a one-hop check of Composer, Automation,
Bot, Wiki and Subagent candidates and independent submission. The branch also contains the earlier-submitted DB109 and
documentation, hitting task-index, session-model-timeline, assistant-message-model-provenance,
plugin-reference-reminder-history and conversation-share-context; this batch does not rewrite those functions (DB109
rollback tests keep covering). No codegraph service exists, so full call-graph proof is not claimed. Recommended graph
delta: the Start official model normalization source, the new manual plan Key access, and that the Verifier is not a
low-cost auxiliary call. No cross-layer runtime dependency added; the real mobile and online endpoints are delivered
under the limitations above.
