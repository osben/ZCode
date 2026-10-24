# R3 Source Server remote chain issue ledger

Full history: `git show 45f808f7:docs/architecture/r3-source-server-remote-open-issues.md` holds the full pre-compaction version, including per-round fix records, artifact paths and live-run logs of closed items. The summaries below do not raise the original verification level.

## Document status

- Status: Open. Established 2026-08-28. Review baseline `feat/multi-device-remote-3-real-ssh-feature@ed0fe80b1391` (the `staging...HEAD` diff of that day, not the latest branch diff).
- Purpose: record issues found in the full branch review so they can be fixed, verified and closed by stable ID.
- Status is kept per item; closed items keep a fix and verification summary, open items keep their full to-do.
- Reading entry: [docs/remote/README.md](../remote/README.md). R3 process documents are archived under `docs/archive/remote-r3/`.
- Provider rework (2026-09-07, route A): the early R3 Provider "one-click sync", the model settings device selector, the `provider-sync` channel, the `model-provider` registration in the `source-settings` scope and the old `modelProviderService` were all deleted in favor of "settings page bound to local + Provider Provisioning automatic one-way push". Entries that mention them are void. The "model settings registers a `source-settings` attachment ... `model-provider.*` calls succeed" evidence in R3-ISSUE-010 belongs to a deleted path. R3-ISSUE-012 was re-evaluated against [docs/remote/provider-provisioning.md](../remote/provider-provisioning.md) and [r3-provider-refactor-merge.md](../archive/remote-r3/r3-provider-refactor-merge.md). Other non-Provider entries are unaffected.

## Status definitions

| Status      | Meaning                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| To fix      | Registered, no change started                                                                   |
| In progress | Implementation or test work is under way                                                        |
| To verify   | Implementation done, automated or runtime evidence still missing                                |
| Closed      | Root cause fixed, related tests and required runtime verification done                          |
| Won't fix   | Current state accepted by product or architecture decision; the decision basis must be recorded |

Severity: `P0` release blocker, data safety or main chain unusable; `P1` high-impact function, permission, identity isolation or lifecycle error; `P2` low/medium-impact defect, architecture debt, verification or documentation gap.

Confidence: `Confirmed` = the static call chain proves the problem; `At risk, to reproduce` = the code structure allows it, a failing test or runtime reproduction is needed first.

## Overview

| ID           | Severity | Area              | Summary                                                                                                                 | Confidence              | Status      |
| ------------ | -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------- |
| R3-ISSUE-001 | P0       | Release           | Official release validator still checks old remote assets                                                               | Confirmed               | To verify   |
| R3-ISSUE-002 | P1       | Desktop IPC       | Preload drops workspace scope                                                                                           | Confirmed               | Closed      |
| R3-ISSUE-003 | P1       | Mobile permission | Phone attachment can reach Terminal RPC                                                                                 | Confirmed               | Closed      |
| R3-ISSUE-004 | P1       | Lifecycle         | Explicit disconnect during retrying does not settle                                                                     | Confirmed               | Closed      |
| R3-ISSUE-005 | P1       | Lifecycle         | Different Profiles of one Source may create two logical owners                                                          | Confirmed               | Closed      |
| R3-ISSUE-006 | P1       | Lifecycle         | Manager may still reconnect via the old route after Profile deletion                                                    | Confirmed               | Closed      |
| R3-ISSUE-007 | P1       | Recovery          | Auto recovery keeps retrying in user-action states                                                                      | Confirmed               | Closed      |
| R3-ISSUE-008 | P1       | Settings          | Startup auto-reconnect preference dropped by the full AppSettings schema                                                | Confirmed               | Closed      |
| R3-ISSUE-009 | P1       | Mobile recovery   | No clear terminal state after bridge rebuild budget is exhausted                                                        | Confirmed               | Closed      |
| R3-ISSUE-010 | P2       | Source Settings   | A late close of an old port may delete the new generation's services                                                    | Confirmed               | Closed      |
| R3-ISSUE-011 | P1       | Recovery          | Multi-workspace logical replacement is not fully atomic                                                                 | Confirmed               | Closed      |
| R3-ISSUE-012 | P2       | Provider security | API Key plaintext persistence: spec vs implementation conflict                                                          | Confirmed               | Won't fix   |
| R3-ISSUE-013 | P2       | Migration         | A failed first Directory migration may leave orphan credentials                                                         | Confirmed               | Closed      |
| R3-ISSUE-014 | P2       | Release Resolver  | Download lacks cancellation and cache single-flight                                                                     | At risk, to reproduce   | To fix      |
| R3-ISSUE-015 | P2       | UI architecture   | RemoteWorkspaceController is not yet the unified write entry                                                            | Confirmed               | Closed      |
| R3-ISSUE-016 | P2       | UI projection     | RemoteWorkspaceProjection not fully wired and mis-projects local tabs                                                   | Confirmed               | Closed      |
| R3-ISSUE-017 | P2       | Mobile UI         | Phone Source group header status and name may degrade                                                                   | At risk, to reproduce   | To fix      |
| R3-ISSUE-018 | P2       | Design system     | New remote UI has arbitrary sizes and ad-hoc alpha                                                                      | Confirmed               | To verify   |
| R3-ISSUE-019 | P2       | Docs              | Status drift across architecture, plans, coverage and live records                                                      | Confirmed               | In progress |
| R3-ISSUE-020 | P1       | Release evidence  | Historical live records cannot prove the current HEAD                                                                   | Confirmed               | To verify   |
| R3-ISSUE-021 | P1       | Lifecycle         | Disconnect during handshake persistence is dropped; a dead connection is published online                               | Confirmed               | Closed      |
| R3-ISSUE-022 | P1       | Release           | Remote archive lacks the android/ios plugin MCP runtime                                                                 | Confirmed               | Closed      |
| R3-ISSUE-023 | P1       | Recovery          | A successful manual connect in a recovering state sends no reconnect; Registry stays recovering                         | Confirmed               | Closed      |
| R3-ISSUE-024 | P0       | WSL transport     | wsl.exe without `--exec` lets the default shell pre-expand command variables; WSL install falsely reports a missing tar | Confirmed               | To verify   |
| R3-ISSUE-029 | P2       | Recovery          | Subsequent reconnect not retained while logical replacement is in flight; not triggered by current timing               | Confirmed (conditional) | To fix      |
| R3-ISSUE-030 | P2       | Provider cancel   | Waiting for a shared Registry refresh cannot be cancelled promptly; no production caller passes a signal                | Confirmed (conditional) | To fix      |

## Issue details

### R3-ISSUE-001: Official release validator still checks old remote assets

- Severity P0, Confirmed, status To verify.
- Symptom: the new build chain produces only `source-server-release.json` and four `zcode-server-*.tar.gz`, but official `release:validate` still requires `manifest-*.json` and `components/**`.
- Impact: a clean release directory fails every time; a dirty one may pass with old artifacts without validating the archives actually published.
- Evidence: `build:remote:assets` in [`.gitlab/ci/30-build.yml`](../../.gitlab/ci/30-build.yml) collects only the descriptor and four archives; the upload contract in [`.gitlab/ci/50-release.yml`](../../.gitlab/ci/50-release.yml) has only new artifacts; `validateRemoteAssets()` in [`scripts/validate-release-artifacts.mjs`](../../scripts/validate-release-artifacts.mjs) knew only legacy manifest/components; `gitlabCiBuildGraph.test.ts` and `validateReleaseArtifacts.test.ts` verified two mutually exclusive contracts with no end-to-end link.
- Close condition: the validator strictly checks the descriptor's version, four targets, file names, size, SHA-256, URLs and the real archives; build output passes the official validation directly; old leftovers do not affect the result.
- Fix record 2026-09-13 (To verify; commit `fix(release): validate Source Server descriptor and archives`): `validateRemoteAssets()` became `validateSourceServerRelease()` (checks `schemaVersion`, version, four targets, `fileName`, `version`, `urls` as safe relative paths to the archive, `sizeBytes`, `sha256`, real archive; fail-closed rejects leftover `manifest-*.json` / `components/` and unreferenced `zcode-server-*.tar.gz`); `build:remote:assets` cleans its own root artifacts before copying; `docs/desktop-ci-cd.md` synced. Tests: `validateReleaseArtifacts.test.ts` rewritten (target constants vs `SOURCE_SERVER_RELEASE_TARGETS` of `@zcode/shared`); `gitlabCiBuildGraph.test.ts` asserts CI target set equals validator set and cleanup precedes copy. Runtime: not run on a real tag / `ci*` pipeline; needs the next `CI_RELEASE_BRANCH=1` rehearsal. Remaining risk: `scripts/upload-oss.sh` keeps a dead `manifest-*.json` special case; a hand-placed legacy file in a shared runner directory now blocks validate until cleaned.

### R3-ISSUE-002: Preload drops workspace scope (Closed)

- P1, Confirmed. Main delivered `ScopedServicePort` with `workspacePath`, `workspaceIdentity`, `workspacePurpose`, but Preload forwarded only `attachmentId`, `sessionId`, `target`, `sourceServerId`; entering a Source conversation from a project could rebind the project session instead of creating an independent logical session.
- Close condition met: a shared strict payload schema consumed by Main, Preload and Renderer (Preload no longer hand-whitelists the payload); focused tests for Main payload, Preload listener -> Renderer parser, fail-closed on missing scope, direct bind of unbound session to conversation, project -> conversation using independent logical sessions. Real SSH Electron case `conversation-session-ssh-remote-project-conversation-scope.test.ts` passed on `linux-amd64-dev` (project and conversation get different `remoteSessionId`, same Window Host); re-verified on HEAD `86f5701e10`.

### R3-ISSUE-003: Phone attachment can reach Terminal RPC (Closed 2026-08-28)

- Root cause: the Window Host treated the full `ServiceCollection` as attachment authorization with only a denylist for Source Management, so `ITerminalService` was registered on the `web-remote-replayable` `ChannelServer`.
- Fix: `ServiceCollection.exposeOnChannelServer()` takes an explicit allowlist policy; the mobile attachment has its own reviewed channel contract that excludes Terminal and Source Management, new unreviewed channels fail closed by default; the Desktop attachment keeps the full surface.
- Verification: mobile in-memory RPC to Terminal returns Unknown and `terminal.create` is not executed; Desktop Terminal RPC still works. No new phone live evidence.

### R3-ISSUE-004: Explicit disconnect during retrying does not settle (Closed 2026-08-28)

- Root cause: `disconnect()` used the online physical owner as the criterion for the Source lifecycle; an unexpected disconnect had already removed that owner, so an explicit disconnect only cleared the recovery timer and returned. Started recovery flights had no Source-level cancel owner, so a late success could republish online.
- Fix: explicit disconnect captures all Profiles of the Source, clears recovery state and publishes offline uniformly; connect flights of recognized Sources hold a cancellable owner, disconnect invalidates old flights, async boundaries check the cancel signal before publishing state, and a late connection is only released.
- Verification: Manager focused tests (multi-Profile retrying-disconnect, cancel all timers/probes, late success); Registry/Main/Renderer terminal-state tests; full unit and pre-push pass. Real SSH fault injection on HEAD `86f5701e10`: `disconnectSource` during retrying turns the Source to "not connected" and no late reconnect revived it.
- Interaction boundary: Settings and Sidebar currently show "Disconnect" only when aggregated status is online, so there is no clickable user entry during retrying/connecting. The proof covers the production Renderer -> MessagePort RPC -> Host -> Manager contract, not a pure UI click; if the product wants users to cancel during recovery, add an entry or change button visibility.

### R3-ISSUE-005: Different Profiles of one Source may create two logical owners (Closed 2026-08-28; supplement 2026-09-13)

- Root cause: the Registry used the SSH/WSL/Docker route key as both the pre-handshake lookup key and the final owner key; after the Manager reused the physical connection by `sourceServerId`, entries of different Profiles still each published online, and workspace join only checked one entry.
- Fix: after the handshake the Registry atomically claims the canonical Source entry by `sourceServerId`; a route entry that loses the race hands its pending logical session to the canonical owner, reclaims only wrapper/subscriptions and keeps a route alias. A recovering Source regaining a handle via another Profile changes the handle, active target, `remoteSessionId` and generation on the same canonical entry.
- Verification: tests for same workspace, different workspace, reverse-order concurrent handshake, cross-Profile recovery takeover and Main canonical target join; runtime replay converged from `connectionCount=2/logicalSessionCount=2` to `1/1`; real dual-Profile SSH on `86f5701e10` gives the same `remoteSessionId` for both routes and no second project owner.
- Supplement (review finding RV-P1-3): `connect()` hitting an already-online Source entry did not normalize workspace identity to `remote:server:*`, so a legacy route identity published a second online logical session and `findSessionForWorkspace()` threw "matched multiple logical sessions". The "once the Source identity is known, identity must be stable" rule existed in three places (handshake online, Source owner handoff, `bindWorkspaceContext`) and the online-entry join was the missed fourth. Fix: extract `applyStableWorkspaceIdentity()` used by all four paths; `connect()` normalizes before owner matching and return. Two new tests in `windowRemoteConnectionRegistry.test.ts` fail before and pass after.

### R3-ISSUE-006: Manager may still reconnect via the old route after Profile deletion (Closed 2026-08-28)

- Product semantics: deleting the current physical/recovery/connecting Profile equals an explicit disconnect of the whole Source; remaining Profiles stay manually connectable and do not auto-take-over.
- Root cause: the old `forgetProfile()` deleted only display state and some indexes, not `OnlineConnection.profileIds`, Source-level `reconnectInputs`, timer/flight and the target/secret resolved in them.
- Fix: the Manager handles the Profile lifecycle in `removeProfile()`: deleting the current owner first cancels timer/flight, removes the online/recovery owner, then publishes a `profile-removed` terminal invalidation, releases the transport and sets only the remaining known Profiles offline; deleting a non-current Profile only cleans itself. Both unrecognized and recognized connect flights hold cancellable owners.
- Verification: Manager, Management Service, Directory and Window Registry focused tests (115 items); runtime replay shows no probe after the first 2 s window. Real Electron + SSH on `6a1de7485c`: after deleting the current `127.0.0.1` Profile there was no retry or takeover over a 136 s window crossing the 2/4/8 s and 2-minute probe boundaries.

### R3-ISSUE-007: Auto recovery keeps retrying in user-action states (Closed 2026-08-28)

- Root cause: retry and offline probe each kept their own termination conditions and only hard-coded `SourceServerUpgradeRequiredError`; install/identity/non-retryable terminals published by `connectOnce()` were then overwritten by the scheduler; the Host only forwarded `retrying/offline`, so pending states could not settle logical recovery.
- Fix: the Manager terminates automatic paths uniformly at update-disconnect, 2/4/8 s retry and 2-minute probe, by public error code, original `retryable` and recovery owner state; the owner keeps the actionable state and sibling Profiles settle as terminal offline. The Host reuses a pure recovery policy mapping pending and `failed + retryable:false` to the existing `recoverable:false` close; Registry/relay/main/realtime contracts unchanged.
- Verification: four focused test files (110 items); real Electron + SSH on `9b56031ac2` with the remote binary moved away: UI settled to "not connected / remote ZCode Server uninstalled" in about 2 s and stayed so over 176 s; explicit "reinstall and connect" restored online. Live coverage covers SSH install-required and Desktop continuous terminal; identity-change, plain `retryable:false` and Mobile replayable are covered by the focused state matrix only.

### R3-ISSUE-008: Startup auto-reconnect preference dropped by the full AppSettings schema (Closed 2026-08-28)

- Root cause: `remoteStartupAutoReconnectEnabled` was only in the patch schema, so SettingService re-ran the full AppSettings schema after merging a patch and stripped an explicit `false` before writing (the Host gate itself already existed).
- Fix: the full schema gained an optional boolean (missing = on, no migration). By product decision the global `remoteDefaultAssetInstallMode` was removed from AppSettings, patch, settings page, i18n and the SSH form prefill chain; per-route `assetInstallMode`, Profile persistence and the release resolver are unchanged; the new-connection dialog resets to `local-download-upload` on every open.
- Verification: 6 focused test files; two independent Node processes show persisted `false` is read after restart and the startup batch enumerates 0 candidates; real Electron + SSH on `645958b80b`: with the switch off `online=0`, manual connect still works; with it on `online=1`.

### R3-ISSUE-009: No clear terminal state after bridge rebuild budget is exhausted (Closed 2026-08-28)

- Root cause: `scheduleBridgeRecoveryRetry()` treated `null` from the bounded backoff as a silent stop, leaving the phone with a degraded protocol, service registration and old React root after Desktop had released the old attachment.
- Fix: on budget exhaustion reuse the existing `renderBootstrapFailure()` terminal boundary, publish `connection-recovery-timeout`, destroy service registration, protocol, requester and terminal transport in order, and render an error page with a full-page retry. Normal recovery, the 1 s/2 s/5 s budget, same-flight `recoveryId` and per-attempt bridge generation are unchanged.
- Verification: external relay entry integration test drives initial bridge, hard degrade, four consecutive bridge-open failures with fake timers and manual reload (4 files, 12 tests).

### R3-ISSUE-010: Late close of an old Source Settings port may delete the new generation's services (Closed 2026-08-28)

- Root cause: the Renderer store kept a bare `IServiceAccessor` keyed by `sourceServerId` and port close deleted by that ID, so A's late close deleted the current B after B overwrote A; the bridge used `connectViaMessagePort()` which returns only services and loses the lifecycle handle.
- Fix: store entries carry attachment identity, services and disposer, with the entry object as owner token; registering B makes B current first and then disposes A; each registration returns a release bound to its own entry and close deletes only if that entry is still current; the bridge uses `createMessagePortServiceConnection()` with an idempotent disposer.
- Verification: store owner and real MessageChannel bridge regression tests (A->B->A-close keeps B, replacement disposes A, duplicate release idempotent); real Electron + SSH on `d8a919b7ee`: after two replacements Host topology stayed `connections=1, logicalSessions=1, attachments=4`.

### R3-ISSUE-011: Multi-workspace logical replacement is not fully atomic (Closed 2026-08-28)

- Root cause: the Registry used the whole Source entry as the rollback unit but per-workspace `onSessionReconnected` as the external commit unit, so after workspace A's Controller/Main generation was published, a failure of B rolled A's internal session map back to the old generation; Controller replacement also lacked a Registry-epoch commit CAS and could leave provisional source/subscriptions without a logical owner.
- Fix: logical replacement is serial per-workspace prepare/commit. The Registry puts only the not-yet-committed pair into the rollback set and promotes generation via `isCurrent + commit` when the Controller snapshot succeeded and epoch/owner are still valid; committed siblings never roll back again. The physical Source stays online when one workspace replacement fails; retry and budget exhaustion only handle workspaces still disconnected. The Controller runs the Registry CAS before commit and silently drops the provisional source, subscriptions and pending replacement on CAS/read failure, keeping the previous generation's offline trusted projection.
- Verification: four focused files (136 tests), with new two-workspace second-fails, retry only uncommitted, post-commit notification exception, post-commit physical disconnect and Controller CAS cleanup. Real Electron + SSH on `927f819ca4` with a one-off fault injection (removed afterwards): A and conversation changed generation once, B kept the old session and recovered after about 0.5 s by independent retry; `logicalSessions` stayed 3.

### R3-ISSUE-012: Provider API Key plaintext persistence, spec vs implementation (Won't fix, 2026-09-13)

- P2, Confirmed. Originally the R3 main spec and release security gate required the Provider store to hold no plaintext API Key, while the implementation and the degraded-compatibility document kept plaintext in `config.json#options.apiKey` plus an encrypted mirror.
- Decision basis: the Provider refactor merge (route A, Q3) accepts plaintext Personal Config; `modelProviderService`, the `zcode.apiKeyCredentialKey` encrypted mirror and the provider-sync read-only validation path were deleted, with no `apiKeyCredentialKey` reference left in code. The main spec §8 is now "settings bound local + Provisioning one-way push" and no longer requires a plaintext-free Provider store; the release test plan that required that gate is archived. Both ends of the conflict are gone, so the item closes as Won't fix. The section describing that mirror in `docs/model-provider-opencode-config.md` was deleted the same day.

### R3-ISSUE-013: A failed first Directory migration may leave orphan credentials (Closed 2026-08-28)

- Root cause: `migrateProfileTarget()` copied legacy secrets to new Profile keys before the Directory settings commit and `migrateLegacyRemoteEntries()` held no before-state for these writes; after a settings failure initialization retried with a new `profileId`, orphaning the first key; parallel password/passphrase copies let a late write cross rollback.
- Fix: the first migration treats the whole Directory write as the credential transaction boundary, records each target key's old value and restores everything of the round before returning if any credential or settings write fails; password and passphrase are awaited sequentially; with existing `connectionProfiles` as commit authority, secrets are not copied for excluded temporary Profiles.
- Verification: `sourceServerDirectory.test.ts` (38) with three new regressions; real Desktop with a one-off `ENOSPC` settings fault: initialization failed with no migration version, then succeeded after the fault was removed with exactly legacy + canonical credentials.

### R3-ISSUE-014: Release Resolver download lacks cancellation and cache single-flight

- P2, At risk (to reproduce), status To fix.
- Symptom: descriptor/archive fetch does not fully pass AbortSignal, and concurrent requests for the same version/target share no single-flight, so they may operate on the same cache file at once.
- Impact: after the user cancels, the download continues; with several Sources downloading, delete/download/rename can race (Windows behavior especially needs verification).
- Evidence: [`packages/desktop/src/host/sourceServerReleaseResolver.ts`](../../packages/desktop/src/host/sourceServerReleaseResolver.ts).
- Close condition: tests for cancel, concurrency and Windows cache races; callers with the same cache key share one download flight; the underlying fetch stops when all callers cancel; cache files are published atomically.

### R3-ISSUE-015: RemoteWorkspaceController is not yet the unified write entry (Closed 2026-08-28)

- Root cause: all controller handlers were optional and production wired only `open-conversation`; Root kept exposing scattered connect, disconnect, project open, reconnect and close callbacks to Sidebar, Settings, Dialog and tab lifecycle.
- Fix: six handler kinds became required and strongly typed, assembled completely in `useRemoteWorkspaceHistory` by Source/attachment/persistence owner into a single controller supplied through the Root provider; ordinary Profile connect carries the `open-conversation` completion intent; project select, device disconnect, workspace reconnect and user-close first dispatch and then enter the existing owner helpers.
- Verification: controller intent/error-propagation, Root wiring, Settings disconnect and Sidebar no-direct-`disconnectSource` tests; full unit, typecheck, lint; real SSH/CDP flow connect -> conversation tab -> disconnect -> reconnect (new `remoteSessionId`) -> project open -> user-close; SSH E2E `E2E_SSH_REMOTE_PROJECT_CONVERSATION_SCOPE` passed. A same-round pending-cancel manual check failed on a proxy-socket timing issue unrelated to this change and is not counted toward closing.

### R3-ISSUE-016: RemoteWorkspaceProjection not fully wired and mis-projects local tabs (Closed 2026-08-29, commit `aecaf1f410`)

- Root cause: `buildRemoteWorkspaceProjection()` built `openWorkspaces` from all `input.tabs`; local tabs have no `remoteSessionId` and were labeled `disconnected` by `stateForOpenWorkspace()`; Sidebar, Root and the Source management panel did not fully consume the projection join.
- Fix: `openWorkspaces` is first filtered by the unified remote-tab check; `executionContexts` keeps all local/remote tabs and associates an open workspace only for remote contexts; Sidebar computes one projection; Root's Source open-tab set and the management panel's device Profile/aggregate status read from the projection; the boundary contract is in the remote workspace spec.
- Verification: affected UI tests, full unit, typecheck, lint; real SSH/CDP mixed local + remote check (13 tabs: 6 local, 7 remote; `openWorkspaces` contains no local tab; local workspaces not drawn as disconnected remote groups; disconnect/reconnect restore `remoteSessionId`).
- Remaining risk: real attachment facts are not yet injected by the projection at every entry, so remote ready/attaching detail is still verified by each attachment lifecycle (this cannot put a local tab into `openWorkspaces`). The real phone `/remote` relay is outside this SSH environment and relies on focused mobile tests.

### R3-ISSUE-017: Phone Source group header status and name may degrade

- P2, At risk (to reproduce), status To fix.
- Symptom: the phone cannot read the Desktop-only management channel and groups only by workspace identity, lacking Source displayName and aggregate status.
- Impact: even when the attachment is usable, it may show a generic "remote device" or "not connected"; tasks stay operable but the text misleads.
- Close condition: without opening Source management, project the needed read-only Source display facts through the existing workspace attachment; add mobile online/offline/recovering display tests.

### R3-ISSUE-018: New remote UI has arbitrary sizes and ad-hoc alpha

- P2, Confirmed, status To verify.
- Symptom: the new wizard has `rounded-[14px]`, `rounded-[10px]`, `size-[22px]`, `border-warning/35`, `border-success/35` and similar; this breaks the fixed radius/size and semantic surface token rules of the root [`DESIGN.md`](../../DESIGN.md).
- Close condition: replace with existing repository tokens/component sizes; add multi-theme contrast and visual regression evidence for descriptor tokens and the continuity panel.
- Fix record 2026-08-29 (commit `b53f1652c4`): connection-method cards use `min-h-32`, `rounded-lg`, `rounded-md`, `size-5`; connection panel, LinkRail, settings offline dot and Source boundary dialog use existing semantic border/surface tokens with component-level alpha and 340/180 px fixed values removed; a remote UI token conformance check and four-theme resolution/contrast tests for descriptor/continuity tokens were added; Zai Light/Dark screenshots archived. Remaining risk: the connecting status panel and the continuity dialog still lack their own final visual artifact.

### R3-ISSUE-019: Status drift across architecture, plans, coverage and live records

- P2, Confirmed, status In progress.
- Symptom: the main spec, completion plan, conversation spec, UI spec, release plan, coverage matrix and live records used different status vocabularies ("designing, implementing, code complete, live-tested, partial/planned"); some build docs still described legacy manifest/components.
- Impact: current facts and remaining release items cannot be judged reliably; old artifacts or architecture can be misused.
- Close condition: establish one status entry for the current candidate recording spec status, candidate SHA, automated results, live artifacts, blocked environments and release conclusion; other documents reference it.
- Done (2026-09-13): `docs/remote/README.md` added as the reading entry (registered in AGENTS.md); main spec §1 status "implemented (baseline `fad93b9e57`)", §7.1 startup reconnect gate field `lastOnlineAt`, §8.4 device management contract added, §9.1 controller per-table inventory merged, §15 Provider-merge leftovers merged; domain simplification spec marked Phase 0–4 implemented; renderer-reattach gate description aligned; 18 process / review / live-record documents moved to `docs/archive/remote-r3/` with inbound links updated; coverage matrix reference fixed.
- Not done: the unified "candidate SHA + automated results + live artifact" release status entry is still shared between this ledger and `docs/testing/r3-remote-full-rerun-2026-09-10.md`; once R3-ISSUE-001 / 020 close, adding the release conclusion here closes this item. A link check does not prove code, coverage and final release evidence are consistent.

### R3-ISSUE-020: Historical live records cannot prove the current HEAD

- P1, Confirmed, status To verify.
- Symptom: SSH and expanded live records are bound to commits that are not ancestors of the current HEAD; the branch later changed auto upgrade, workspace recovery, conversation, OAuth, Team Plan and mobile bridge.
- Impact: the records prove failure modes and early capabilities but cannot serve as release sign-off for the current candidate.
- Evidence: SSH record baseline `d684ee1af7`; expanded record baseline `069250a399`; current baseline `ed0fe80b1391`; the release plan still lacks WSL, launchd, physical phone, soak and current-commit artifacts.
- Close condition: on the final candidate SHA run and archive the needed SSH, Docker, Windows WSL, Mobile, update, uninstall/reinstall, permission/elicitation and recovery tests; artifacts self-contained and independently reviewable on another machine; coverage matrix synced with results.

### R3-ISSUE-021: Disconnect during handshake persistence is dropped; a dead connection is published online (Closed 2026-09-13)

- Root cause: close events were routed by Source key rather than connection identity, and "connection closed but not yet published" had no state carrier.
- Fix: `connectOnce` hands close to `handleUnexpectedClose` (with the connection object) only after registering the connection as online owner; a pre-publish close only records the reason, the publish point after sibling join checks the flag and, if set, disposes and throws a `retryable:true` handshake-time close error through the existing connect-failure path; `handleUnexpectedClose` checks `online.connection === connection` and ignores late or non-owner closes. Main spec §7.1 "Disconnect before publish".
- Verification: three new `sourceServerConnectionManager.test.ts` cases (37 pass); no real SSH/Docker fault injection.

### R3-ISSUE-022: Remote archive lacks android-emulator / ios-simulator plugin MCP runtime (Closed 2026-09-13)

- Root cause: when the legacy asset chain was removed, "build and assert the official plugin MCP runtime" was not assigned to any step of the new staging chain.
- Fix: the MCP runtime list in `scripts/build-desktop-agent-cli.mjs` (the only build entry shared by Desktop and Source Server staging) adds `@zcode/android-emulator-plugin` and `@zcode/ios-simulator-plugin`; `stage.ts` runs `assertOfficialPluginRuntime` after copying each plugin and throws if the manifest is missing or a `${ZCODE_PLUGIN_ROOT}/...` file referenced by `mcpServers` does not exist. The R2 spec gained the "official plugin MCP runtime invariant". Any future official `*-plugin` that declares mcpServers but is absent from the build list makes staging fail explicitly (expected).
- Verification: `packaging.test.ts` fail-closed cases; local rebuild of both plugins and `dist/mcp/server.js` present for four plugins in `zcode-server-linux-x64.tar.gz`. Real CI `build:remote:assets` not run.

### R3-ISSUE-023: Successful manual connect in a recovering state sends no reconnect; Registry stays recovering (Closed 2026-09-13)

- Root cause: the reconnect event was published by three callers instead of at the single Manager point that knows "not online -> online"; the new manual `connect()` path did not copy that duty.
- Fix: the `connectOnce` publish point judges "published again" by `reconnectInputs.has(sourceServerId)` (written on first publish, deleted on explicit disconnect) and fires `onDidReconnect` once after `setState(online)`; `scheduleOnlineRetry`, the `.then(fire)` of `enterOfflineProbe` and the explicit fire in `updateServer` were removed to avoid double firing. Main spec §7.1 "`onDidReconnect` single fact source".
- Verification: two new Manager tests (manual connect during retrying/offline fires once); 3 files, 85 tests. Not run: Electron E2E, real SSH/Docker disconnect injection, Host wrapper -> Registry integration test.
- Behavior change: when a different Profile manually connects back to a recovering Source, the old wrapper now gets reconnect first and puts the entry back online, and the provisional entry takes the join branch instead of the takeover branch; both end in a unique canonical entry. `updateServer` no longer fires reconnect for a Source that was never online.

### R3-ISSUE-024: wsl.exe without `--exec` lets the default shell pre-expand command variables; WSL install falsely reports "remote lacks tar"

- P0, Confirmed, status To verify.
- Symptom: Windows 3.12.0 (`0d926421`) connecting to WSL Ubuntu: the five-step dialog fails at "Deploy ZCode Server" with "远端服务器缺少 tar，无法解压 ZCode Source Server。请安装 tar 后重试。" (remote server lacks tar). The old main chain of online 3.12.1 on the same machine works. The failure point is the `detectRemoteTarTool` pre-check of the local-upload branch of `transportAdapter.installOrUpdate`; it requires remote exit code 0, so the script succeeded with empty `tar=`.
- Root cause: `WSLBackend.exec` / `execDirect` spawn `wsl.exe -d distro -u user -- bash -lc command`. Node quotes arguments containing spaces/quotes and escapes inner quotes; without `--exec`, wsl.exe hands the raw command line after `--` to the user's default shell with `-c`. The outer bash expands `"$tar_tool"` to empty first, so the inner `bash -lc` receives `printf 'tar=%s\n' ""` and prints `tar=` with exit 0. The same mechanism silently disabled the stale-staging cleanup loop (`$candidate`, `${name##*-}`) of `installOrUpdate` and the `$status_pid` liveness check of `probeSourceServer` on WSL. The old chain referenced only `$HOME`-style variables (same result either way) and its deploy lock and agent wrapper writes had their own on-disk workarounds, so it never surfaced.
- Evidence: an isolated probe with the real `detectRemoteTarTool` + libuv `quote_cmd_arg` rules + `$SHELL -c <raw tail>` reproduces the same error stably (stdout `tar=\n`, exit 0); `--exec` argv passthrough or the SSH backend's `/bin/sh -c '...'` wrapper gives `tar=tar`. `remoteAssetPreflight.test.ts` (6) passed because the fake backend returns the right text and misses the quoting chain.
- Fix record 2026-09-14 (To verify; commit `fix(remote): run wsl.exe commands in --exec mode so the default shell cannot pre-expand them`): `buildWslArgs` uses `--exec` instead of `--`. wsl.exe parses argv with `CommandLineToArgvW` and directly execs `bash -lc <command>`, which inverts Node's quoting so command bytes reach bash unchanged; the login environment still comes from the explicit `bash -lc`. Applies to `exec` (deploy, upload streams) and `execSimple` / `execDirect` (identity resolution, `uname`, proxy probe). The preflight, error copy, deploy lock and agent wrapper paths are untouched.
- Verification: new `packages/server/test/wslBackend.test.ts` case ("exec and execSimple pass argv through `--exec`, the command is not re-parsed by the default shell") and 3 expectations changed from `--` to `--exec` (18 pass); six related files (75) pass; `tsc -b packages/server`, `pnpm architecture:check --changed`, oxlint, oxfmt pass; the isolated round trip returns `tar` from the real `detectRemoteTarTool` and `probeSourceServer` parses normally. Not run on a real Windows/WSL.
- Close condition: on a real Windows machine with this build, the five-step dialog reaches "link ready" against WSL Ubuntu, stale `~/.zcode/server/.bootstrap-*` directories get cleaned, and `ensureDaemon` no longer repeats `serve --daemon` when `status.json` is alive.
- Remaining risk: `--exec` requires `bash` to resolve on the distro PATH (same as the existing `bash -lc` dependency); scripts previously masked by the outer shell (stale staging cleanup, `$status_pid` check, gateway `route=` line) now truly run on WSL with SSH-identical semantics. With a non-POSIX default shell the old path would have failed with a non-zero exit; the new path no longer goes through it.

### R3-ISSUE-029: Subsequent reconnect not retained while replacement is in flight

- To fix; not triggered by current production timing. Registered 2026-10-11, review baseline `f5c233df918e` (CR-02).
- Location: `handleConnectionReconnected` in `windowRemoteConnectionRegistry.ts`. With an existing flight it returns directly; after the flight ends stale it neither retries nor re-checks for a new reconnect.
- Evidence: handoff probes ran the real Registry, ChannelClient, and Manager + Registry together. Only when an unrelated wait is injected into replacement is the second reconnect dropped, leaving waiters pending. In production order (dispose the old connection and reject RPC first), the old flight settles in the same tick and a reconnect 2 s later recovers normally.
- Current handling: registered only, no runtime state added. If replacement ever gains a wait that does not end with transport close, re-check this item.
- Fix boundary: the entry records a pending reconnect, cleared by terminal close; after the old flight finishes, run serially. Two replacements must never run in parallel because rollback touches entry-level state.
- Close condition: coverage for an independent wait spanning two reconnects, terminal close, late rollback and real RPC disconnect settlement; the shared entry keeps one recovery owner generation.

### R3-ISSUE-030: Provider shared-refresh wait is not wired to per-caller cancellation

- To fix; no production caller passes a signal today. Registered 2026-10-11, review baseline `f5c233df918e` (CR-07).
- Location: `generateWorkspaceText` / `testProviderModelConnectivity` in `zcodeAgentService.ts` wait on `ensureAccountProviderConfigSynced` without consuming the signal.
- Evidence: in a real Service probe, after cancel the wait continued to the end of the refresh and then settled with AbortError; the protocol client checks the signal before later requests, so a cancelled model request is not executed. This proves delayed settlement, not broken cancel.
- Current handling: registered only. When the first production caller supporting cancel is wired, a single waiter races the signal; the shared `accountConfigSyncByClient` refresh continues to completion and one caller must not cancel a refresh other callers depend on.
- Close condition: one waiter cancelling rejects promptly while other waiters still complete and the cancelled model request is not sent; a shared refresh failure still propagates to non-cancelled callers.

<a id="连接体验后续议题rdux-范围外"></a>

## Connection experience follow-ups (outside RDUX)

Source: [UX optimization out of scope](../issues/remote-connection-ux/01-remote-connection-ux-optimization.md#out-of-scope). None is part of the RDUX-03 implementation, and none changes the state machine or the phone recovery protocol.

| ID           | Follow-up                                                                                                       | Status    |
| ------------ | --------------------------------------------------------------------------------------------------------------- | --------- |
| R3-ISSUE-017 | Phone Web device name and status display degrade; reuses the existing issue, phone display evaluated separately | To fix    |
| R3-ISSUE-025 | Search, filter and grouping for 20+ devices/projects                                                            | To fix    |
| R3-ISSUE-026 | Idle-timeout disconnect when a device is online with no open project                                            | To fix    |
| R3-ISSUE-027 | Unified local/remote scope ownership of settings sections                                                       | To fix    |
| R3-ISSUE-028 | Real behavior verification of hooks under remote scope                                                          | To verify |

## Remaining work

- Release verification: R3-ISSUE-001, 020; WSL live verification: 024. Past automated passes cannot replace the final candidate / per-platform verification.
- To fix or to reproduce: 014, 017, and follow-ups 025–027.
- To verify: 018, 028; docs and coverage status reconciliation: 019 (stays In progress).
- Conditional follow-ups: 029, 030; implement only when their trigger preconditions change or a new caller appears.
- Closed items are not listed in the fix order. The Won't-fix decision of 012 stays; the retired Provider approach is not reintroduced.

## Per-item update template

When fixing a single issue, append to its section:

```md
#### Fix record YYYY-MM-DD

- Status: In progress / To verify / Closed
- Fix commit: `<commit>`
- Root cause:
- Fix:
- Automated verification:
- Runtime verification:
- Remaining risk:
```
