# Kimi K3.1 Pro: entries and configuration contract

Status: implemented / pending-key-validation

## Scope

Verified on 2026-10-26. After merging the latest staging, the following 8 members were added on top of revision 35 of the existing vendor expansion branch, with production/test synced as revision 36, all default enabled. All old members, enablement, order, endpoints, capabilities and shared rules are kept; new members are placed at the start of each template's enabled group and existing sessions are not switched. The additions use only exact templateId/modelId overrides and do not widen the K3 family regex.

| Template         | Added model IDs                        | Existing protocol |
| ---------------- | -------------------------------------- | ----------------- |
| moonshot-kimi    | kimi-k3.1-pro, kimi-k3.1-pro-highspeed | Messages          |
| kimi-code-cn     | k3.1-pro, k3.1-pro-highspeed           | Chat              |
| kimi-code-intl   | k3.1-pro, k3.1-pro-highspeed           | Chat              |
| openrouter       | moonshotai/kimi-k3.1-pro               | Messages          |
| opencode-go-chat | kimi-k3.1-pro                          | Chat              |

The ordinary API and Coding Plan use different model IDs and credentials. OpenRouter and Go have no separate Highspeed IDs, so the original vendor's catalog is not copied; the public catalogs of Zen, SiliconFlow and the Bailian plan do not list them yet, and no speculative members are added. No new Provider template, Adapter, authentication or SDK change is needed.

The later revision 37 only adjusts the position of the template blocks per the [vendor display order](./configuration.md); the revision 36 model-addition contract on this page and the member order inside templates stay unchanged.

## Parameters and evidence boundaries

- The original vendor and Kimi Code support low/high/max, force thinking, and provide no none/disabled. The ordinary API Messages path reuses the existing output_config.effort mapping with the output field max_tokens; Kimi Code Chat uses reasoning_effort and max_tokens. The Messages response is still the existing thinking/text/tool_use and signature contract.
- Kimi Code's official default when no effort is passed is high, and the ordinary API Chat officially defaults to max. When ZCode actively selects the new model it picks the last entry of the level list per the existing contract (the highest level max) and sends it explicitly; this is not the same as inheriting the vendor's default for an omitted parameter. This round adds no default-level field, reorders no levels and changes no selection logic.
- The OpenRouter catalog lists low/high/max/none with default max, but the original vendor forbids turning thinking off. The first batch explicitly provides the low/high/max both sides agree on; the catalog's none is not taken directly as a validated capability of this Messages path, and turning thinking off awaits explicit protocol/real-request evidence of this entry before being discussed. The existing Messages effort mapping is used.
- The Go official catalog and protocol table already list kimi-k3.1-pro and the Chat path is reusable; the first batch follows the existing Go K3 max-level request contract and sends only reasoning_effort=max, without inferring the aggregating entry's full level set from the original vendor. Other levels await independent Go evidence. The original template address stays in use and existing endpoints are not migrated.
- All eight have a window of 1,048,576. Kimi Code's real window and Highspeed entitlement depend on the plan. OpenRouter's output cap adopts this entry's catalog value 943,718; the rest keep a 131,072 request budget, which is a conservative configuration budget, and the ordinary API Chat maximum of 1,048,576 must not be copied to Messages, Coding Plan or Go.
- All eight declare text/image/video input and tool calling; audio/PDF/native search are not declared; OpenRouter declares structured output per its catalog, and the other entries do not infer it from Chat capabilities for now. A model supporting media does not mean the client gained new media-upload features.

## Official sources

- [Kimi ordinary API catalog](https://platform.kimi.com/docs/models): the two ordinary API IDs.
- [K3.1 Pro quickstart](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart), [reasoning effort](https://platform.kimi.com/docs/guide/use-reasoning-effort), [Messages](https://platform.kimi.com/docs/api/messages): original-vendor parameters, responses and request fields; the Messages page already has a K3.1 Pro call sample.
- [Kimi Code models and plans](https://www.kimi.com/code/docs/en/kimi-code/models.html): two regions, two new models, entitlements, windows and levels; the official default was updated from max in earlier material to high.
- [OpenRouter catalog](https://openrouter.ai/api/v1/models), [model page](https://openrouter.ai/moonshotai/kimi-k3.1-pro): exact IDs, capacity, media and optional parameters; the none difference from the original vendor is kept pending verification.
- [Go catalog](https://opencode.ai/zen/go/v1/models), [Go official protocol table](https://opencode.ai/v2/docs/console/go/): the new model uses Chat; the [Zen catalog](https://opencode.ai/zen/v1/models) does not list it yet.

## Acceptance and retained boundaries

Both environments are validated separately: exact members/enablement, final capabilities, the actual request patch of every selectable level, no thinking-off level, unchanged semantics and order of the old configuration, priority of personal overrides, and template rules not polluting same-named custom entries. When maintaining the existing member-inventory tests, explicitly add only these eight identities; the old frozen summaries stay, and the revision 35 configuration is frozen separately so that relaxing the addition filter cannot mask existing changes.

Real-key validation must separately cover ordinary/plan and domestic/international entitlements, streaming responses, at least two tool-loop rounds with thinking-history passback, media, request budgets and plan caps. The original vendor's documentation recommends creating a new session when switching to a new model; this round develops no session migration, automatic re-selection or online delivery.

## This round's validation state

After merging staging `90c8ee76c6`, the 33 vendor-configuration test files passed, 382 tests, of which 20 were added by this spec; typecheck, lint (191 pre-existing warnings, 0 errors), the architecture gate, the production/test configuration sync check, and the inventory/summary/directory link checks passed. The new scenarios first confirmed failure on the old configuration and then verified pass with the added configuration.

Running the affected unit tests with the task start point `dd10b6e7bf` selected 1,922 test files and reported 1,909 passed, 9 failed, 3 skipped, plus one worker out-of-memory error; the test report was 21,117 passed, 7 failed, 48 skipped. The full root unit suite was not run or substituted. The failures were as follows:

| Check                                                                  | Result and boundary                                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktopE2EContainerScript.test.ts`                                    | The Docker documentation table format does not match the exact assertion; rerun still fails.                                                                                                 |
| `e2eRuntimePaths.test.ts`                                              | Six E2E sources contain forbidden system temp paths; rerun still fails.                                                                                                                      |
| `r3RemoteSpecInventory.test.ts`                                        | The queue lacks a damaged-release case; rerun still fails.                                                                                                                                   |
| `reactStableReferences.test.ts`                                        | `SettingsScopeDevice.tsx` inlines a Context object; rerun still fails.                                                                                                                       |
| `e2eDesktopBuildCache.test.ts`                                         | The development-only variable `ZCODE_REACT_SCAN` is hit by the whole-file scan; the check and the variable inventory are not coordinated; rerun still fails.                                 |
| `remoteFrontendOssPublish.test.ts`                                     | CI added a desktop-preview include and the test's exact list was not updated; rerun still fails.                                                                                             |
| `projectPrimaryRootUnresponsive.test.ts`                               | Fails in the batch run and passes when rerun alone.                                                                                                                                          |
| `storagePreparationProtocol.test.ts`, `dev-cua-plugin-runtime.test.ts` | The CLI's adapters/contracts build dependencies are missing; attempting a frozen install of the CLI dependencies failed because the existing lockfile lacks `@withfig/autocomplete@2.692.3`. |

The tests, sources and input files corresponding to the failures above are all identical to staging `90c8ee76c6` and were not modified this round; the lockfile was not changed and the scope was not widened to unrelated fixes. Rerunning the nine test files above in a separate workspace of the latest pure staging `e06710b7bd`, six assertions still failed and two files still failed to load CLI dependencies, while the directory probe passed; the result was 186 passed, 6 failed, 2 files failing to load. This evidence confirms the failures do not depend on this branch's vendor changes, and the maintainer reported them to the responsible owners.

Clarified on 2026-10-26: these baseline failures unrelated to this change do not block the configuration commit/MR. The failure facts are kept and delivery continues per [validation scope and commit judgment](./validation.md); no all-green full-repo check is claimed. The branch keeps merging `e06710b7bd`, and pushed affected unit tests take that integration baseline as their reference; real-key validation still awaits manual collaboration.

Re-verified after merging the latest staging `e06710b7bd`: the 33 vendor-related files passed, 382 tests; typecheck, lint (191 warnings, 0 errors), the database schema compatibility check (8 items plus the actual schemas of both databases), architecture tests (36 items) and the architecture gate passed. The production/test configuration sync and the documentation inventory checks passed.
