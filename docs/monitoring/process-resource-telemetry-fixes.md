# Process-resource telemetry review fixes: impact and verification

## Feature summary

On 2026-09-15, R1-R7 and N1/N2 were fixed on top of `3e6ac3d643`. Mode: planning / implementation; change layers:
validation, commit-effect; transient memory grouping and de-duplication are not task persistence or recovery.
Behavior contract: [main spec](./process-resource-telemetry.md#复审修复契约2026-09-15). Out of scope: UI hints,
hard version gates, RPC framework refactor, task/queue/recovery protocols, online ARMS configuration.

## UI surface matrix

| Scenario / entry                    | Shared implementation and authoritative owner     | Validation and side effects                         | Mode / isolation                                   |
| ----------------------------------- | ------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Desktop connects a standalone Server | connectServerRemote → Host connection handle     | server-info capability decides the side subscription | Connects without the capability; no change to workspace drafts or tasks |
| Desktop local and SSH/WSL/Docker    | Host services → main telemetry exit               | Companion process keeps the subscription            | No change to the corresponding UI, runtime state or settings |
| Same-Server Bash from several windows | CLI single-command owner → main                 | Completion-token validation, bounded de-dup, ARMS projection | Event count does not grow with connection count |
| Mobile remote-control attachment    | Agent connection scope                            | Telemetry events stay empty                         | continuous/replayable recovery semantics unchanged |

UI, candidates, defaults and persistence are unchanged. Host forwarding and the main exit are shared; a Server is
subscribed only when it explicitly supports the capability, and local and companion deployment paths keep their
existing capability. Different environments aggregate separately, instances of one environment are summed; a
missing new field stays compatible with old producers.

## Feature relationships / state owners and commit sinks

| Level          | Chain / owner                                           | Reason and basis                                                          |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| must-inspect   | shared server-info → both Server kinds → Host helper/index | Declaration, parsing and subscription gate of the new capability must agree |
| must-inspect   | CLI Bash owner → shared protocol → services/Host → main | completionToken is generated before fan-out and de-duplicated at the single exit |
| must-inspect   | Host environment identity → CLI/MCP source → window aggregator | Isolation key flows through; the allow-list projection leaks no identity |
| must-inspect   | CLI source → external app totals                        | Arrival time belongs to the original reading; delivery must not extend validity |
| should-inspect | Host self heap / renderer heap                          | Same-tick maximum and delivery-clearing rule agree                        |
| invariant-only | terminal attachment / task realtime / CommandInbox      | No new session subscription, queue, snapshot or replay state              |
| evidence-only  | telemetry tests / CI guard                              | Contracts verified with trigger-scenario assertions; passing tests do not extrapolate to real machines |

## Must-preserve invariants

- CPU/RSS of one runtime environment is summed only within its own group; hardware spec is not identity.
- Sample expiry is based on the actual receive time; a timer produces no new reading fact.
- Completion token and environment identity are used only for side-channel memory; the event attribute allow-list
  and the 20-attribute limit are unchanged.
- Main has no external sampling process; no new periodic timer, disk queue or persistence.
- A telemetry exception does not affect Bash completion, remote connections or desktop/mobile task delivery.

## Codegraph evidence and graph delta

No codegraph tool was available, so no codegraph impact scan was run; the fixed diff, direct-call search and the
architecture context replaced it at about depth 2: local/remote entries of `registerHostServiceResourceTelemetry`,
the Host-main dispatch of `ingestCliResourceSample` / `ingestMcpResourceSamples`, and the protocol producer and
allow-list exit of `ingestToolExecResource`. Not every statically reachable node is treated as product impact. The
telemetry capability's doc list lacked the main process-resource spec; that entry and the invariants
"environment isolation" and "completion token not sent out" are added. Existing UI surface and task state owners
are unchanged. No open question blocks this fix; per-item fixing was authorized, the existing contract "one event
describes one runtime environment" is used, and a missing capability on an old Server keeps the connection. A UI
hint or requiring old Servers to upgrade is not a necessary fix.

## Accepted cases

| Case    | Setup and action                                            | Assertions                                                             | Evidence / status                                                      |
| ------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| PRT-031 | Old/new server-info, establish the Host telemetry subscription | Missing capability: no subscription and the server stays alive; capability present: the four side channels work | schema / Host / localhost WS integration pass; old Core probe exit 0 |
| PRT-032 | One completion token arrives repeatedly via different Hosts; same metrics with different tokens | The former reports once, the latter separately; the set is bounded and cleared on reset | protocol / CLI / main regressions pass; cap and reset verified |
| PRT-033 | chat/aux out of phase, aux stops updating, periodic and exit flush | New readings delivered per group; old readings total two periods before exit | Controlled-clock regression passes, incl. same-group instance expiry and CLI/MCP budget |
| PRT-034 | Same spec in different environments, and several instances in one environment, CLI and MCP | No cross-environment sum; same environment summed; final attributes carry no identity | Host / source / window / exit regressions pass |
| PRT-035 | Two Hosts' heap high→low and low→high in the same tick     | Same maximum, not redelivered on the next tick                         | selfHeap / integration regressions pass                                |
| PRT-036 | Actual source paths, forbidden calls and exemptions         | All protected; legitimate on-demand sampling exemptions still valid    | guard / repo hygiene pass, 73 files / 2 effective exemptions           |
| PRT-037 | Backtick inside regex, character class, division, comments, templates | Real calls hit, real comments ignored, no state drift repo-wide | guard 31 regressions pass, incl. real stability source                 |

High-risk combinations: Server capability x connection, instance x environment, reading phase x expiry, Bash
completion x several Hosts. Theme/language/screen size are pruned (no UI change); task stream/snapshot are verified
only as invariants since the side channel is isolated by attachment. The main spec gains the compatibility,
privacy and mixed-deployment acceptance of the new field; old test files gain the above trigger conditions. The E2E
entry is the existing resource-role case, with side-channel de-dup and environment-grouping verification added; no
model-provider recording is needed.

## Verification record

Pre-implementation freshness and post-implementation `architecture:check --changed` pass with no new architecture
violation.

- App-side targeted Vitest: 24 files / 268 tests passed; then same-group expiry and source-budget regressions: 3
  files / 39 tests passed; shared event allow-list and doc contract: another 10 passed. Tests failed first and
  passed after implementation; no old assertion was changed into wrong behavior.
- CLI Bash telemetry and real lifecycle: 2 files / 16 tests passed; old/new input compatibility of the protocol
  completion token verified.
- pnpm typecheck, pnpm lint and desktop typecheck:e2e pass; root lint 0 errors / 43 pre-existing warnings.
- Gate and repo hygiene: 73 tracked files, 0 violations, 2 effective exemptions; graph YAML parsing, node-ID
  uniqueness and existence of this capability's doc/code seeds pass. No codegraph index scan is claimed.
- The extra CLI package full check did not pass: 55 pre-existing interface/fixture/migration mismatches at the
  fixed HEAD plus 1 suite importing a deleted module; 8 concurrent failures passed when re-run serially (load root
  cause unconfirmed). Related code was compared with the baseline verbatim and this change's UUID logic is not on
  those failing paths. The package lint's 26 max-lines errors are all in unmodified files; the targeted Bash
  source lint passes.
- The first Electron smoke failed at Host startup because a parallel typecheck overwrote the out/host bundle (an
  isolated utilityProcess reproduced ERR_MODULE_NOT_FOUND). After a serial full rebuild PRT-023 passed: 1 spec / 1
  case, exit code 0, verifying real main / renderer / Host and system events. Report:
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260915105255962-p18104-75dc094004a00c1b/summary.md`.

R3 fixed a gap in the original candidate: device totals update by each instance's original arrival time, so another
active instance of the same group cannot keep an exited process alive. The external cache budget moved from 64 to
128, keeping the existing MCP space and holding 64 CLI instances, still with no new timer. R2 uses a CLI random
completion token plus main's single-exit de-duplication, covering cross-window Hosts; the single-Host reference
count scheme was not adopted since it still leaves cross-window duplicates.

Rollback can revert the fix commit; rolling back only main loses de-dup/environment isolation, and an old strict
consumer would drop the new CLI fields, so roll back by the same-version app package. No persistence format or
database migration. Real Windows/Linux, SSH/WSL/Docker and the full old-Server Desktop E2E remain unverified and
are not replaced by mock or localhost module probes.

## PRT-031: Desktop-to-old-Server E2E boundary

Accepted real Desktop case: start a pinned old standalone Server on isolated localhost and connect from the
existing preload `window.zcode.connectRemote` through Main → Window Host → the formal capability gate in
`host/index.ts`. When the old server-info lacks the resource capability, this telemetry subscription is not sent;
the Server stays alive, the connection returns a sessionId, existing business RPCs work, and it is finally
disposed via the formal disposeRemoteSession. This case sends no model request.

Current status: **waiting for an existing old-Server fixture; no pending spec added and this Desktop remote E2E not
run.** The repo's E2E has no reusable localhost old standalone Server fixture. After the resource gate, a formal
connection must still complete Provider Provisioning's initialSync and renderer attachment; a narrow stub exposing
only the old telemetry event surface is not enough, and a later provisioning failure cannot count as "connected"
nor prove the full Desktop path. Temporarily copying the old Core/business services or adding a production test
backdoor would exceed the necessary boundary of this case, so neither was introduced.

Evidence so far: the real localhost WebSocket integration test in `serverRemoteConnection.test.ts` (capability
missing skips the subscription while business RPCs continue; capability true forwards normally), and an isolated
WebSocket probe of the pinned baseline old Core. The former verifies capability semantics through the real
connector/RPC/helper, but the gate parameter is passed by the test and the packaged Desktop `host/index.ts` is not
run; the latter also excludes a real Desktop. Neither replaces the E2E above. The existing
`process-resource-telemetry-roles.test.ts` verifies local real Electron resource reporting and does not cover the
old standalone Server connection.

Minimum prerequisite: provide a complete pinned-version old Server asset that can start and shut down properly in
an isolated test HOME/cwd, keeping that version's real server-info, RPC event surface and Provider Provisioning.
Then PRT-031 is written into `packages/desktop/test/e2e/manual-review/pending/`, reusing the existing Desktop
initialization and formal connect/dispose interfaces, and promotion is decided after real runs and manual review.
