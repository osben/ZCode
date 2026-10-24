# Conversation Session Case Coverage Audit

Goal: turn the conversation-area case count and coverage status from verbal bookkeeping into a repeatable mechanical check, so a "WDIO is green but the formal catalog still has uncovered cases" mismatch cannot occur.

Related documents:

- Main-path catalog: [conversation-session-case-catalog.md](../conversation-session-case-catalog.md)
- Main-path coverage matrix: [conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md)
- External environment fault catalog: [conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md)
- External environment fault coverage matrix: [conversation-session-fault-e2e-coverage-matrix.md](./conversation-session-fault-e2e-coverage-matrix.md)
- Decision backlog: [conversation-session-decision-backlog.md](./conversation-session-decision-backlog.md)
- Decision E2E roadmap: [conversation-session-decision-e2e-roadmap.md](./conversation-session-decision-e2e-roadmap.md)
- Decision review queue: [conversation-session-decision-review-queue.md](./conversation-session-decision-review-queue.md)
- Next decision review: [conversation-session-next-decision-review.md](./conversation-session-next-decision-review.md)
- Next product-decision answer template: [conversation-session-next-decision-answer-template.md](./conversation-session-next-decision-answer-template.md)
- Product-decision answer draft: [conversation-session-decision-answers.md](./conversation-session-decision-answers.md)
- Product-decision answer status: [conversation-session-decision-answers-status.md](./conversation-session-decision-answers-status.md)
- Product-decision backfill plan: [conversation-session-decision-backfill-plan.md](./conversation-session-decision-backfill-plan.md)
- Product-decision workflow board: [conversation-session-decision-workflow-board.md](./conversation-session-decision-workflow-board.md)

Full history: `git show 6c0f4203:docs/testing/conversation-session-case-coverage-audit.md`.

## Mechanical basis

Script: `scripts/audit-conversation-session-case-coverage.mjs`

Run boundary: the audit is run explicitly during E2E case planning, promotion and coverage inventory; it is not hooked into the default `pnpm test` / `verify:pre-push`. It checks the instant statistics of the catalog, coverage matrix, roadmap and generated Markdown; these files are often updated in stages during one E2E change, so putting it in ordinary unit tests would impose a too-strict process-state gate on every commit.

Command:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check
```

Completion gate:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --require-complete
pnpm audit:conversation-session-complete
```

A plain `--check` only proves that the statistics of the catalog, coverage matrix, decision backlog, worksheets, answer draft and generated docs are mutually consistent; it can keep passing while product decisions are outstanding. `--require-complete` is the final coverage gate: it must fail while any `undefined` / `decision-needed` product case or missing accepted case remains, or while the decision roadmap still sits at `blocked-by-product-decision`.

Generate the Markdown queue for product to review case by case:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md
```

Generate only the next review batch:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --review-next-md
```

Generate only a given case or the first N of the queue:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md --review-case F09
node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md --review-limit 3
```

Generate an answer template for product to fill in directly (defaults to the next review batch):

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --answer-template-md
node scripts/audit-conversation-session-case-coverage.mjs --check --answer-template-md --review-case F09
```

Check which cases of the answers draft are fully filled and which lack answers:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-status-md
```

Generate the backfill plan for fully filled cases:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-plan-md
node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-patch-md
node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-json
```

Preview the backfill plan with a temporary answers draft:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-path /tmp/conversation-session-decision-answers.md --backfill-plan-md
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-path /tmp/conversation-session-decision-answers.md --backfill-patch-md
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-path /tmp/conversation-session-decision-answers.md --backfill-json
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-path /tmp/conversation-session-decision-answers.md --require-backfill-clean
```

- `--answers-path` only replaces the product-answer source read by this audit, to rehearse the backfill action after a case is filled without polluting the real [conversation-session-decision-answers.md](./conversation-session-decision-answers.md).
- `--backfill-plan-md`, `--backfill-patch-md` and `--backfill-json` are three views of the same plan: `--backfill-plan-md` expands per case, `--backfill-patch-md` per file, `--backfill-json` for later automation. The plan contains ready cases, the product conclusion, source status, roadmap status, the suggested E2E spec and four backfill actions.
- Each ready case carries precise targets: `worksheetTargets` point at the protocol question rows, `sourceTargets` at the catalog / coverage matrix case rows, `roadmapTarget` at the decision E2E roadmap row, `e2eTarget` at the suggested spec; a target carries the current `line` and `current` value as an anchor against mis-edits before any later automatic patch. A replaceable Markdown table target also carries `expectedLine` (the current whole-line content in the file) and `replacementLine` (the whole-line preview with the product conclusion filled in) in JSON; an automatic backfill must compare `expectedLine` before replacing, so concurrent edits are not overwritten.
- `--backfill-json` additionally outputs a per-file `patchPlan`, collecting all replaceable lines into `files[].replacements` and the E2E specs to create or update into `files[].createOrUpdate`, for automatic backfill or diff generation; `--backfill-patch-md` renders the same `patchPlan` as a reviewable table.
- With the real answers file, backfill-clean is required by default: if a case's answers are filled but the worksheet / source coverage has not been backfilled, `--check` fails. A custom `--answers-path` only rehearses by default and does not trigger that failure unless `--require-backfill-clean` is passed. With a custom answers path the script does not check whether the generated Markdown in the repository is stale, because generated docs follow only the canonical answers file.

Generate the workflow status board linking answer draft / worksheet / source coverage / roadmap:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --workflow-board-md
```

## V4 formal admission mechanical boundary

The historical `A-J` coverage statistics answer "what automation evidence the product cases once had"; V4 formal admission answers "whether the specs in the current default formal directory carry a complete, independently replayable contract". The two statistics are independent: passing admission does not automatically raise a coverage status to `covered`, and pending legacy evidence does not enter the current formal admission count.

The reusable inspector is `scripts/lib/conversation-session-formal-admission.mjs`. Only direct-root specs of `packages/desktop/test/e2e/conversation-session/*.test.ts` go to the formal gate; `manual-review/**` is counted recursively as pending, but a legacy helper there does not fail the formal gate:

```text
conversation-session/*.test.ts
        |
        v
legacy + manifest + provider/file path + request ledger audit
        |
        +--> admitted ----------> formalAdmission.formal.admitted
        |
        +--> rejected ----------> --check nonzero + exact file/reason

conversation-session/manual-review/**/*.test.ts
        |
        +--> pending inventory --> does not enter admitted/rejected
```

Every direct-root formal spec must satisfy:

1. The TypeScript AST must contain no `ImportDeclaration` pointing exactly at `helpers/conversation-session.js` and no `CallExpression` whose callee is the identifier `prepareConversationE2E`. An old import inside a doc string does not cause a false positive, a real call inside a template expression is still found; transparent wrappers such as parenthesized, non-null, `as`, type assertion and `satisfies` are unwrapped recursively first. The audit does not crudely forbid all `TID_CHAT_*`; V4 may still reuse valid tool/history/toolbar/summary test ids.
2. The case manifest and the case-local provider fixture both exist; the manifest is version 1 and `caseName` and `spec` must point back exactly at the current formal spec.
3. The manifest must declare a case-local provider fixture. The provider path must be a relative path without traversal and contained in the desktop DeepSeek fixture root; a static file fixture must likewise be contained in the desktop fixture root, absolute or `..` paths are rejected directly. For an existing path the `realpath` of root and candidate are also compared, so a symlink inside the root cannot escape; a non-existent path keeps reporting missing. A runtime file descriptor is exempt from the existence check only when it provides a non-empty `path` and `description` and its `source` is one of `created-by-spec` / `created-by-helper` / `created-by-provider-tool`.
4. `providerRequestPolicy: "none"` may only accompany an empty `requests`; a request whose source/kind is `synthetic` in the manifest or provider fixture must have a non-empty `syntheticReason`. The converse also holds: when the case-local fixture and requests are both empty, policy `none` must be declared explicitly; a missing contract cannot pass as pure UI.
5. The provider fixture must be version 1 + a fixtures array; every item must have a non-empty `id` and object `match` / `response` / `metadata`, and metadata must fully declare kind/source/timing policy.
6. The manifest ledger must fully cover the request ids of the case-local fixture, keep the same array order, and match `kind`, `source`, `timingPolicy`, `syntheticReason` exactly item by item. Extra common requests may come only from the canonical `upstream/common.json` with fixture `metadata.kind=common`; other provider/other-case fixtures cannot pose as common, and duplicate manifest request ids are also rejected.

The focused inspector tests use real temporary directories and real JSON/file parsing:

```bash
node --test scripts/test/conversation-session-formal-admission*.test.mjs
```

`conversation-session-formal-admission-audit.test.mjs` spawns the actual audit CLI and verifies JSON/text output, exact errors and nonzero exit. Through the controlled environment variable `ZCODE_CONVERSATION_SESSION_FORMAL_ADMISSION_ROOT` it replaces only the inspector's synthetic root; the variable is usable only when the child process inherits the Node test runner's `NODE_TEST_CONTEXT`, and setting `NODE_ENV=test` alone exits with a test-only error. The catalog, coverage matrix and all other docs roots are still read from the real repository, and the real formal directory is never modified.

`--json` outputs the full inventory under `formalAdmission`. Stable counters live in `formalAdmission.counts`:

```json
{
  "formalAdmitted": 29,
  "formalRejected": 0,
  "pending": 92,
  "missingManifest": 0,
  "missingFixture": 0,
  "legacyHarness": 89,
  "legacyHarnessFormal": 0,
  "legacyHarnessPending": 89
}
```

Rejected items are in `formalAdmission.formal.rejected[]`. Each item has a repo-relative `specPath`, `caseName` and `reasons[]`; each reason has the schema `{ code, message, specPath, subjectPath }`. So `--check` fails with a stable reason code and exact spec/manifest/fixture paths, not just a summary number.

`--check` fails when:

- A direct-root formal spec is rejected by the admission inspector: legacy helper, missing manifest / case-local fixture or wrong identity, missing declared path, provider policy / synthetic reason violation, or the manifest and case-local fixture disagree in request id / order / metadata.
- An `A-J` main-path case is missing or extra between the catalog and the coverage matrix.
- A catalog `accepted` case has no coverage status in the coverage matrix.
- A catalog `undefined` case is wrongly written as non-`undefined` in the coverage matrix.
- A coverage matrix `covered` / `failing` / `partial` case has no automation abbreviation, or the abbreviation is not defined in the "test abbreviation" table.
- A spec file in the "test abbreviation" table does not exist or declares no `it(...)` / `test(...)`.
- A referenced spec file contains `describe.skip`, `it.skip`, `test.skip`, `describe.only`, `it.only`, `test.only`.
- An `undefined` case fills in an automation abbreviation and so looks like it has stable assertions.
- The "current statistics" table of the coverage matrix disagrees with the actual case table.
- The "current statistics" table of the environment fault catalog disagrees with the actual fault table.
- The fault coverage matrix lacks or has extra product fault rows relative to the environment fault catalog.
- A fault coverage matrix `covered` / `failing` / `partial` fault case has no automation abbreviation or the abbreviation is not defined in the fault "test abbreviation" table.
- A fault coverage matrix `decision-needed` fault case fills in an automation abbreviation and looks like it has stable assertions.
- A spec file in the fault coverage matrix does not exist, declares no `it(...)` / `test(...)`, or contains skip/only.
- The "current statistics" table of the fault coverage matrix disagrees with the actual fault coverage table.
- A `C01-C03` alias does not map to the main-path undefined cases `F09/G11/G12`.
- The decision backlog does not list all current `undefined` / `decision-needed` product cases, or still keeps a case that is no longer pending decision.
- The "current statistics" table of the decision backlog disagrees with the actual grouping of pending decision cases.
- The decision E2E roadmap does not list all cases that are not yet `covered`, keeps cases that are already `covered` or unknown, has a status outside the allowed set, or lacks a suggested spec / fixture / observation surface.
- The decision E2E roadmap status disagrees with the main-path / fault coverage matrix status, e.g. coverage is still `decision-needed` but the roadmap says `ready-to-write`, or coverage is already `missing` but the roadmap still says `blocked-by-product-decision`.
- The "current statistics" table of the decision E2E roadmap disagrees with the actual roadmap case table.
- The three decision worksheets do not fully cover all current pending-decision cases, or a worksheet still keeps a case that is no longer pending.
- The three decision worksheets do not fully list the protocol questions of the current pending-decision cases (the text says "40 cases / 49 questions" while the baseline below shows 37), a protocol question status is not `answered` / `unanswered`, or the "current statistics" table disagrees with the actual protocol questions.
- A protocol question lacks `需要确认` (needs confirmation), `候选答案摘要/验证关键词` (candidate answer summary / verification keywords) or `回写目标` (backfill target), so the review queue could give only a number and not go straight into product confirmation.
- A protocol question has `Status=answered` but `产品结论` (product conclusion) is still empty / `TBD` / `待确认` / `待产品确认`.
- A protocol question has `Status=unanswered` but already has a non-placeholder `产品结论`, so conclusion and status disagree.
- A question number in the decision answer draft does not exist, or the same question appears more than once.
- The decision answer draft must keep a fillable placeholder row for at least the current protocol questions; a placeholder without a conclusion is counted as `placeholder-only`, and only a truly missing placeholder row goes to `missing`.
- In the canonical decision answer draft a case is fully filled but the decision worksheet / source coverage is not yet backfilled; this blocks the leak of "product answered but coverage status still stuck at blocked". A custom `--answers-path` enables the same gate only with an explicit `--require-backfill-clean`.
- In a decision worksheet a case is fully `answered` but the source catalog / coverage matrix is still at `undefined` / `decision-needed`; the conclusion entered the worksheet without the source facts being backfilled.
- The case set of decision readiness differs from the decision backlog. A case enters ready only when all its protocol questions are `answered` with an explicit `产品结论`; otherwise it stays blocked.
- The decision review queue sorts the current blocked cases by backlog batch and, in `--json` output, carries each unanswered question's text, candidate answers/verification keywords and backfill target. It is not a product conclusion; it only makes the order and content of the next questions repeatable.
- A script-generated review queue, next review, answer template, answers status, backfill plan or workflow board disagrees with the current script output, or the file is missing. This stops the docs given to product from staying on an old version after the case scope changes.
- With `--require-complete`, if the merged and de-duplicated product cases still have pending product decisions / automation, or an accepted case has no stable coverage, the command fails. This gate is for final acceptance and a plain `--check` pass cannot replace it.

## Current baseline

This is not the product completion definition, only a baseline against statistics drift:

| Metric                                           | Current value |
| ------------------------------------------------ | ------------: |
| Main-path A-J cases                              |           163 |
| Main-path accepted                               |           163 |
| Main-path undefined                              |             0 |
| Main-path covered                                |           113 |
| Automation abbreviations                         |            93 |
| Specs referenced by the coverage matrix          |            62 |
| Specs with test declarations                     |            93 |
| Referenced spec skip/only                        |             0 |
| New external fault product cases                 |            37 |
| External fault aliases                           |             3 |
| External fault infra cases                       |             4 |
| Fault coverage matrix rows                       |            40 |
| Fault coverage matrix covered                    |             0 |
| Fault coverage matrix decision-needed            |            37 |
| Fault coverage matrix missing accepted           |             3 |
| Decision backlog rows                            |            37 |
| Decision E2E roadmap rows                        |            87 |
| Decision E2E roadmap expected rows               |            87 |
| Decision E2E roadmap blocked-by-product-decision |            37 |
| Decision E2E roadmap ready-to-write              |            29 |
| Decision E2E roadmap implemented                 |            21 |
| Decision worksheet covered rows                  |            37 |
| Total protocol questions                         |            37 |
| Protocol questions answered                      |             0 |
| Protocol questions unanswered                    |            37 |
| Answer draft rows                                |            37 |
| Answer draft answered                            |             0 |
| Answer draft pending placeholder                 |            37 |
| Answer draft missing question rows               |             0 |
| Answer draft ready-to-backfill cases             |             0 |
| Answer draft placeholder-only cases              |            37 |
| Answer draft partial cases                       |             0 |
| Answer draft missing cases                       |             0 |
| Backfill workflow draft-ready cases              |             0 |
| Backfill workflow worksheet-ready cases          |             0 |
| Backfill workflow source-backfill-needed cases   |             0 |
| Decision workflow board cases                    |            37 |
| Decision ready cases                             |             0 |
| Decision blocked cases                           |            37 |
| Review queue cases                               |            37 |
| Review queue next                                | N01, N02, N03 |
| Generated Markdown docs                          |             6 |
| Generated Markdown stale                         |             0 |
| Generated Markdown missing                       |             0 |
| Compact P0 protocol questions                    |             0 |
| Network/SSE protocol questions                   |            16 |
| Recovery/Isolation protocol questions            |            21 |
| Merged and de-duplicated product cases           |           200 |
| Merged and de-duplicated covered                 |           113 |
| Merged and de-duplicated pending decision / automation | 87      |
| Completion gate required                         |            no |
| Completion gate coverage complete                |            no |
| Completion gate covered                          |       113/200 |
| Completion gate decision-needed                  |            37 |

When new product semantics are added, they must first enter the catalog and let this audit report the new gap; update the coverage matrix only after the matching E2E or product decision is filled in. As long as a case cannot yet carry a stable assertion, it must also appear in the decision backlog, to ease product review and pruning.
