# Todo105–113 This Batch Implementation and Delivery Review

2026-09-10. Scope: 105, 106, 107, 108, 110, 111, 112, 113; 109 maintains the completed migration semantics; 102's existing under-testing, 101's Draft is not implemented.

## Item-by-item Conclusion

| Todo | Implementation and Evidence                                                                                                                                                                               | Abstraction and Boundary Review                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 105  | The four personal/Team Account name lists only retain 5.3/Flash; the actual release config, the Settings/Registry member test                                                                             | Do not delete the model-specific rule; manually adding 5.2/Turbo can still be parsed; does not change the Start, idle, or historical selection                                                                                                                             |
| 106  | The Sonnet 5 no longer falsely opens the MCS; the Opus 4.8 model-level enable; the normal plan/Start/idle each URL independent rule; the real SDK captures the system/search wire                         | The Runtime does not restore the domain name special judgment; the Personal can override; does not expand the plan media capability to the normal 5.3 or the idle                                                                                                          |
| 107  | The Provider outer layer enabled, the three-color light, the delete three-state feedback and retry, the connectivity test success close button, the vertical drag, the 17 templates Key URL               | The Resolver's unique admission source; does not disable per model, does not unbind, does not clear the selection, does not withdraw the bound Model; the Team menu checks the Settings View by the specific ID, and does not use its inherited Personal Provider          |
| 108  | The Verifier inherits the bound model reasoning tier; the output uses the model upper limit; 5 real Runtime/Adapter request tests                                                                         | Does not change the other low-cost auxiliary call; does not add the special judgment to the general Factory                                                                                                                                                                |
| 110  | The Guide still re-parses; compares the old Loop Model with the new complete Selection to decide whether to rebuild the System; 9 real Runtime request tests                                              | The actual output upper limit is updated after the same selection changes the config; the System is not reconstructed by the model switch logic; the Session and the Loop do not mix; the real model switch output style freeze existing issue is not expanded             |
| 111  | The normal/plan x BigModel/Z.ai four templates; the new zhipu-coding-plan-api-key; the dual-domain manual plan enters the security verification; the normal API does not enter; the SDK/switch/cache test | Does not migrate the existing instance; the normal API search does not open; the Key save retains the new type; still reuses the existing security verification, the config distribution, and the account verification path                                                |
| 112  | The official GLM name list, the precise rule, and the Start name specification; the Subagent/Bot/Wiki import adds the deterministic rename; the SQLite 0021, the App 0003 incremental migration           | Does not modify the old migration/checksum; the old field, time, body, historical source, idle Ticket is not changed; the bad JSON/missing field does not crash, the rollback and re-upgrade does not resurrect the old selection; the custom/unknown model does not guess |
| 113  | The GPT-6 Astra, the Fable 5.1, the DeepSeek Flash; the aggregated template only adds the verified ID; the 16 protocol/tier cases of the SDK                                                              | The new model-specific rule does not expand the old Pro/proxy alias visual; the Fable adaptive + auto tools + JSON Schema, and inherits the cross-model thinking cleanup; does not enable the forced tool call or the new beta special judgment                            |

## Key Chain

```text
The switch -> The existing Personal Overlay transaction -> The ProviderConfigRule.enabled
     -> The same config snapshot serialization/distribution -> The Resolver -> The Settings View / Registry
                                          |                 |
                                       The gray/yellow/green            The new Model admission
The bound Model ---------------------------- Maintains the original execution

The manual plan Key -> The shared Key config/save -> The explicit access type security verification admission
                                 -> The existing switch/official version request security verification -> The SDK request
```

The config layer uniformly defaults to the enabled=true; the UI only projects the enabled/executable. No new sync system, send barrier, account query, or Runtime is added. The desktop continuous and mobile replayable boundaries remain unchanged; the remote still uses the target Host's config, and does not fall back to the local.

## Verification and Limitations

- The final merge batch: 105 test files, 1,091 unit tests all pass; including the Provider/Account service, the config rule, the database and file migration, the request security verification, and the settings UI. The final typecheck, lint (41 pre-existing warnings, 0 errors), and the architecture check (baseline/new 0) pass.

- The first pre-push full check finds that one old test of the `legacyProviderUpgrade` still requires the template to return the lowercase `glm-5.3`, which does not match the officially decided ID of the Todo112. Only update it to `GLM-5.3`; retain the Key, the old file, the subsequent edit, and the no-repeated-import original assertion; do not use this to adjust the old Provider migration semantics.

- The Provider/config/migration/settings first group 507 pass; the extended service and UI collection the original 523 pass, 3 old expectations pass after re-verification following this batch adjustment. The account combination and the Team status light have another regression.
- The Adapter 6 files 42 tests pass (dual-domain security verification, MCS, DB rollback, Verifier, new model); the new model auto tools/JSON Schema and the reasoning history 2 files 41 tests pass. The Guide 9 tests pass; the previous batch Runtime/tool-loop 186 tests pass. The collection has overlaps; do not claim the independent total by addition.
- The shared request security verification Key isolation, concurrent merge, failure degradation, Abort/credential error non-degradation, and the dynamic switch test re-verification; no real Key or paid model is used.
- The new `packages/ui/test/browser/manual-review/pending/provider-settings-batch.test.mjs`: the real component + the isolated service adapter; 390px/Chinese/light and 1200px/English/dark pass, covering the grouping, the non-empty Key entry, the enabled save, the drag, the delete failure retry, and the success close. It is not the shared-host real-machine proof.
- The update to the settings-ui-polish, the pending provider-settings-write-recovery, the Guide GS/P06 expectation; 3 Electron tests are not fully run in this round. The Pro SSH cannot be connected this time; the real mobile shared-host + SSH, the online model response, and the console login state are not claimed as verified; do not write the user-delayed joint real-machine verification as passed.
- The `pnpm typecheck`, the CLI adapters/core typecheck, and the `pnpm lint` have passed (lint pre-existing warnings, no errors); unified re-verification before the final commit, subject to the MR record. The architecture baseline is not updated; the unrelated existing issue is not expanded.

## Template Key URL Verification (2026-09-10)

The URL is uniquely maintained in the Built-in template metadata. The Zhi 4 entries are documented at Todo111; the remaining new entries:

| Template             | The official entry                                                  | Layer                                                          |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Kimi                 | https://platform.kimi.com/console/api-keys                          | The Key console                                                |
| MiniMax              | https://platform.minimaxi.com/console/access?tab=api-keys           | The Key console                                                |
| Qwen China           | https://bailian.console.aliyun.com/cn-beijing?tab=model             | The official regional console, do not guess the user deep link |
| Qwen International   | https://modelstudio.console.aliyun.com/ap-southeast-1?tab=dashboard | The official international console                             |
| MiMo                 | https://platform.xiaomimimo.com/                                    | The official upper entry, not claimed to reach the Key page    |
| OpenRouter           | https://openrouter.ai/keys                                          | The official Keys; the unlogged redirect                       |
| OpenCode 3 Protocols | https://opencode.ai/auth                                            | The official Zen login, shares the Key                         |

The DeepSeek/OpenAI/Anthropic/xAI retain the existing official console URL; all templates assert the existence of the HTTPS link.

## Impact-only Review

The actual diff to the feature graph codeSeeds scan hits the model-capabilities, model-selection, provider-templates, plan-entitlements, provider-registry, subagents, and the provider-settings / conversation-model-control. The Settings Facade, Resolver, Access serialization, and the ModelFactory/Adapter must be checked; the one-hop check of the Composer, Automation, Bot, Wiki, Subagent candidates and independent submission.

This branch also includes the previously submitted DB109 and documentation, so it hits the task-index, session-model-timeline, assistant-message-model-provenance, plugin-reference-reminder-history, conversation-share-context. This is not this batch rewriting these functions; the DB109 rollback test continues to cover. The test, the i18n, and the document belong to the above evidence; there is no diff difference of the product boundary that needs to be added.

There is no codegraph service, and does not claim the full call graph proof. The recommended graph delta: the Start official model normalization source, the new manual plan Key access, and the Verifier not belonging to the low-cost auxiliary call. No cross-layer runtime dependency is added; the real mobile and the online endpoint are delivered according to the above limitations.
