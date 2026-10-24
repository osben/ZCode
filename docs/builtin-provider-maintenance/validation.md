# Configuration Validation and Manual Collaboration

## Validation layers

| Layer | What it can prove | What it cannot prove |
| --- | --- | --- |
| Official material | Declared models, protocols, parameters and lifecycle | That a given account/region/plan can actually use it |
| Decoder/Schema | File structure, fields and value ranges are legal | That every model is finally complete, or that the remote supports these parameters |
| Resolver/Map tests | Override order, complete execution configuration, parameter mapping | That the vendor actually accepts the request |
| Local HTTP/replay | Request encoding, stream consumption, tool loop and configuration wiring | The current public endpoint, key permissions and real model behavior |
| Real API | The measured result for this entry, model, protocol and account | Other plans, regions, protocols, or being always available in the future |
| Product E2E / package validation | UI configuration to the target execution chain and actual resources | That all vendors and platforms pass |

Every layer records its scope and date. A successful `GET /models`, an SDK that can be created, or one successful connection test must not be written as full Agent support.

## Manual handoff for obtaining an API key

First finish the credential-independent material, spec, tests and candidate diff, then give collaborators an executable request: vendor, concrete product/region, model list, ordinary API or plan key, required permissions, expected number of requests, maximum cost and the purpose of test data. A new subscription, a top-up and a quota increase are confirmed by a person; spending must not be expanded on one's own for "full validation".

The collaborator enables the corresponding product in the official console, confirms model permissions and balance, and delivers via an approved Secret manager/restricted local configuration. When environment variables are needed only the variable names are recorded and the process reads them; keys are not written into command arguments, chat, Git, MRs, screenshots or logs. A temporary key should have minimum permission and be revocable, and after validation it is revoked or returned to management as agreed with the collaborator.

The test environment does not provide free keys automatically: ordinary templates in the current test JSON still use the production vendor address. An API key, a Coding Plan/Token Plan key and web-login entitlement cannot be mixed; even for the same brand confirm each separately. Insufficient permission, insufficient balance, unsupported region, rate limiting, service fault and parameter error are recorded separately and not uniformly attributed to model incompatibility.

This documentation cleanup requested or obtained none of these keys; each new observation still needs this handoff. When a key cannot be obtained, an MR with an explicit blocker may be prepared; fabricating pass records, widening existing validation scope or going live dynamically on one's own is not allowed.

## Minimum real-request matrix

Trim by change scope. For added/changed members, confirm each ID is callable; cover parameter and protocol differences one by one, and one flagship model cannot represent a whole brand.

| Scenario | What to verify |
| --- | --- |
| Connection and basic stream | Actual URL/protocol/Header, model identity; the stream ends normally, usage and finish reason; a mid-stream error cannot count as success |
| Tool loop | Declare tool → streamed argument assembly → return tool result → continue answering; tool IDs/message order correct |
| Thinking levels | The final Body of the Map for each public value, especially off/lowest/highest levels and models that cannot be turned off |
| Output limit | Cap and explicit budget verified separately; illegal values fail explicitly; no silent truncation or secretly retrying with an added budget |
| Media and structured | Verify separately the image, video, audio, PDF and JSON Schema declared/adjusted this time; mark untested items |
| System and history | For MCS, reasoning history, encrypted content or new protocols, check multi-turn replay, post-tool turns and system message handling |
| Adjacent variants | Base model/Flash/FlashX/vision/aggregator prefix and suffix; confirm rules do not cross-apply |
| User configuration | Inherited value refresh, explicit personal override retained, default enablement, existing instance address/name and saved selection |

Use minimal prompts and test attachments without personal information. A million-context or max-output stress test needs its own budget, and a configuration value must not be validated by default with a full-capacity request. A normal smoke does not claim to cover the capacity upper bound. Real-time latency and rate-limit fluctuation are recorded as observations, avoiding arbitrary sleeps that hide configuration problems.

The product connection probe proves only the connection steps it actually ran and cannot be automatically equated with the matrix above. When the probe budget needs adjusting, first check the value, request path and success criterion against the current code, record the intended behavior change in this directory and add a regression; a historical suggested value must not be treated as a current fact.

## Repository check entries

Run the following commands from the repository root. Pick files by this change and do not run an unauthorized full unit suite:

```bash
pnpm provider:config:check-test
pnpm exec vitest run packages/provider-node/test/zcode-builtin-integrity.test.ts
pnpm exec vitest run packages/provider/test/model-config-rules.test.ts packages/provider/test/provider-template.test.ts
pnpm exec vitest run packages/provider-node/test/zcode-builtin-reasoning-map.test.ts
```

Reference tests also include `packages/provider-node/test/new-model-catalog*.test.ts`, `opencode-go.test.ts`, `openrouter-reasoning-contract.test.ts`, `zhipu-api-templates.test.ts`; add per this change's new boundary and do not merely edit snapshots to make failures disappear.

The final-file integrity test supports `ZCODE_BUILTIN_RELEASE_TEST_FILE` to point at the actual file; validate the production and the generated test configuration separately. POSIX shell example:

```bash
ZCODE_BUILTIN_RELEASE_TEST_FILE="$PWD/config/provider/zcode-builtin.test.json" pnpm exec vitest run packages/provider-node/test/zcode-builtin-integrity.test.ts
```

Other shells use the corresponding way of setting environment variables, and the value is still the actual absolute path. This test contains business assertions of the current directory and is not a general compatibility test for any old Release; assertions must not be loosened to accept a historical file.

Ordinary code changes run `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` and `pnpm test:unit:affected --base <start commit>`. CLI code additionally runs `pnpm --dir apps/zcode-cli typecheck`, `pnpm --dir apps/zcode-cli lint`, and uses its package scripts/Turbo to select affected packages and callers' tests; the root affected unit tests cannot replace CLI tests. When the CLI scope cannot be determined reliably or shared test infrastructure changes, run `pnpm --dir apps/zcode-cli test`.

An APP interaction change adds the desktop E2E scenario first and then implements; cover new instance, existing-instance inheritance, explicit-override retention, model selection and the real execution chain, plus the mobile path as impact requires. Scenario, spec and test case stay consistent; verify with `pnpm test:e2e` choosing the range by the specs actually affected, and a pass of one local HTTP fixture is not public-network vendor validation. A visual change also needs desktop/mobile, light/dark themes and the related languages. When the environment is missing, list the unvalidated combinations and do not write all as passed.

A change of dual-environment build or generation strategy should also cover `packages/provider-node/test/builtin-provider-build.test.ts`, `builtin-provider-test-config-sync.test.ts` and the corresponding script tests under `scripts/test/`. Use temporary Releases with different content to verify environment priority, missing/bad files, same-environment content update, resource refresh when JS already exists, SEA and the final embedded content. The two real JSONs are decoded separately, and billable model calls are not required for build validation.

Pure docs check only links, commands, references and consistency. When a necessary check fails or the environment blocks, keep the change and evidence without auto-committing; after passing, self-check the diff and commit this content. Push keeps the `pnpm verify:pre-push` gate and does not bypass hooks; the root full unit suite is not run without an explicit request.

## Evidence retention

Record time, commit, production/test, configuration revision/hash, templateId/modelId/protocol, account product and region (without personal identity), the cases and pass/fail/not run. Request/response evidence keeps redacted parameters, status codes, finish reasons and necessary logs; remove Authorization, Cookie, keys, signed URL queries, private prompts and reasoning bodies. When a replay is needed, first check the fields the collector actually saves, then redact, review manually and verify replayability; submitting raw network captures directly is forbidden.

A validation record of one entry must not be reused as a pass conclusion for another plan or aggregating site. On failure first keep the minimal reproduction and runtime logs, distinguish rule, Adapter, permission and upstream problems, then decide whether it is a configuration fix or needs a design change.
