# Coding Plan client configs integration cases

## Change summary

| Field                 | Value                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| Change                | "Upgrade Coding Plan" uniformly consumes personal, team, and Start Plan static data from `client/configs` |
| User-visible surfaces | upgrade-page plan selection, personal cycle selection, team plan selection, Start Plan cards |
| Existing docs         | `docs/bigmodel-coding-plan-subscription.md`, `docs/coding-plan-purchase-panel-flow.md` |
| Existing code owners  | host `codingPlanSubscriptionService`, UI purchase hooks/panel                            |
| Out of scope          | payment protocol, order creation, entitlement, provider registry, and realtime pricing protocol changes |

## Boundary decisions

| Boundary      | Decision                     | Includes                                             | Excludes / prunes        |
| ------------- | ---------------------------- | ---------------------------------------------------- | ------------------------ |
| Static catalog | configs is the authority    | product identity, name, cycles, static prices, card copy | no local constants overriding remote |
| Missing copy   | stays empty                  | personal/team entitlements, descriptions, Start copy | no frontend hard-coded fallback copy |
| Realtime state | preview/pricing override dynamic fields | actual pay price, purchasable, sold out, subscription status | never override remote card copy |
| Test env       | `ZCODE_ENV=test`             | the remote test-env `client/configs`                 | no local dev mock        |
| Team provider  | exact provider key           | BigModel 8 SKUs, Z.AI empty array                    | no BigModel → Z.AI fallback |
| Start          | standalone preview           | planId/name/entitlements                             | never disguised as a payable SKU |

Additional clarified boundaries: local dev reads test data through `ZCODE_ENV=test`
(connected to the ZCode test endpoint); team plans distinguish Z.AI/BigModel by
provider key and Z.AI currently has no team plans; after migration the personal
plan `description` copy returns to its pre-migration card text — only the
description is restored, not the product, price, or entitlements.

## Domain scope and high-risk cross-products

| Domain                        | Include? | Reason                                        |
| ----------------------------- | -------- | --------------------------------------------- |
| Model/provider config         | yes      | provider key, static catalog, realtime merge  |
| Architecture/process boundary | yes      | renderer gets host config through a service   |
| UI locale/responsive          | yes      | BigModel zh, Z.AI en; layout unchanged        |
| Mobile remote/replayable      | pruned   | an App-global config service changes no task realtime semantics |

The high-risk combination is `provider × audience × config result × realtime
result`. Mock and production endpoints only change the config source, never the
merge algorithm.

## State owners

| State / fact   | Authority                                     | Cache/mirror                 | Evidence                  |
| -------------- | --------------------------------------------- | ---------------------------- | ------------------------- |
| personal static catalog | `client/configs.codingPlanStaticProducts`     | host + UI one-day memory cache | service result / UI card |
| team static catalog     | `client/configs.codingPlanStaticTeamProducts` | host client-config cache      | service result / UI card |
| Start preview           | `client/configs.startPlanPreview`             | host + UI cache               | service result / UI card  |
| personal realtime state | `batch-preview`                               | UI hook snapshot              | network + card action     |
| team realtime state     | enterprise pricing                            | UI hook snapshot              | network + card action     |

## Candidate combinations and pruning

| Candidate ID | Setup                                      | Expected effect                          | Status              |
| ------------ | ------------------------------------------ | ---------------------------------------- | ------------------- |
| CPCFG-01     | BigModel personal config + preview success | static copy kept, realtime price/status override | accepted        |
| CPCFG-02     | Z.AI personal config + preview failure     | Z.AI static card kept, no cross-brand   | accepted            |
| CPCFG-03     | BigModel team config + pricing success     | static copy and realtime state merged by productId | accepted     |
| CPCFG-04     | BigModel team config + pricing failure     | static team card kept, refresh error shown | accepted         |
| CPCFG-05     | Z.AI team empty array                      | no team products shown                   | accepted            |
| CPCFG-06     | Start preview present                      | quota computed from entitlements         | accepted            |
| CPCFG-07     | Start preview missing                      | Start Plan hidden                        | accepted            |
| CPCFG-08     | mock not explicitly enabled                | normal runtime endpoint is used          | accepted            |
| CPCFG-09     | production build sets mock env             | mock ignored; local config must not reach production | accepted   |
| CPCFG-10     | desktop/mobile/remote workspace            | same App-global service result           | pruned by invariant |

## Accepted case list

| Case ID  | Setup                                  | Action             | Assertions                                            | Evidence layers       | Status   |
| -------- | -------------------------------------- | ------------------ | ----------------------------------------------------- | --------------------- | -------- |
| CPCFG-01 | BigModel config + preview fixture      | open personal upgrade page | name/copy from config, price/button from preview | unit + E2E network/UI | planned  |
| CPCFG-03 | BigModel team config + pricing fixture | switch to team     | both equity rows and description from config, realtime state merged | unit + E2E network/UI | planned |
| CPCFG-04 | team pricing failure                   | switch to team     | static card still present, error shown                 | unit                  | planned  |
| CPCFG-05 | Z.AI team `[]`                         | open Z.AI upgrade page | no cross-brand team cards                          | unit                  | planned  |
| CPCFG-06 | Start fixture                          | open upgrade page  | Start name and 5M entitlement summary correct          | unit + E2E UI         | planned  |
| CPCFG-08 | `ZCODE_ENV=test`                       | request configs    | test-env endpoint used with client params appended     | unit                  | verified |

## E2E handoff notes

- Provider fixture: reuse `packages/desktop/test/e2e/fixtures/coding-plan-client-configs.json`;
  never copy the product arrays.
- Timing: in-App client-config cache tests need explicit cleanup.
- Desktop/mobile: the purchase page is already responsive; no conversation realtime
  state is added.
- Review risk: when team pricing merges by `productId`, the raw enterprise product
  must be preserved and payment parameters still come from the realtime product.
