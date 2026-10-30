# MiniMax M3.1 Flash GA release and old-model maintenance

Confirmed for implementation on 2026-10-26; the production and test configurations move up to revision 38. The goal is to let users choose the GA release on the already-supported entries while distinguishing stopped-for-new-users, retired and compatibility aliases. Only configuration, tests and this directory's docs are updated; existing protocols are reused, no Adapter is added, personal model selections are not migrated automatically, and no online release is performed.

## Official evidence and entries

- [Model release notes](https://platform.minimax.cn/docs/release-notes/models): on 2026-10-19 the GA `MiniMax-M3.1-Flash` was released, no longer limited to the plan Preview.
- [Messages API](https://platform.minimax.cn/docs/api-reference/text-chat-anthropic): supports image, video, tool calling and thinking; thinking is forced and disabled is forbidden; `output_config.effort` supports low/medium/high/xhigh/max with default max; max output 524288, recommended 131072. The [SDK notes](https://platform.minimax.cn/docs/api-reference/text-anthropic-api) list a context of 1000000.
- [M Plan](https://platform.minimax.cn/docs/m-plan/intro): Preview is retired, but requests with the old name are served by the GA release. The [subscription quickstart](https://platform.minimax.cn/docs/m-plan/quickstart) confirms that plan keys and pay-as-you-go keys are separate.
- [Original-vendor lifecycle](https://platform.minimax.cn/docs/faq/models): M2.5/M2.7 stop accepting new users on October 19 and stop existing pay-as-you-go calls on November 18, and plan requests with old names are already forwarded to the GA release; the history table on the same page also says they are retired — the statements conflict, so deletion must not happen early based on them. M2/M2.1/M2.1-highspeed are listed as retired with no existing-user grace listed.
- [OpenRouter model catalog](https://openrouter.ai/api/v1/models) and [endpoint catalog](https://openrouter.ai/api/v1/models/minimax/minimax-m3.1-flash/endpoints): `minimax/minimax-m3.1-flash` exists; model-level context 1048576, output 524288, and image, video, tool and reasoning support. Route capacities differ; one route's higher output cap is not generalized to all entries.
- The [Go documentation](https://opencode.ai/docs/go/) lists `minimax-m3.1-flash` using Chat, and the [existing Go catalog](https://opencode.ai/zen/go/v1/models) also lists that ID. The [Zen catalog](https://opencode.ai/zen/v1/models) does not list the GA release, so nothing speculative is added to Zen. The documentation has switched to the inference URL and the catalog is still readable on the old path, which does not mean old-path inference was measured; this round does not change the existing template endpoints.

## Configuration contract

| Template          | Added model                | Protocol | Context | Output cap/budget            | Thinking levels           |
| ----------------- | -------------------------- | -------- | ------- | ---------------------------- | ------------------------- |
| minimax           | MiniMax-M3.1-Flash         | Messages | 1000000 | 524288                       | low/medium/high/xhigh/max |
| minimax-m-plan-cn | MiniMax-M3.1-Flash         | Messages | 1000000 | 524288                       | low/medium/high/xhigh/max |
| openrouter        | minimax/minimax-m3.1-flash | Messages | 1048576 | 524288                       | low/medium/high/xhigh/max |
| opencode-go-chat  | minimax-m3.1-flash         | Chat     | 1000000 | 131072 (conservative budget) | max                       |

All four added members are default enabled and placed at the start of their template's members; the relative order of the remaining members is unchanged. Exact templateId/modelId rules override the broad M3 rule and the shared family rules are not changed. Messages sends `output_config.effort`; the two original-vendor entries additionally send `thinking.type=adaptive`, and the aggregating entries pass effort along their compatible protocols. Go's first batch exposes only max, passed through Chat's `reasoning_effort`, reusing `max_tokens`. Go's five levels, real capacity and old-path inference still await key validation; the original vendor's full contract must not be treated as Go's measured result.

The added models all support text, image, video and tool calling; audio, PDF and native search are not declared. OpenRouter declares structured output per its catalog and the other entries do not declare it for now. The original vendor's existing base URLs stay unchanged; the documentation adopting a new domain is not sufficient evidence to replace user endpoints.

| Existing identity                                                   | Change this round                                          | Reason and boundary                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| minimax / MiniMax-M2.7, MiniMax-M2.7-highspeed                      | enabled true → false, member kept                          | New users can no longer call it; verify deletion after the existing-user grace ends                                                         |
| minimax / MiniMax-M2, MiniMax-M2.1, MiniMax-M2.1-highspeed          | Template members and the corresponding exact rules deleted | Explicitly retired by the original vendor; shared rules are not deleted, and personal manual configuration and other vendors are unaffected |
| minimax-m-plan-cn / MiniMax-M3.1-Flash-Preview                      | enabled true → false, member and original parameters kept  | The old name still has forwarding capability and is not an unusable identity; the GA name is added for active selection                     |
| minimax / MiniMax-M2.5, MiniMax-M2.5-highspeed                      | Stay default disabled with members kept                    | In the same grace period as M2.7; not deleted early                                                                                         |
| Original-vendor M3 and the old MiniMax members of OpenRouter/Go/Zen | Unchanged                                                  | The original-vendor lifecycle cannot be inferred across entries; the aggregating catalogs still carry the old models                        |

Personal explicit overrides such as enabled and capacity still take priority. Default disabling does not switch users to the new model for them, and keeping an alias does not mean it remains a default recommendation. The addition, disabling and deletion lists are reviewed together with the configuration summary. Both environments derive from the same production source, and the template brand order continues to follow the [ordering rules](./configuration.md).

## Validation and delivery

First write the two-environment tests for the added catalog, per-level requests, lifecycle, personal overrides and non-target configuration protection, then modify the configuration. The full summary takes revision 37 as its baseline and exempts only this table's four additions, three deletions and three enabled changes; the old staged full summary is succeeded by this latest boundary, and existing model-behavior tests are kept. Unrelated changes must not be masked by refreshing the whole new-file summary.

This round adds no UI interaction and no new desktop E2E. Configuration checks cannot prove real account entitlement, streaming, tool history or media availability; later, per the [validation spec](./validation.md), each product's credentials will be used for streaming and two-round tool passback, and all thinking levels, capacity, old endpoints and the Preview alias will be verified. Not having obtained a key does not block landing additions that comply with the evidence.

Git revision 38 does not equal online adoption; dynamic delivery uses an independent new URL and hash, does not overwrite 36/37, and verifies the test and production control planes separately. Rollback restores the old configuration with a higher revision and regenerates the test file; the revision must not be lowered, and restoring retired members does not mean the original vendor is available again.

Validation results of 2026-10-26:

- The new tests failed 14 items on the old configuration and passed 14 items after the change; the 9 files related to configuration, thinking Maps, templates and historical behavior passed 225 items in total.
- `pnpm test:unit:affected --base a803b46643b4789bac2ad6b0129915e07d0dad0a`: the officially selected 6 files passed, 145 items.
- `pnpm typecheck`, `pnpm lint` (191 pre-existing warnings, 0 errors), `pnpm architecture:check --changed` (0 violations) and `pnpm provider:config:check-test` passed; the format, doc-link, inventory statistics, two-environment hash and open-source feature-word checks passed.
- Both environments have 34 templates, 313 members and 126 default enabled; only the four additions, three deletions and three enablement changes above occurred, and endpoints, brand order, account configuration and shared rules were unchanged.
- No real-key inference, UI E2E or online release was performed; the public Models catalog and offline parameter mapping do not equal measured inference.
