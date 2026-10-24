# Remote Connection Interaction and Visual Experience Optimization

Status: in-progress

Summary (2026-10-10): the 12 implementation sub-tickets are done; the ssh-agent / default key evaluation stays ready-for-human and is not scheduled or implemented automatically. The parent ticket keeps the original problem scope and open decisions and does not duplicate the formal spec's state tables, error tables and flows.

Added 2026-10-12: [15 — Project creation and remote connection management separation](15-project-device-selection-and-connection-management.md), Status ready-for-agent. It is the next confirmed interaction target and is not implemented yet. The scope below keeps the original contract of batches 02-14; where 15 replaces the entry point, the post-connection destination and the draft return, its own text prevails.

## Problem and Current Spec

Original problems: connection errors are hard to understand, states are inconsistent, the first-connection path is long, content and the recovery entry are missing after a disconnect, and device management and visual rules are scattered. Current facts are maintained in:

- [Connection UX](../../architecture/remote-device-connection-ux-spec.md): five states, errors, three-screen wizard, device cards, logs, install preview, updates and accessibility.
- [Project navigation](../../remote/project-first-remote-navigation-spec.md): flat projects, retained directory intent, in-place reconnect, navigation recovery and history data boundaries.
- [R3 main spec](../../architecture/r3-source-server-remote-architecture.md): identity, Host/Source authority, versions and migration.
- [Design guidelines](../../../DESIGN.md): themes, semantic colors and component scale.

### Scope and Boundaries

- **Interaction flow only.** The domain model, connection state machine and task protocol semantics do not change; only the explicitly listed contract extensions are allowed.
  - The three-layer model `sourceServerId`, Connection Profile, workspace identity stays unchanged.
  - The "flat projects + choose a directory after connecting" navigation contract stays unchanged.
- **Allowed contract changes are limited to these five** (items 4 and 5 were confirmed by the user on 2026-09-29 for [11 — Connecting screen and directory screen](./11-connecting-and-directory-screens.md)):
  1. Extend the connection error code set.
  2. The service layer adds "read the device's most recent operation log".
  3. The update-notice dedupe record is persisted. It is a UI local preference and involves no protocol.
  4. The management snapshot provides a read-only install preview: released version, actual remote install path and package size. Package size is not passed off as unpacked footprint.
  5. A read-only list of remote running tasks: following the existing task owner's activity projection, handed to the forced-update confirmation screen through `running-tasks --json` and the management snapshot; an old remote that does not support it explicitly shows the list as unavailable.
  - Items 4 and 5 do not change task running, the connection state machine, the persisted `status.json` format, workspace identity isolation, or the desktop `continuous` / mobile `replayable` recovery semantics.
- **Progress log narrowing and redaction** is a behavior fix in the main process and host side and adds no contract.
- **ssh-agent and default keys are not promised.** Supporting IdentityFile/IdentityAgent in config, default `~/.ssh/id_*`, and ssh-agent (an OpenSSH agent pipe or Pageant on Windows) needs a separate evaluation of the service-layer effort and cross-platform differences; the user decides whether to schedule it.
- **Desktop only.** Mobile Web `/remote` is not changed, only regression-checked so it does not regress.
- **Recovery affects desktop only.** Changes involving recovery timing apply only to desktop `continuous` recovery; the mobile `replayable` recovery boundary is unchanged.

## Sub-tasks and Evidence

| Sub-task                                                                                    | Recorded status |
| ------------------------------------------------------------------------------------------- | --------------- |
| [02 — Connection log and error contract](02-connection-log-and-error-contract.md)           | done            |
| [03 — Presentation model, 5 states and glossary](03-presentation-model-states-and-glossary.md) | done         |
| [04 — Wizard P0 fixes and flow controller extraction](04-wizard-p0-fixes-and-flow-controller.md) | done       |
| [05 — Settings safeguards, edit connection and scope labels](05-settings-safeguards-edit-and-scope.md) | done  |
| [06 — Interaction prototype and review](06-interaction-prototype-review.md)                  | done            |
| [07 — ssh-agent and default key evaluation](07-ssh-agent-default-key-evaluation.md)          | ready-for-human |
| [08 — Disconnect experience and in-place reconnect](08-disconnect-experience-and-in-place-reconnect.md) | done |
| [09 — Return to the original place after reconnect or restart](09-restore-after-reconnect-and-restart.md) | done |
| [10 — Three-screen wizard: skeleton, unified selection screen and collapsed progress row](10-three-screen-wizard-and-selection.md) | done |
| [11 — Connecting screen and directory screen redo](11-connecting-and-directory-screens.md)  | done            |
| [12 — Sidebar, session header and menus](12-sidebar-header-and-menus.md)                    | done            |
| [13 — Settings device cards, unfinished connections and update notices](13-settings-device-cards-and-updates.md) | done |
| [14 — Visual polish and accessibility](14-visual-polish-and-accessibility.md)                | done            |
| [15 — Project creation and remote connection management separation](15-project-device-selection-and-connection-management.md) | ready-for-agent |
| [27 — New connection form layout and colors](27-new-connection-form-polish.md)              | done            |

Each sub-ticket keeps root cause, the corresponding spec and run evidence. done does not mean formal/CI admission; the [case catalog](../../conversation-session-case-catalog.md) defines scenarios and the [coverage matrix](../../testing/conversation-session-e2e-coverage-matrix.md) records test files, pending status and evidence.

## Out of Scope

- **Remote display and interaction changes of mobile Web `/remote`**, including the device-name distortion of R3-ISSUE-017. This round only guarantees no regression.
- **Filtering or grouping when devices and projects are very numerous (20+).** Navigation stays flat.
- **Idle-timeout disconnect when a device is online but no project is open.** It would change the connection state machine.
- **Unifying the scope ownership of settings sections**, such as sub-agents being fixed to this machine. This round only labels scope explicitly.
- **Verifying real hook behavior under remote scope.**
- **Offline message queueing, and auto-reconnect on send.**
- **Domain model, state machine and protocol changes beyond the five contract changes listed here.**
- **ssh-agent and default key support.** Evaluated separately; the user decides whether to schedule it.
- The first five items are registered in the open issues document as follow-up topics.

## Open Items and Historical Basis

- The prototype review is recorded in sub-ticket 06; the ssh-agent evaluation keeps the user decision gate in sub-ticket 07.
- Out-of-scope topics are collected in [R3-ISSUE-017/025–028](../../architecture/r3-source-server-remote-open-issues.md#连接体验后续议题rdux-范围外). Unfinished items are not hidden in historical text.
- The original walkthrough inferences about the too-old local update direction, duplicate update notices and recovery progress cannot pass as run evidence; later coverage follows the corresponding sub-ticket and the matrix.
- Whether the diagnostic logs as a whole need further redaction still needs a separate evaluation; this round's contract covers only user-visible connection logs and content attached to feedback.
- The original walkthrough baseline is `e185847b58`; the temporary screenshot directory `/tmp/zcode-remote-ux-walkthrough/` is not guaranteed on other machines.
- The full problem list, user stories, original screenshot names and the decision process are kept in the pre-cleanup commit and are not a second current spec:

```bash
git show a17a875588b8d66c2bee49236292e174df651363:docs/issues/remote-connection-ux/01-remote-connection-ux-optimization.md
```
