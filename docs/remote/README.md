# Remote main-chain reading entry

The current specs cover SSH / WSL / Docker Source Server. Pick the fact document by the change; historical
plans are not the current contract. For runtime owners, workspace identity, the single per-window Host and the
continuous/replayable boundary, see [runtime boundaries](../agents/runtime-boundaries.md).

```text
R3 main spec (identity / connection / migration)
  ├─ connection UX (wizard / five states / device management)
  ├─ project navigation (directory intent / disconnect experience / navigation recovery)
  └─ dedicated contracts (Provisioning / Renderer reattach / persistence compatibility)
scenario catalog → coverage matrix → run evidence saved per baseline
open questions → issue ledger; old process text → historical snapshot entry
```

## Current contracts

"Main spec" in the table below means the [R3 Source Server architecture](../architecture/r3-source-server-remote-architecture.md).

| Change                                                                                              | Source of truth                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source/Profile/three-layer workspace identity, task address                                         | main spec §3                                                                                                                                                                                                                                         |
| Process, Transport, install and upgrade, remote daemon/archive                                      | main spec §4-5; [Server CLI/daemon](../architecture/r2-server-cli-and-daemon.md)                                                                                                                                                                     |
| Handshake, authentication, compatibility gate and updates                                           | main spec §6                                                                                                                                                                                                                                         |
| Physical connection, silent startup connection, retry and recovery generation                       | main spec §7                                                                                                                                                                                                                                         |
| RPC service ownership, device management and migration                                              | main spec §8-9                                                                                                                                                                                                                                       |
| Renderer reload, project reattach after Source comes online                                         | [Renderer reattach](desktop-remote-session-renderer-reattach.md)                                                                                                                                                                                     |
| Projection, open set, strict schema, R4 pending items                                               | [projection and persistence compatibility](../architecture/remote-domain-simplification-and-conversation-workspace-spec.md)                                                                                                                          |
| Three-screen wizard, unified five states, error log, device card, install preview and task list     | [connection UX](../architecture/remote-device-connection-ux-spec.md)                                                                                                                                                                                 |
| Flat projects, in-place reconnect, directory permission, restoring the original project and session | [project navigation](project-first-remote-navigation-spec.md); the remote no-project chat UI is disabled, data is kept                                                                                                                               |
| Automatic Provider delivery and local model settings                                                | [Provisioning](provider-provisioning.md); [app config ownership](../ssh-remote-app-global-state-authority.md)                                                                                                                                        |
| Mobile existing Host attachment and replayable recovery                                             | [remote-control architecture](../web-remote-control/web-remote-control-architecture.md), [task realtime sync](../web-remote-control/task-realtime-sync.md), [mobile workspace reconnect](../web-remote-control/mobile-remote-workspace-reconnect.md) |
| WSL                                                                                                 | [realtime boundary](wsl-remote-realtime-boundary.md), [Provider headers](wsl-provider-runtime-headers.md), [WSL design](../wsl-remote-workspace-design.md)                                                                                           |
| Windows asset cache                                                                                 | [cache rename](windows-remote-asset-cache-rename-hardening.md)                                                                                                                                                                                       |
| Desktop descriptor/archive network policy                                                           | [remote asset network policy](zcode-agent-remote-deployment.md)                                                                                                                                                                                      |
| dev-only direct Server connection                                                                   | [Server workspace](server-remote-workspace-connection.md); old process descriptions defer to the main spec                                                                                                                                           |
| Release artifacts and CI                                                                            | [CI/CD](../desktop-ci-cd.md), [artifact layout](../desktop-ci-artifact-layout.md)                                                                                                                                                                    |

## Issues and verification

- [Separating project creation from remote connection management](../issues/remote-connection-ux/15-project-device-selection-and-connection-management.md): three entries, device selection, categorized add, return to draft and acceptance scenarios; implementation and verification scope is in the completion records of sub-tickets #16-#22; parent ticket status and unverified platforms follow each ticket's record.
- [Choose a remote folder after connecting from chat and enter the project](../issues/remote-connection-ux/21-chat-settings-round-trip.md): implemented per #23-#26 on 2026-10-14; the folder is chosen explicitly every time, unique / multiple / zero matches enter the project, cancel restores the original target, and sending is blocked until the project is ready. Current verification evidence and unrun platforms are in the spec; candidates keep the manual review boundary.
- [R3 issue ledger](../architecture/r3-source-server-remote-open-issues.md): unfixed, to-verify and pending product decisions; closed items are no longer queued for repair.
- [UX sub-task index](../issues/remote-connection-ux/01-remote-connection-ux-optimization.md): completed implementation and the open ssh-agent evaluation.
- [Test plan](../testing/r3-remote-automation-plan.md), [R3A matrix](../testing/r3-remote-automation-case-matrix.md): full acceptance targets and coverage gaps.
- [Case catalog](../conversation-session-case-catalog.md), [coverage matrix](../testing/conversation-session-e2e-coverage-matrix.md): stable IDs, test files, pending/formal status and evidence.
- [SSH P0](../testing/ssh-remote-p0-e2e-plan.md): dedicated assertions and project entry; [harness](../../harness/remote/README.md): run commands and environment isolation.
- [2026-10 desktop SSH guide regression](../testing/desktop-ssh-guide-regression.md): the original batch of 100 scheduled scenarios and later targeted fixes; it cannot support a claim that mobile/WSL/Docker are all green.
- [2026-09-10 historical rerun](../testing/r3-remote-full-rerun-2026-09-10.md): original baseline result; the [historical archive index](../archive/remote-r3/README.md) locates earlier evidence.

A PASS in any record applies only to the listed source, build, scenario and environment. Documentation
compaction does not rerun tests, change status or delete original artifacts.
