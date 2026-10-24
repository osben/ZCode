# Todo140: Off-peak model list and vision/search capability update

Status: implemented, batch verification and review done (2026-09-12). Built-in revision 25; no online
config was published.

## Confirmed scope

Applies to both `account:zai-offpeak-idle-plan` and `account:bigmodel-offpeak-idle-plan`:

| Item                | Target                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Built-in model list | only `GLM-5.3` and `GLM-5.3-Flash`, both enabled by default; `GLM-5.2` and `GLM-5-Turbo` removed |
| GLM-5.3 vision      | no image/video input, configured as the ordinary API's real capability (not the Coding Plan bridging capability declaration) |
| GLM-5.3-Flash vision | keeps the ordinary API's image/video/PDF capability                                            |
| Built-in search     | `supportsNativeWebSearch` off for both models                                                   |

This adjusts the capability config itself; it is not a frontend badge-hiding special case.

## Direction and result

- Before: both off-peak `builtinModelIds` were Flash, 5.2, Turbo, each with an enabled rule, and 5.3 was missing; the list and its rules are closed together.
- The generic GLM-5.3 rule already turns image/video off and Flash's dedicated rule turns image/video/PDF on; existing rules are reused (no copied full ordinary-API config, no pointless same-value overrides).
- The off-peak site `https://zcode.z.ai/api/v1/off-peak/anthropic` had search and MCS both on; only search is turned off, MCS kept.
- Changes are in `config/provider/zcode-builtin.json` only: the two off-peak member tables, the matching exact enable rules and the off-peak site search bit; revision 24 -> 25. Verified through the real Resolver -> Registry -> off-peak dedicated selection View; existing dispatch/Ticket tests reused; no UI interaction change.

## Unchanged boundaries

- Off-peak keeps `anthropic-messages` and the existing endpoint; parameter mapping, MCS, account auth, Ticket binding, retry and scheduling are unchanged.
- The "ordinary API also enables MCS" discussion was withdrawn; ordinary API MCS is unchanged.
- No change to ordinary API, personal/team Coding Plan or Start Plan model lists/capabilities; global model rules for 5.2/Turbo stay (other Providers may use them).
- Old model IDs are not silently mapped to new models; no change to history, statistics, personal config or running tasks. Off-peak dispatch was checked for hard-coded old models / persisted selection dependencies; none requires new data migration.
- No online config publish, no real user data change.

## Acceptance (all done)

- Real Built-in resolution tests for the exact list, default enable state and model retention/removal of both off-peak Providers.
- Final resolution: 5.3 without image/video; Flash with image/video/PDF; no built-in search; MCS, Anthropic parameter mapping and context/output/reasoning-level rules kept.
- Adjacent Providers (ordinary API, Coding Plan, Start) unaffected, especially ordinary API MCS and plan search.
- Off-peak consumption chain and tests checked for old-model assumptions; Ticket, credential and bound-execution boundaries kept.
- Related config/dispatch tests, typecheck, lint and architecture passed. Existing dispatch/auth/retry regressions passed; the online off-peak service's supply of the new models was not verified over the network.

Batch evidence, pre-existing failure classification and multi-end limits are in
[the review record](../research/todos-136-139-140-review-20260912.md).
