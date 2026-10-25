# Todo161: Preserve the output limit in the first migration of the old CLI config.json

Status: re-ported on the latest staging on 2026-10-14; the production fix, 61 targeted regression tests
and the necessary static checks pass (see the last section). The September results are kept as history.

## Background and findings

The evaluation team still defines Providers and model output limits in the legacy `config.json` under the
CLI config directory and needs that value preserved at the first import into the new Provider config.

- Default source `~/.zcode/cli/config.json` located by `getDefaultConfigPath()`; Standalone's existing `legacyCliUserConfigFilePath` injection entry stays usable.
- The [legacy-format parser](../../../../apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-model-config.ts) already accepts a model's `maxOutputTokens`, `limit.output` and `options`.
- The [CLI importer](../../../../apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts) projected members keeping only `contextWindow` and skipped members without context when creating model rules, so the output limit was lost.
- The [legacy config tests](../../../../apps/zcode-cli/packages/adapters/tests/config.test.ts) record the priority `limit.output` -> `options.max_tokens` -> model-level `maxOutputTokens`.
- The [current import test](../../../../apps/zcode-cli/packages/bootstrap/tests/legacy-cli-personal-provider-config-importer.test.ts) had an assertion "do not migrate the output limit in historical model options" that is replaced by this decision.
- The 2026-09-16 investigation ran 13 CLI import tests: 5 passed, 8 failed (the tests still asserted the old serialization structure). The real evaluation-team sample was not checked; no Key or full user config is stored.

## Confirmed scope and field contract

1. Only the **Standalone CLI first import of the old config** changes; input is `provider.<providerId>.models.<modelId>` of the old user file. Existing Provider identity, source, deleted-item and duplicate-member filtering rules are kept.
2. The output limit takes the first valid positive integer by `limit.output` -> `options.max_tokens` -> `maxOutputTokens` and is written to the new model rule's `config.optionSpecs.maxOutputTokens.max`. The whole Built-in model config is not materialized and neither the API parameter mapping nor arbitrary options are copied; the map keeps coming from the existing config composition chain.
3. A model with an output limit but no `contextWindow` must also produce a rule; both are kept when both exist. If both are missing, existing behavior stays; a missing output field writes no default.
4. Invalid values do not enter the new config; the existing parser's input validation boundary is kept; tests cover the priority among valid candidates and invalid `options` values (no implicit numeric coercion accepting strings or decimals).
5. **Already-migrated users are not handled.** When the formal Personal config exists the direct read stays: no back-fill, no overwrite, no migration version or marker, and no continued reading of the old file. Whether an output limit edited in the old file takes effect on a later start is still bound by this first-import boundary.
6. The Desktop `legacyPersonalProviderConfigImporter` is untouched: no desktop old Store, project config or environment-variable output values. The original CLI old file is kept, with no double write.
7. No extension to `options.extra_body.max_tokens`, `max_completion_tokens` or other compat fields; reasoning levels, account, default selection and other migration semantics unchanged; only the three confirmed output-limit fields.

Migration and execution order follow the single persistence owner of [Todo33](todo-33-personal-provider-config-file-cutover.md):

```text
Standalone Provider Runtime -> Personal Repository checks the formal file
  exists: read the formal config, end legacy-file import
  missing: recheck under the lock -> CLI Legacy Importer reads the old config.json
           -> extract sparse context / output rules -> atomically save Personal config
           -> Registry composition -> normal model requests
```

This supersedes the "output limit not migrated" expectation in the CLI import tests; the Desktop and already-migrated-user compatibility scope is not widened.

## Implementation and acceptance (all done)

- [x] The applicable current migration spec was synced to the final contract before implementing (history kept).
- [x] Regressions first: the three fields migrate individually, priority when several exist, output-only, context+output together, missing and invalid output, deleted and duplicate model filtering; prove the old implementation loses values, then change the CLI importer.
- [x] Outdated serialization assertions in that import test file were fixed (asserting the current formal rules and fields first), not widened into other product semantics.
- [x] A temporary CLI config dir and offline Provider fixtures cover old file read -> first import -> formal file save and reread -> Registry composition: explicit output kept, API map still inherited, old file unchanged.
- [x] With the formal config present, changing the old file's output limit and restarting does not re-import (no promise to keep reading the evaluation old config).
- [x] A local scripted Provider captures the actual CLI model request, proving the migrated value reaches the matching API output-budget field (not just JSON save success; no real Key or paid model).
- [x] Affected tests, typecheck, lint, architecture checks and self-review per root and CLI rules, separating pre-existing failures, this result and unverified items. Start with `pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/legacy-cli-personal-provider-config-importer.test.ts` (root unit tests do not replace CLI verification).

## 2026-09-17 implementation and verification record

Production change only in the CLI Legacy Importer: take a finite positive integer by the confirmed
priority and generate a sparse rule for output-only or context+output models; the parser, Desktop importer,
Repository lifecycle and persistence Schema are unchanged. The current configuration spec and Todo35's
later decision were synced and the old import test changed to current rule-structure assertions.

- On the unmodified implementation 17 of 34 regression tests failed, all pointing to missing valid output rules; after the change import, field-boundary, default-selection integration and local-request integration 40 pass; process Registry and model-factory caller tests 19 pass (59 total).
- A new runtime test starts an ordinary Agent Turn through a temporary CLI `config.json`, the real Standalone composition root, the Personal file and the Registry, sending real SDK requests to a local HTTP fixture. `max_tokens`, `max_completion_tokens` and `max_output_tokens` of the three APIs all captured `24000` (no request budget specified by the test caller). The fixture deliberately returns 400 to end the turn: the target is the outbound parameter, not successful upstream generation.
- A restart reads the persisted formal file; even with the old file changed to `8000` the Registry stays `24000` with the formal file bytes unchanged; the first import also left the old file bytes unchanged; no real Key or paid model.
- `pnpm typecheck`, `pnpm lint` (54 warnings / 0 errors), `pnpm --dir apps/zcode-cli typecheck` (28 tasks) and `pnpm architecture:check --changed` (0 violations) pass (CLI is a legacy module in the architecture policy, so passing is not full runtime proof); local lint/format of the 4 TypeScript files, diff and doc-link checks pass.
- `pnpm --dir apps/zcode-cli lint` failed with 5 `max-lines` errors in unmodified files (e.g. `contracts/src/workflow/index.ts`, `interfaces/session-store.port.ts`, `interfaces/browser-control.port.ts`, `events/event-reducer.ts`, `model/index.ts`; Bootstrap `plugins.ts` etc.), compared with HEAD with no change; not bypassed by changing rules or widening a refactor. The user, knowing the existing line-count errors, explicitly asked to commit directly; committed as authorized with the failure recorded (other tasks' workspace changes were not included).

Not verified: the real evaluation-team config, successful external model responses, Windows/macOS real
machines; no desktop or phone interaction changed.

## 2026-10-14 re-port on staging

The old fix commit `bb7f88002c` stayed on the old feature branch and never reached staging. A separate fix
branch was created from `5e74234f49`, porting only this fix, its tests and spec.

- The production conversion logic follows the original fix; the current staging tests already fixed the serialization structure and are kept, with only the output-budget expectations added.
- At run time `createSqliteSessionStore()` turned out to be an async factory; the request-integration fixture now awaits initialization (production storage and request chain unchanged).
- Before the production change 17 of the 34 import regression tests failed due to the lost output limit; after the fix the related 6 test files total 61 pass, including regressions added to existing callers.
- Real SDK requests for the three APIs were captured at `24000` by the local HTTP fixture; formal-file reread, unchanged old file and no re-import on restart still pass. The fixture's 400 is the test design to end the request, not an external success.
- Root affected preview and the real run selected 0/2633 (CLI is not in the root suite; the CLI targeted regressions above cover it); the full unit suite was not run.
- Root `pnpm typecheck` and CLI `typecheck` (30 tasks) pass; root lint 0 errors / 210 warnings, CLI lint 0 errors / 68 warnings plus 14 unchanged upstream line-count diagnostics accepted under the existing policy (the September line-count blocker is gone). `pnpm architecture:check --changed` 0 violations; the 4 TypeScript files pass the CLI's own formatter check; diff, doc reference and open-source vocabulary checks pass. Only the current task scope was verified.
- Real evaluation config, successful external model responses and Windows/macOS real machines are unverified. Product scope stays limited to the CLI first migration; a locally prepared branch does not mean merged to the remote staging.
