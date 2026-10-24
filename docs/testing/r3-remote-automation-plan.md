# R3 Post-merge Remote Automation Actual Test Plan

Export boundary: `harness/remote/**` is internal remote test deployment infrastructure and does not
enter the open-source tree; the unit tests that depend on it directly (`r3RemoteMobileSite`,
`r3RemoteProcess`, `r3RemoteProfiles`, `r3RemoteScheduler`, `r3RemoteSource`,
`r3RemoteSpecInventory`, `r3RemoteVpn`) are excluded with it. Public remote implementation and
independent E2E stay; the exclusion contract is in `opensource/README.md`.

Current scope and acceptance criteria. The full acceptance target confirmed on 2026-09-07 stays;
early branch names, environment preparation and execution gaps are history and not current run
results. Commands, environment admission and resource isolation are maintained by the [harness
README](../../harness/remote/README.md); case definitions are in the
[matrix](r3-remote-automation-case-matrix.md); stage results are in the [desktop SSH guide
regression](desktop-ssh-guide-regression.md) and the dated reports.

Full acceptance requires 50 recovery cycles and a 2-hour soak; the current harness `soak-reconnect`
is 10 rounds and `soak-dual` is 10 minutes. The two cannot substitute for each other. Completing the
full tiers and their run evidence is still a coverage gap; this document does not lower the
requirement, change orchestration or claim completion.

Full history: `git show b8876e8b:docs/testing/r3-remote-automation-plan.md`

## 1. Confirmed Decisions

Conclusions of the three grilling rounds on 2026-09-07 and the follow-up confirmations on 2026-09-08
(per-round Q&A tables are in git history before 2026-09-13):

- Scope: the whole remote main line; build change, behavior, case and evidence mappings item by
  item, not limited to the Provider happy path.
- Realism: Desktop, SSH, install, RPC, files and Agent execution are all real; only the model
  response is controlled; controllable replay must not switch to live on a mismatch; real-model
  acceptance is separate.
- Isolation: a dedicated account or independent SSH container carries the faults; a workspace
  subdirectory is not enough to isolate the global Provider, credentials and Server; the user's
  current app data is not taken over.
- Platforms: macOS -> Linux SSH full regression, Docker representative, phone browser with a real
  relay; WSL as a separate Windows execution package, BLOCKED when the environment is missing;
  mobile browser and real phone are registered separately.
- Execution: fixed WDIO suites + Agent exploration to fill gaps; a new case gets a first semantic
  and key-recording review, stable cases are rerun with automatic evidence collection; keep the
  dev:desktop development-entry acceptance.
- Baselines: clean / premerge R3 / supported-old; old App, old Server and old data are authenticated
  separately, and neither a version number nor an empty runtime fixture stands in for a complete old
  environment.
- Real-model representatives: for account Coding Plan use BigModel **Team Coding Plan** (the Team
  project under the same existing login, which passed a minimal request on an independent Linux x64;
  the personal plan's 429 stays as a historical result); for API Key use the local Anthropic
  Messages config named `ZAPI` / glm-5.3 (the earlier Doubao result stays as history). The
  real-request consumption cap is cancelled; requests run as coverage requires, recording request
  counts, failures, retries and the usage returned by the service.
- Coverage strategy: behavior and state transitions fully covered, high-risk crosses get dedicated
  cases, the rest pairwise; no global Cartesian product; every pruning has a reason and a
  representative proof.
- Tiers: smoke / full / soak; 50 cycles + 2-hour soak; the first full acceptance includes soak, with
  duration measured in trial runs; tiering does not shrink the full acceptance scope.
- Defect handling: test infrastructure can be fixed; product defects are reproduced, located and
  recorded first; a blocked dependency path blocks, independent paths continue; product fixes go
  into a separate phase and design problems go to the user for a ruling.
- Process records: the required run, step, failure, cleanup and before/after-fix record contract is
  in §8.

## 2. Feature Summary and Scope Discovery

| Field                | Content                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Operating mode       | implementation-handoff: deliver an implementable plan and accepted cases, historical planning phase; the current implementation list is maintained by the harness inventory and the coverage matrix |
| Change layers        | presentation, option-source, draft-default, validation, commit-effect, persistence, recovery      |
| Main domains         | connection/deployment/identity; Provider config and execution; workspace/conversation/settings; cross-client recovery |
| Must inspect         | first-connect barrier, reconnect generation swap, full-forward RPC, Source write routing, old config and identity migration, actual build identity |
| Conditional inspect  | SSH platform capability, Docker/WSL, browser relay, model account and real requests, old-version run and rollback |
| Invariant inspect    | local flow, single Window Host, single CLI queue, continuous/replayable, isolation between Sources, no secrets in logs |
| Product scope not extended | remote cron automation, new Direct URL product entry, R4 full key cleaning, automatic resume after a crash, arbitrary multi-window role switching |

The first implementation gate must generate `change-map.json`: scan the R3 main line, merge
increments and later fixes separately, recording files/symbols, named semantic relations,
authoritative specs and related case IDs. Non-remote changes carry an exclusion reason; shared
facades, protocols, builds and state owners must not be excluded because their path lacks
remote/ssh. Unexplained remote-related changes are marked `unmapped`, and full coverage cannot be
accepted. Static reachability only gives leads and does not mechanically pull every staging file
into remote cases.

### UI Surface Matrix

| Scenario / UI entry                                            | Shared implementation / display draft owner         | Default / validation                                           | Commit action / authority                                   | Mode and isolation                                                    |
| -------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Add SSH / device connection wizard                             | SSHDialog, Host connection manager                  | target, install confirmation, version gate, first-connect Provisioning | Connection Manager -> Transport -> Source daemon -> attachment | Credentials do not enter tabs; no install before confirmation; local download must be chosen explicitly and asserted |
| Device settings page / sidebar / device picker                 | Controller projection, Source rows                  | Source online, operation state, identity                       | RemoteWorkspaceController -> management/profile service     | The three entries share intent; offline does not fall back to local   |
| Project and history-purpose isolation                          | Root history, open membership, TabStore             | Source/realpath/purpose, existing attachment                   | Source backing workspace, logical session, persistent open set | Local/remote same path, two Sources, project/chat isolated from each other |
| Model settings page                                            | SettingsPage -> Local ServiceProvider               | local Provider draft, Configured Default; local connectivity cwd | Local ProviderSettings -> successful save -> Provisioning source | Activating a remote tab still edits local; no remote edit / manual sync entry appears |
| Conversation model selection / no-model banner                 | useModelSelectionView, pane draft                   | target Host Registry / selection validation                    | target ModelSelection, CLI creates the Model                | remote-waiting does not fall back to local candidates; old-generation replies discarded |
| Skills/MCP/Plugins/Hooks/Subagents/Memory/Output/Settings-sync | hooks/attachment of Source scope and workspace scope | online, user/project scope, target projection consistent       | chosen Source formal config / workspace files               | Localizing the model page must not skew these settings; phone does not open Source management |
| Files/terminal/Git/media                                       | full-forward RemoteWorkspaceRpcContract             | scope, path execution, media authorization                     | remote services / filesystem / PTY / repo                   | Real remote IO; client-local capabilities go through the platform seam |
| Conversation area / task list / pending interaction            | V4 pane, Controller index projection                | task address, owner/lease, CLI admission                       | remote CLI / Session / task index                           | Local/remote tasks do not mix; rejection, ACK, queue have a unique destination |
| Phone /remote                                                  | browser projection, trusted attachment              | existing Host/session, trusted clientMode                      | existing CLI, same CommandInbox                             | replayable independent subscription; no SSH/Host/Agent created; desktop continuous unaffected |

### Shared And Divergent Behavior / State Owners And Commit Sinks

```text
Desktop model settings -> Local formal config commit -> trigger
                                          |
Main coordinator [Environment key / generation / registration, metadata only]
                                          |
Window Host reads Local Source now -> Remote Target.apply
                                          |
remote formal Store -> Account/Registry refresh -> new Model

first connect: applied / already-applied -> Workspace ready
      failed / rollback_failed / unsupported -> refuse ready, release pending attachment
reconnect: new remoteSessionId -> restore workspace; a re-registration sync failure only warns

Desktop continuous ------+                 +-> independent desktop subscription
                         +-> existing Host/CLI +-> one CommandInbox
Mobile replayable -------+                 +-> independent mobile gap/snapshot
```

- `sourceServerId` is the stable device-environment identity; `remoteSessionId` is the swappable
  connection route; `workspaceIdentity?.trim() || workspacePath` is the isolation key, and files/cwd
  use the path.
- Host Directory is the fact source of Source/Profile; open membership and the all-device history
  are different states; the task index cannot replace the Session body or the CLI runtime.
- The Provisioning Environment key is **derived from the transport target**, not the Source ID.
  Multiple workspaces/windows with the same key share a lane; different lines of one Source may sync
  independently. Two applies with different `syncId` are not the same idempotent replay.
- Static config facts freeze in the already created **Model object**. An ordinary next turn creates
  a new Model, so after the target refresh completes the next turn of the same Session should read
  the new config; dynamic account headers follow their own refresh contract, and it cannot be
  claimed that all authentication is frozen permanently.
- Provider sync replaces only the Personal Layer, Configured Default, narrow account fields and
  allowlist credentials. The target refreshes the Registry itself; Builtin Release, proxy, locale,
  directories and non-allowlist credentials are kept.
- Plain-text Personal Provider Config is the current contract; logs, traces, snapshots and artifacts
  must not leak secrets. Legal plain text in the formal store must not be misjudged as a "log leak".

### Codegraph Evidence / Feature Relationships

There was no callable codegraph this time; git diff, exact rg, source and test tracing of 1-2
semantic hops were used. It must not be claimed that codegraph or tests were run. The seeds for a
later indexed recheck:

| Rank           | Seed / current direct path                                                                              | Relationship and proof task                                          |
| -------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| must-inspect   | desktopRemoteSessions -> ProviderProvisioningEnvironmentCoordinator -> remoteProviderProvisioningService | first-connect ready, reconnect generation swap, single-flight, old Host deregistration |
| must-inspect   | ProviderSettings/credentials save -> node.ts source trigger -> providerProvisioningSource/Target        | latest snapshot, transaction/rollback, idempotency, allowlist deletion |
| must-inspect   | SettingsPage -> Local ProviderSettings; useModelSelectionView -> remote facade -> turn-model            | edit authority separated from execution authority; current/next Model config |
| must-inspect   | sourceServerReleaseResolver -> sourceServerConnectionManager -> transportAdapter -> CLI release runtime | same-version SHA change, real install matches the active process     |
| must-inspect   | useRemoteWorkspaceHistory -> Controller/Registry -> renderer port bridge                                | keep failed history, explicit disconnect, old replies, open membership |
| must-inspect   | sourceSettingsServiceCollection -> Source hooks such as SubagentsSection                                | user scope without a project and the model-selection seam; an unavailable proxy is only a risk candidate and must really run |
| should-inspect | remoteWorkspaceRpcContract -> full-forward services -> mediaPreview/file/Git/terminal                   | new channel set and Source authority; the contract is still v1 and the compatibility gate should reject old ends before dispatch |
| invariant-only | windowHostAttachmentRpcPolicy, Core http.ts, task realtime / CommandInbox                               | phone has no provisioning/terminal/management; desktop siblings keep working |
| evidence-only  | SSH P0 formal/pending specs, CLI verify-remote-ssh                                                      | reuse the harness and fixtures; an existing spec or old artifact does not mean the current pass |

### Graph Drift Candidates / Graph Delta

Confirmed stale relations: the old `provider-sync` service/journal and the old model-provider hook
in Source settings; both are replaced by automatic Provisioning, so update the current edges and doc
entries of the semantic graph. The old dual queue and Desktop Provider Registry authority-sync
descriptions of `zcode-domain-cross-products.md` are changed to the current CLI/Environment contract
too.

The historical statement "local deletion does not revoke remote credentials" conflicts with the
current allowlist replace/delete; the [current Provisioning
spec](../remote/provider-provisioning.md) and the Target formal store write govern, correcting the
doc drift. The general multi-window non-commitment of the old R3 does not cancel the concrete
cross-window lane and RCONV-16 contract; other undefined window-role behavior stays in the matrix's
undefined area.

## 3. Environments, Materials and Isolation

| Environment | Purpose this round                                                          | Realism / acceptance boundary                                                                                     |
| ----------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| E-SSH       | Current macOS Desktop -> Linux x64 SSH of linux-amd64-dev                   | Password, real sshd, archive, Server/Agent, dev entry; measured that the alias points to SSH exposed by local Docker, so cross-machine WAN verification cannot be claimed |
| E-ISO-A/B   | New independent SSH containers, two independent Sources, same absolute project path | Config deletion/corruption, version switching, kill Core/Agent, quota/permission/network faults; rebuildable each round |
| E-SVC       | Independent target with a usable user service manager                       | systemd success, recovery from a missing bus environment, real registration failure; current E-SSH only has detached capability |
| E-DKR       | Desktop Docker transport -> independent Linux container                     | A true Docker proxy-stdio representative; "SSH into a Docker container" does not substitute                       |
| E-MOB       | Mobile-viewport browser + local web + external relay with an explicitly matching environment + existing SSH scope | Real pairing/attachment/recovery; browser automation is not iOS/Android real-device evidence |
| E-WSL       | Windows Desktop + WSL2                                                      | Platform execution package prepared, BLOCKED without Windows; the cross-transport release gate is not lowered     |
| E-OLD       | Authenticated old Desktop / Server / data fixtures                          | The three record version, source, SHA, schema and runnability separately                                           |

Isolation requirements:

1. The current desktop SSH adapter fixes the remote user at `~/.zcode/server`. The CLI supports
   `--server-root` but that capability is not threaded through the desktop entry; the local
   `ZCODE_DATA_BASE_DIR` or two project directories must not be taken as remote-environment
   isolation.
2. A dedicated local E2E profile + a dedicated remote user/container; real models import only the
   selected representative config into the isolated profile through the product write entry, then
   deliver it through the formal Provisioning. The user's full `.zcode` must not be copied blindly.
   App data / Chromium / CLI / Helper directories must be checked separately: the old Helper also
   needs its own `ZCODE_HOME`, and setting only `ZCODE_DATA_BASE_DIR` and `ZCODE_DESKTOP_HOME_DIR`
   does not isolate it.
3. Project fixtures live in `.zcode-e2e/<run>/<case>` of each actual workspace; two Sources use the
   same POSIX path to verify identity isolation; a local workspace is kept as a reverse-pollution
   sentinel.
4. Dedicated environments run serially with `ZCODE_E2E_MAX_INSTANCES=1`; independent environments
   may be run with bounded parallelism by a future runner and must not share the default install
   root, provider store, ports or recording output.
5. A systemd container is not completely isolated just because it uses a private cgroup namespace.
   Before start, `systemd-binfmt.service` must be persistently masked, the Docker VM's binfmt
   registration must be checked unchanged before and after, and the existing x64 target rechecked. A
   privileged fixture whose preconditions are unverified must not be reused; failures must not be
   bypassed by hand-rewriting the shared binfmt.
6. Faults act only on registered containers/users, connections and PIDs. Before a PID operation
   recheck start time, run path, releaseId and ownership; the name `zcode-server.cjs` or the new/old
   PID set difference no longer guesses ownership. No host sshd, system network or filling of shared
   disks.
7. Network and file faults prefer an external TCP proxy, a quota-limited test filesystem, permission
   control and supported service dependency injection. If a precise transaction stage has no control
   point, build a test seam and unit-test it first; do not guess the write window with sleep.

## 4. Test Execution Chain and Implementation Gaps

```text
change-map + materials preflight
  -> this round's build and archive content verification
  -> clean profile / dedicated target / replay ready
  -> first install and first-connect barrier
  -> independent full test packages [development / config / identity / conversation / recovery / settings]
  -> upgrade migration / Docker / Mobile / live representatives
  -> soak
  -> evidence audit + cleanup audit + per-environment conclusion

a dependency fails -> that branch is BLOCKED_DEPENDENCY, keep the root failure reference
           -> continue resource-independent branches, do not mass-produce the same timeout
```

### Existing commands and capabilities

```bash
node scripts/check-workspace-freshness.mjs
pnpm bootstrap:with-remote
pnpm dev:desktop

# Existing WDIO entry for a single pending case; SSH credentials are injected in a controlled run environment.
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/manual-review/pending/<case>.test.ts'
```

`bootstrap:with-remote` re-stages the remote archives at the end but does not build the Desktop
bundle. WDIO builds the E2E Desktop itself; development-entry acceptance uses `pnpm dev:desktop`
separately. Both must be prepared from the same deterministic source state; a WDIO PASS must not be
written as a verified dev start. Skipping the build is allowed only when the source/config/artifact
digests of the build receipt match.

**The unified `preflight/smoke/full/soak` runner is not implemented yet**; these are subcommands to
implement and this document does not fake runnable pnpm scripts. At least five capabilities are
needed:

| Work package                      | Reuse                                                 | Capability to add / proof of completion                                                                                     |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| H1 run manifest and resource management | WDIO runId, SSH helper, CLI verifier            | standard alias resolution, exclusive target, capability probing, build receipt, account category and request records; explicit BLOCKED when materials are missing |
| H2 product connection and lifecycle | SSH dialog, cold reconnect pending                  | explicit choice of local download, R3 Supervisor/Core PID identity, disconnect proxy, cross-window/project control; no direct injection of a "connected" state |
| H3 sync and model oracle          | case-local replay, SSH reverse tunnel                 | remote Store digest / Registry readiness, actual provider/model/body, syncId/generation; barrier controls flow and sync, unmatched fails closed |
| H4 Mobile/live orchestration      | dev:web-remote-control, existing attachment contract  | mobile browser pairing, real relay, independent disconnect; actual model requests including auxiliary/retries all recorded, no artificial consumption cap, auth values not in records |
| H5 recording and audit            | reporter, Electron window recorder, failure artifacts | success-representative recordings / key screenshots, remote log windows, per-step JSONL, first-failure retention, before/after data reconciliation, cleanup audit, HTML/Markdown summary |

H3 sends remote model requests to the controlled response service through a real SSH reverse tunnel;
the control SSH connection and the model replay tunnel are separate. Disconnecting the UI SSH must
not stop the model response service by accident, or it cannot be proven that the remote task
continues independently. The formal config sync and remote Agent execution must go through the
product path; writing the target config directly and claiming the sync passed is forbidden.

2026-09-08 run addition: the generic replay Personal Provider fixture must enter the Registry
independently even with an empty Built-in layer, and must not rely on the local E2E Built-in to fill
fields. It must give explicitly the Provider group, Model enabled, requiresMfjsToolSchema, complete
properties, and option maps for reasoningLevel/maxOutputTokens; an explicitly disabled seed stays
disabled. Otherwise delivering the local default model to an independent remote triggers a legal
Registry rejection, and this fixture error must not be misjudged as a product sync failure.

## 5. Artifact Verification and Historical Compatibility

Each round records and checks:

```text
Git HEAD + worktree change summary + Node/pnpm/build config
  -> archive descriptor [version,target,SHA,size]
  -> upload/install event [local-download-upload]
  -> remote current.json [archiveSha256,releaseId]
  -> active Supervisor/Core [PID,startTime,release path]
  -> new Agent [process/loaded entry identity] -> case marker actual request/execution
```

An old daemon of the same version is a must-test class and cannot be compared by version number
alone; no-op reuse of the same SHA and update for a different SHA are verified separately. When
blocked by the running-task guard, an actionable error and an explicit force entry must be kept, and
the old process must not be used to produce a PASS.

Old materials:

- The old end specified by the user this round: `/Applications/ZCode.app`, actual version `3.11.2`,
  in-package build commit `89817f5b`; the original install is kept and only started with an isolated
  profile. The new end's current source declares `3.11.1` with the verification baseline
  `e31f76568f`. This is the old-code/new-code role, not ordering by version size; version metadata
  must not be changed to satisfy "same version". The earlier Downloads 3.10.0 probe stays as history
  and is no longer the default old end. The exact same-version different-SHA branch still needs
  separate proof, and this actually-unequal-version combination must not be counted as a pass.
- Pre-merge R3: pinned `8009d8cd08`, the old Desktop/Server can be rebuilt in an isolated checkout;
  the same version does not mean the same commit.
- Supported old versions: an App/Server combination verified for source, SHA, platform / in-package
  manifest and actual startup. Existing old packages are candidates first; "file exists / checksum
  matches" is not written as runnable or officially release-certified.
- Old data: created by the corresponding old program in a dedicated environment (projects,
  conversations, selected models, narrow account state), backed up and migrated on the current
  version; database abnormal branches may use synthetic fixtures with an explicit schema source,
  with the report marking synthetic.
- Old Desktop rollback, old Server update and old data migration are three different proofs. A
  source rebuild can prove the behavior of a pinned commit but cannot replace an official signed
  release package, auto-update distribution or the system install experience; when old
  account/remote services are unavailable the matching BLOCKED stays.

## 6. Case Tiers, Status Enumeration and Pruning

Full setup/action/assertion and evidence are in the [matrix](r3-remote-automation-case-matrix.md).
Coverage is not a count of spec files: each accepted behavior needs an independent case ID,
expectation and evidence, even if it shares one expensive environment start.

| Tier  | Content                                                                                   | Purpose                                                  |
| ----- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| smoke | materials/artifact gate, install/first connect, one remote file and terminal operation, sync/first send, multi-workspace isolation, one recovery | Quickly locate main-chain blockers; duration published after measurement, no minutes promised in advance |
| full  | all accepted function/fault/migration cases, affected unit/contract, representative Docker/Mobile/live, development start path | Run by package, resumable scheduling; a package's smoke is not full |
| soak  | 50 disconnect-recoveries + 2-hour Desktop/Mobile concurrency, process/connection/subscription/fd/memory trends, production log volume | First full acceptance and major lifecycle changes; models use replay |

High-risk dimensions: first connect / reconnect, second save while a sync is in flight,
empty/invalid/old config, old/new Model, same/different Environment key, same path different Source,
project / no-project chat, deliberate / unexpected disconnect, running/blocking/idle, old-generation
replies, desktop/mobile, old version / old data. Theme/language/viewport use pairwise combinations;
pure service transaction branches use real store integration with key representatives through the
GUI, without copying every database permutation into Electron.

## 7. Acceptance and Failure Handling

- Status is recorded separately as `planned / running / PASS / FAIL / BLOCKED_ENVIRONMENT /
  BLOCKED_ACCOUNT / BLOCKED_DEPENDENCY / NOT_RUN / PRUNED / UNDEFINED`; product coverage and
  execution result are two fields. Unimplemented, missing environment and skip are never counted as
  PASS.
- P0: main chain unusable, data loss / Source mixing, secret leak, phone starting its own runtime.
  P1: recovery hang, fake online, wrong update / write routing, core user action failure. Both block
  the corresponding full acceptance; P2 is listed separately for manual ruling and cannot be waived
  silently.
- Every GUI case has at least UI plus one of runtime/protocol/network/persistence; permission, sync,
  isolation and upgrade should combine checks of the actual requests and data, not only toast /
  records.length.
- Async waits rely on events, request markers, authoritative state and guards; a deadline is a
  failure ceiling and sleep is not proof of reaching the target state.
- After a timing fix, three consecutive passes, keeping the first failure and the fix commit; a
  flaky is never closed by "the retry finally passed". Each migration starts from a fresh old-data
  fixture.
- Product defects record reproduction, expected/actual, source/build/environment, minimal failing
  steps and attribution evidence, and go into a separate fix phase. A broken test itself can be
  fixed but the pre-fix result and the reason for the change must be kept.
- Resource counts are compared in the same quiescent state after work is done and all owned
  attachments are released; connection/session/listener/fd must not accumulate round by round.
  Memory takes the post-warm-up series and analyzes the retained trend; GC fluctuation is not
  directly a leak; thresholds are not loosened arbitrarily without evidence.
- First round full acceptance = accepted functions of the currently available environments done +
  timing recheck + soak + evidence/cleanup audit. An SSH pass and a cross-platform release pass are
  separate; while a required platform such as WSL is BLOCKED, full-platform release acceptance is
  not claimed.

## 8. Test Process Recording Contract

Default artifact: `packages/desktop/.e2e-artifacts/r3-<UTC>-<runId>/`; artifacts are not committed
to Git. docs keep only redacted result summaries and an artifact index. Every actual test action
records start before the operation and observation/assertion/end after; even on a crash the last
unfinished step can be found.

```text
run/
  run.json                 code, build, environment, commands, config digest, material verification, request and usage records
  change-map.json          change -> spec -> case ID -> artifact
  events.jsonl             time, case/step, action, expected, observed, status, duration
  cases/<id>/
    result.json            setup/action/assertions, evidence paths, failure classification
    screenshots/           key interaction states
    recording.webm         Electron window recording of the first representative path / failure
    protocol.jsonl         redacted identity, generation, syncId, seq/ACK and reasonCode
    requests.jsonl         request marker/provider/model/static parameters; only existence of auth
    process-before.json    ownership, PID/startTime/releaseId, connection count
    process-after.json
    persistence.json       fixture marker, config digest, key category and count, reconciliation result
    logs/                  Desktop/Host/remote Core/Agent logs in the case time window
    cleanup.json           created resources, actually reclaimed, leftovers and recovery result
  issues.json              first failure, minimal reproduction, root-cause category, linked later fix
  summary.md               statistics per environment/test package and reasons for not running
```

- Each case's model requests carry the marker `E2E_R3_<ID>_<run>`; artifacts reference the original
  failure, not only the last retry.
- Log collection uses offsets/time windows; old remote logs must not be counted as this round's
  errors. Settings/credentials are not dumped in full; only allowed fields, non-sensitive config
  fingerprints and key category/existence are stored. A low-entropy secret is not used as a bare SHA
  as external evidence.
- Run a canary redaction audit before committing; screenshots mask credentials and personal
  identity, full replay request bodies must also drop headers/tokens. Real account authentication
  results contain no token, email or user profile.
- A cleanup failure makes the case non-PASS and blocks reuse of the polluted environment; completed
  business assertions and the cleanup failure are kept separately. Do not destroy an environment to
  hide data damage; finish evidence and reconciliation before destroying it.
- Agent exploration uses the same event records and artifacts; discovered problems must be added
  back as stable case IDs. A "looks normal" without fixed assertions is recorded as an exploration
  observation and does not count as automated coverage.

## 9. E2E Handoff and Delivery Order

1. First complete material authentication and `change-map`; write accepted cases into
   `manual-review/pending` package by package per the matrix, checking current graph/spec drift
   before implementing.
2. Fix the H1/H2/H3 harness gaps first so that install, first connect, config delivery,
   files/terminal and two-workspace conversation obtain current-build evidence.
3. Then add the config/identity/recovery packages, then upgrade migration, Docker/Mobile/live;
   continue other test packages while resources are independent.
4. Case-local provider/file fixtures; deterministic streams use controlled-stream and protocol
   faults use fault-stream; a real SSH case does not automatically get Docker transport or platform
   proof because it runs in a container.
5. After the first GUI/behavior review follow `e2e-case-lifecycle`: promotion dry run -> fixture
   check -> apply -> default replay. A case that needs the Docker preset goes through independent
   admission first, then the stable preset in batch.
6. Mechanical checks: `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, `pnpm lint`,
   the related fixture/coverage audit. When the affected tests are sufficient, no unrelated full UT
   is added.
7. Implementation commits follow Conventional Commits and the [repository commit
   guidelines](../git/ai-agent-commit-message-guidelines.md). The completion report lists plan
   status, harness status and test execution status separately, to avoid blending into "done".

### Planning Handoff / Open Items

| Artifact/question                                  | Destination / handling                                    |
| -------------------------------------------------- | --------------------------------------------------------- |
| Spec and test strategy                             | This document; semantic consensus confirmed               |
| accepted/undefined/pruned and implementation status | Dedicated matrix; index added to the main catalog/coverage matrix |
| Usable accounts, quota, environments, old packages | Readiness record; existing metadata does not mean online usability |
| Exact original historical baseline                 | Authenticate existing old packages or rebuild the specified commit; do not guess the commit corresponding to a version |
| General auto-reconnect roles across multiple windows, all-empty-workspace idle TTL | Stay UNDEFINED; the concrete lane / RCONV-16 contract is accepted normally |
| Test implementation                                | H1-H5 and the matrix package by package; currently none newly implemented or run |
