# Remote device connection entry and status presentation spec

Current interaction contract for SSH / WSL / Docker and the dev Server entry. The three-screen wizard and the five-state table are the only presentation rules; the old five-step wizard, device grouping and connect-and-chat UI no longer apply.

Next-round target confirmed 2026-10-12: [separate project creation from remote connection management](../issues/remote-connection-ux/15-project-device-selection-and-connection-management.md) (ready-for-agent, not implemented). When that ticket is implemented, its target spec replaces the rules on the generic three-screen entry, mixed discovery list, "connect success always enters the directory screen", sidebar minimize progress location, and "close clears all drafts"; the five states, error classification, logs, credential saving and install confirmation stay as in this document. The current-state text below does not mean the new target is done.

- Project entry, in-place reconnect, disconnect and restart recovery: [project navigation spec](../remote/project-first-remote-navigation-spec.md).
- Identity, install and version gate: [R3 main spec](r3-source-server-remote-architecture.md). Provider auto push: [dedicated spec](../remote/provider-provisioning.md).
- Device management offers no model editing / manual sync entry; model settings always bind to the local Environment. Skills/MCP/plugin sync keep their own scope.
- No change to workspace identity, Host/task owner, desktop continuous or phone replayable boundaries.
- Acceptance and evidence: [case catalog](../conversation-session-case-catalog.md) and [coverage matrix](../testing/conversation-session-e2e-coverage-matrix.md); an actual run is not a manual promotion.

<a id="三屏向导与统一选择2026-09-28rdux-10"></a>

## Three-screen wizard and unified selection (2026-09-28, RDUX-10)

Replaces the old five-step sidebar wizard, "offline recent directory not clickable" and "auto popup on minimized failure". The project/chat entry shows only "select device -> connect -> select directory" at the top; the settings entry shows no step bar (RDUX-27). The new-connection form belongs to the first screen; first entry marks no step done. The dialog's top edge is fixed at 10% of the viewport and its height grows downward with content; long lists scroll inside.

- The first screen is always a searchable unified list grouped into saved devices (with state and recent-directory chips), SSH config Hosts, WSL distros (Windows only), and running Docker containers (only when Docker is available). Clicking an item connects immediately; an offline recent directory is also clickable and keeps the directory intent until connected and opened. Discovery loading and failure do not block other sources or the manual entries.
- At the bottom: new SSH, manual WSL (Windows only) and Docker; the dev Server entry and its hint appear only in a dev runtime. Form layout is RDUX-27: host and port side by side, segmented auth switch, show/hide password, collapsed advanced options, footer with back-to-list left and connect right.
- The form is a real form: Enter submits, port validated as a decimal integer 1-65535, host and username trimmed. Switching screens moves focus to the first actionable control (the host field on the form screen); selecting an alias shows an association tag. Docker dropdown and manual input are mutually exclusive and label-associated; Docker unavailable and no running container are distinguished.
- A config Host missing a password asks for it on the connect screen without re-entering Host info. A missing username returns to the pre-filled form. A saved Profile missing credentials keeps the supplement-credentials flow.
- Minimizing only changes visibility and keeps all drafts, aliases, targets and requests. The top of the project area shows a two-line card: device name with phase percentage, current phase, and a progress bar below; the percentage is the completion ratio of existing phases. After failure it stays minimized, the card turns danger-colored with the reason until clicked to restore. On success the directory screen opens (or the existing directory opens directly) and the card disappears.
- Restoring a minimized card restores only the same flow. A new explicit connect entry has its own intent id; idle flows (failed, cancelled, form, or awaiting credentials) yield to it. Even with the same Profile, WSL distro or target values it must be consumed again with the latest parameters; before acceptance revoke the old epoch and clear pending confirmation and the old directory intent; late credentials/results must not revive the old flow. A flow that is actually connecting/updating or connected-awaiting-directory is kept and not preempted.
- Close cancels the current connection, revokes request ownership and clears all form drafts; persisted input history is kept. Late discovery/credential/connect results after close must not reopen the old flow.
- Minimizing from the select, configure or directory screens also gets a matching restore card; non-connecting states fake no progress. The directory navigation path is kept by the wizard; unmounting the browser instance revokes the old request, and after restore an old response cannot overwrite the new directory. Connect-success finishing removes the card; changing target clears the directory path.

```text
list / form -> useRemoteConnectionFlow (the single wizard session owner) -> existing connect commands
                   ├─ current requestId / epoch -> result, wait points, directory intent
                   ├─ minimize -> the same session renders the sidebar card directly (portal only registers a DOM container)
                   └─ close -> revoke epoch / cancel request / clear drafts
Host, attachment, snapshot and recovery boundaries of desktop continuous and phone replayable keep the existing contract.
```

Acceptance interfaces follow the parent spec: wizard DOM + service ports, and real SSH desktop E2E (config first-connect effort, offline recent directory, minimized failure, close-clears-drafts). The full layout of the connecting and directory screens is RDUX-11.

<a id="新建连接表单rdux-272026-10-14"></a>

## New-connection form (RDUX-27, 2026-10-14)

Defines the form shared by the settings entry "新建连接" and the project/chat entry "新建 SSH 连接". It changes only presentation and front-end interaction, not connect flow, protocol or form-state semantics. Ticket: [#27](../issues/remote-connection-ux/27-new-connection-form-polish.md).

```text
settings entry                              project/chat entry
┌ New connection              — × ┐      ┌ 1 select device - 2 connect - 3 select directory  — × ┐
│ root@10.0.0.5:2222 (live preview)│      │ New connection [SSH]                         │
│ [SSH|WSL|Docker]  Import from SSH config v │ user@host:22                              │
│ (linked Host dev-box x)          │      │ host + port / username / auth / advanced     │
│ host + port / username / auth / advanced │ ├────────────────────────────────────────────┤
├──────────────────────────────────┤      │ <- Back to list                     [Connect] │
│              [Cancel] [Add and connect]│ └────────────────────────────────────────────┘
└──────────────────────────────────┘
```

- **Header**: both entries are titled "新建连接 / New connection", with no description sentence. Under the title a monospace live preview of the connection target (SSH `user@host:port`, Docker container name, WSL distro); light placeholder when empty. The project/chat entry shows a type tag next to the title; the settings entry does not, since the type switch already shows it. The settings entry shows no step bar.
- **Type switch**: SSH / WSL (Windows only) / Docker as a segmented control, each with a type icon; the selected item uses the type color's light background, border and foreground (same source as `RemoteConnectionKindTag`). Each type-switch item is a connection type tag, within the DESIGN.md allowance "type tokens only for type tags"; other tabs keep the neutral selected state.
- **SSH config import**: only the settings entry offers "从 SSH config 导入 ▾" (import from SSH config) at the right of the type-switch row, opening the existing searchable popover; with no Host the button is disabled with a reason, a read failure shows a warning below without blocking manual entry. After selecting a Host, an SSH-colored association tag "已关联 Host xxx ×" (linked Host xxx) with the hint "修改任一字段会自动解除关联" (editing any field unlinks automatically) appears above the host field. The x only unlinks and keeps filled values. The project/chat entry has no alias entry (the previous list screen already offers config Hosts); returning from the list to the form still shows the association tag. The edit-connection dialog keeps alias selection inside advanced options.
- **Field layout**: host and port on one row (port about 6rem, also side by side on narrow screens), username on its own row; the "认证方式" (auth method) label and segmented control on one row with the credential input right after. Advanced options are a compact text trigger without dashed dividers. Field labels use `text-ui-sm`.
- **Paste split**: pasting `user@host`, `user@host:port`, `ssh user@host -p N` (including `[IPv6]:port`) into the host field splits into host, username and port and shows a success hint "已识别 ..." (recognized ...) under the host; other content pastes as is. A paste counts as a manual edit and unlinks the alias. Triggered on paste only.
- **Focus**: on open, focus is on host. After importing a Host, focus moves to the first empty required field, or to the primary action if all are filled.
- **Validation**: on submit; errors show under the field (`aria-invalid` + `aria-describedby`) and focus moves to the first erroneous field; afterwards a field that becomes valid clears its error. The footer shows no validation text and the primary action is not disabled. Real connection failures still use the top error bar. The only source of validation rules is `collectRemoteFormFieldErrors`, reused by `buildRemoteTarget` and the edit-connection dialog.
- **Docker / WSL**: the top description paragraph is removed. Docker input mode (choose a running container / manual input) uses a neutral segmented control; when Docker is unavailable a warning card shows under the selector, with no running container a neutral hint. Container candidate rows show a Docker-colored icon block at the left. The warning that WSL runs as root stays a warning card.
- **Colors**: existing tokens only. Type colors for the type switch, association tag, candidate icon blocks and the project entry type tag; warning cards use `warning-surface`, paste recognition uses `success`, field errors use `destructive`; primary action and auth switch stay neutral.
- **Footer**: settings entry "取消" / "添加并连接" right-aligned; project/chat entry "← 返回列表" at left and "连接" at right. The footer has a single divider.

## Wizard P0 and flow ownership (2026-09-27, RDUX-04)

When a manually created connection directly reuses an online connection, show "这台设备已通过 `<connection description>` 连接，已直接使用现有连接" (this device is already connected via ..., the existing connection is used directly). The description comes from the connection target the Host actually reused, not from this form's values; a password or key passphrase that did not take part in authentication this time is not saved and does not overwrite saved credentials. The hint stays visible after entering the directory or the original project; the description reuses the unified presentation model (for example `SSH · dev@host:22`). Whether to hint belongs to the original new-connection intent; supplement-credentials, install confirmation and update retry keep their behavior; choosing a saved device, connecting from settings, choosing a directory on an online device and background reconnect do not hint. The Host's connect result carries an optional `reusedConnectionTarget` (redacted target) passed through Main by requestId; the UI must not guess reuse from its own snapshot. The window registry may project reuse of an existing entry; when there is no entry it must keep consuming the Manager's physical-connection reuse result. Before connecting, the Host registers only a Profile without new credentials, and commits this time's credentials only after the connection actually completes without reuse; failure, cancel, same-device merge or concurrent join must not overwrite saved values. The only exception wait point is "already authenticated, then upgrade needed": only the request that performed the authentication may save credentials at that wait point, a call that joined the same request cannot commit another password, and the management service may continue the update with the original Profile.

The wizard's entry intent, install wait, cancel, minimize/close and result destination are owned by `useRemoteConnectionFlow`; form drafts stay in `useRemoteConnectionForm`; the real connection and credentials still belong to the Host. Missing credentials stop at the connect step, with the primary action "补充密码" (supply password) returning to configuration and focusing the password or key passphrase; after filling, the original directory and download mode are kept. While connecting the primary action "取消连接" (cancel connection) immediately revokes UI ownership of that request; an active cancel shows "已取消" (cancelled), keeps a retry entry and does not enter the error panel.

```mermaid
stateDiagram-v2
  Configure --> Connecting: submit / create requestId
  Connecting --> AwaitCredentials: no saved credentials
  AwaitCredentials --> Configure: supply password / focus
  Connecting --> AwaitInstall: confirmation needed
  AwaitInstall --> Connecting: agree install / keep result intent
  AwaitInstall --> Cancelled: cancel
  Connecting --> Cancelled: cancel / revoke requestId
  Connecting --> DirectoryOrProject: current request succeeds
  Connecting --> Error: current request fails
  Cancelled --> Connecting: retry / new requestId
```

Minimize only hides the current flow; success enters the directory, failure keeps the sidebar result (RDUX-10 governs); close revokes the current request and releases unconfirmed sessions. Late results of a revoked request must not overwrite later flows, and late temporary sessions are only reclaimed. This extraction changes no Host, workspace identity, desktop continuous or phone replayable recovery boundary.

<a id="统一展示合同2026-09-27rdux-03"></a>

## Unified presentation contract (2026-09-27, RDUX-03)

Replaces the four-state mapping, pending->offline, status borrowing connection-type colors, and engineering terms in this document and the old design spec; the old connect flow is governed by the [project navigation contract](../remote/project-first-remote-navigation-spec.md). Layout contracts: RDUX-10/11/13 here and the project navigation spec.

### Remote connection presentation model (unified UI presentation)

A pure function module mapping "connection facts of devices and projects" to "what the user sees". The following surfaces **must** take status presentation only from it and never compute it themselves:

- sidebar project rows, detail cards, conversation header, conversation banner
- settings device cards, wizard, task-row device tags
- status dot of settings navigation, "open remote project" menu
- device selection of the create-project dialog (layout in [create project dialog layout](../specs/project-editor-dialog-ui.md))

The remote-control Header reads the attachment via the existing workspaceIdentity session resolver and does not require a tab to carry `remoteSessionId`. The device name comes from the shared window project directory Host for the same identity, with the desktop device-management name taking precedence; borrowing another device by path is forbidden. After a connection is removed it shows not connected and updates after re-registration; no connection or retry is added.

The existing three mappings (device aggregate status mapping, sidebar project connection status mapping, settings status label and display helpers) are removed and merged into this module.

Inputs:

| Input                         | Meaning                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Device aggregate status       | Device-level state from the Source authority projection                       |
| Project attachment status     | Whether the project mount is ready; device online does not mean project ready |
| Install and identity          | Not installed / installed / identity to confirm (connection target changed)   |
| Upgrade need                  | None / optional update / remote must update / local desktop must update       |
| Disconnect origin             | User disconnect / abnormal disconnect / not yet connected at startup          |
| Auto recovery progress        | Currently attempt n of 3                                                      |
| Latest error                  | Classified connection error code and phase                                    |
| Credential completeness       | Whether a saved password or key passphrase is missing                         |
| Connection method and address | SSH / WSL / Docker, plus address, distro or container name                    |
| Device display name           | A user-changed name wins; default is the SSH alias                            |

Outputs:

| Output                          | Description                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible state                   | One of 5                                                                                                                                              |
| State copy and short state text | Short text replaces the device name in the project row                                                                                                |
| Semantic color                  | success / in-progress (new) / neutral / warning / danger                                                                                              |
| Icon                            | The project row has a single icon slot                                                                                                                |
| Primary action                  | Connect / Disconnect / Cancel connection / Update remote / Update desktop / Install and connect / Confirm new device / Supply password / Retry / none |
| Reason and fix action           | From error classification                                                                                                                             |
| Recovery progress text          | Such as "自动恢复 2/3" (auto recovery 2/3)                                                                                                            |
| Connection description          | Such as `SSH · dev@localhost:2222`, generated per connection method                                                                                   |

The 5 visible states:

| Visible state                | Trigger facts                                                                                                | Semantic color                                   | Project row icon       | Primary action                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------- | ----------------------------------------------------------- |
| Connected (已连接)           | Device online and project attachment ready                                                                   | success (shown only in detail card and settings) | neutral cloud, no mark | Disconnect                                                  |
| Connecting (连接中)          | Explicit connect, in-place reconnect or auto recovery in progress; or device online but attachment not ready | in-progress                                      | single spinner         | "Cancel connection" inside the wizard, none elsewhere       |
| Not connected (未连接)       | User disconnect, not yet connected at startup, offline before auto recovery                                  | neutral                                          | crossed-out cloud      | Connect                                                     |
| Needs action (需要处理)      | Install needed, remote must update, local must update, identity to confirm, credentials missing              | warning                                          | cloud + `!`            | The action matching the reason                              |
| Connection failed (连接失败) | Latest explicit connect failed or auto recovery exhausted, and the reason is not "needs action"              | danger                                           | cloud + `✕`            | The fix action of the error classification, default "Retry" |

Decision rules:

- **"Needs action" beats "connection failed".** Whenever an executable fix exists, show "needs action".
- **A user disconnect always maps to "not connected".**
- **"Updating" overrides old copy**; the earlier "needs update" or error text is no longer shown.
- **An optional update does not change the visible state**; it only affects the settings navigation dot and the device card banner.
- **Non-online states must have text** (short state text or detail-card text), never color alone.

### Connection error classification

- **Error code contract.**
  - For every transport or deploy failure, main and host produce exactly one error code from the code set, plus a non-empty message.
  - A domain error code already confirmed by the adapter takes precedence over text inference from `cause`; an unclassified `AggregateError` and phase wrappers keep looking for the inner error code.
  - An empty or unrecognized message falls into the "unknown" class and an error response is never dropped because of schema validation failure (the root cause of "connection refused stays at connecting forever").
  - Probe classifies only failures of the remote environment check itself as "pre-check failed": probe script non-zero exit, unsupported remote platform, Linux remote glibc below the Source Server floor (2.28). Transport failures while establishing the connection or running the probe command (handshake timeout, disconnect before handshake) get no phase fallback and fall into "unknown" when unrecognizable; when disconnect auto recovery exhausts its budget this shows "自动恢复已停止" (auto recovery stopped) and does not hint at install environment problems.
  - Shared types and runtime schema extend together. When the UI meets an unknown error code it falls back to the generic "unknown" copy for backward compatibility.
- **Classification and display:**

| Class                                        | Typical source                                                           | Title                       | Fix action                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication failed                        | Wrong password or key                                                    | SSH 认证失败                | Change password or key: re-enter the password or key passphrase in place on the connecting screen (same interaction as "password needed"); when the username or key file must change, return to the form, focus that field and mark the error |
| Missing credentials                          | No saved password or passphrase                                          | 需要密码                    | Supply password (belongs to "needs action")                                                                                                                                                                                                   |
| Connection refused or unreachable            | ECONNREFUSED, EHOSTUNREACH, ECONNRESET                                   | 无法连接到主机              | Check address and port; retry                                                                                                                                                                                                                 |
| Timeout                                      | ETIMEDOUT                                                                | 连接超时                    | Retry                                                                                                                                                                                                                                         |
| Host not found                               | ENOTFOUND                                                                | 找不到主机                  | Edit the host                                                                                                                                                                                                                                 |
| Host key changed                             | host key mismatch                                                        | 主机身份已变化              | See the security note; no one-click ignore                                                                                                                                                                                                    |
| Download, upload, pre-check, install failure | Deploy phases; pre-check contains only remote environment check failures | Names the failed phase      | Retry; "改用设备直接下载" (use direct download on the device) additionally only for SSH with local download                                                                                                                                   |
| Remote space or permission insufficient      | Deploy or start phase                                                    | 远端空间不足 / 没有写入权限 | View details                                                                                                                                                                                                                                  |
| Version incompatible                         | Handshake phase                                                          | 需要更新                    | Update remote or update desktop (belongs to "needs action")                                                                                                                                                                                   |
| User cancelled                               | Cancel install or cancel connect                                         | 已取消                      | Reconnect; not shown in error style                                                                                                                                                                                                           |
| Unknown                                      | Fallback                                                                 | 连接失败                    | Retry + details                                                                                                                                                                                                                               |

- **Raw error** is folded into "详细信息" (details) and can be copied.
- **Copy** differs per connection method, with WSL and Docker variants. All copy exists in Chinese and English.
- **Where shown**: errors display in place in the wizard panel, device card, conversation banner or project row. A toast is only for background events and must carry "查看详情" (view details) that jumps to the device.
- **Capability fallback**: if the current transport cannot reliably recognize a host key change, classify as "unknown"; do not guess.

### Terms and copy

| Word the user sees       | Meaning and usage                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 远程设备 (remote device) | One remote machine; a WSL distro or a Docker container each counts as one device                                         |
| 连接 (connection)        | One way to reach a device, shown by the connection description; with several it is called "其他连接" (other connections) |
| 项目 / 任务              | Unchanged                                                                                                                |
| ZCode Server             | Appears only in install and update scenarios                                                                             |
| 发行版 / 容器            | Replace distro, and command names like docker exec / docker cp                                                           |

- **Words forbidden in the UI**: 链路, 线路, Source Server, 换代, 正史, canonical, direct-tcpip, 远端组件, short device ID. The device ID may only be copied from "更多 -> 设备信息" (More -> Device info).
- **Identity generation change is rewritten in user language**, e.g. "连接目标的身份已变化" + "作为新设备使用".
- **"Connecting" phase copy** is generated per SSH, WSL and Docker.
- **New and rewritten copy** needs Chinese and English, and English copy must also be checked for project-row width.

### Design system

- **Add an "in-progress" semantic color** with surface and foreground tokens, written into the design spec and token docs. "Connecting" no longer borrows the SSH type color or amber.
- **SSH, WSL and Docker type tokens** are used only on type tags; the new-connection form's type switch, association tag and candidate icon blocks count as type tags (RDUX-27).
- **Clean up non-conforming usages**: font sizes outside the scale, hard-coded colors, arbitrary-value colors, icon sizes and radii not in the spec.
- **Dark theme**: re-check contrast of status labels, sidebar and settings navigation.

### Ownership and acceptance

```text
Host connection state / Directory install identity -> existing management snapshot
project attachment / auto recovery facts -> UI pure-function presentation model -> status, primary action, color everywhere
user action -> existing connection wizard / update command -> Host owner -> next snapshot
attachment recovery paths of desktop continuous and mobile replayable keep their existing boundaries
```

- Device error code/raw text and project errors are separate inputs: a project error may already be localized and must not override the device error raw text used for authentication classification. Root forwards existing project recovery facts to header/task rows through a read-only Context; the presentation result keeps the profileId that produced the state so the right connection is repaired.
- Two public seams: `resolveRemoteConnectionPresentation` (state projection) and `classifyRemoteConnectionError` (error classification); neither holds mutable business state.
- Table-driven coverage of the parent spec's state combinations, all 02 public error codes and the unknown fallback, SSH/WSL/Docker copy and the local-download gate.
- Components assert model output via DOM; first reproduce the local update direction, pending state, double spinner and invisible recovery progress problems.
- After an active disconnect, sidebar and settings are both neutral "not connected"; real SSH E2E verifies and syncs the case catalog.
- Token contrast, forbidden-word and zh/en key-consistency checks; desktop light/dark theme and narrow-screen checks plus existing phone recovery regression.

## Device names and compatibility

### Default device name

- On the first handshake of a new Source, if the current SSH Profile's `target.sshConfigAlias` is non-empty, the default `displayName` is the trimmed alias.
- Without an alias keep using `hostname · osUser`; if both are missing fall back to `sourceServerId`.
- An existing Source's `displayName` always wins, so user renames are not overwritten.
- A new Source discovered after an identity-change confirmation follows the same rules.
- The alias still takes no part in `workspaceIdentity`, Profile dedupe or device identity decisions.

### SSH credential downgrade compatibility and self-healing

- The Source Profile remains the SSH credential authority of the current version. When writing `lastWorkspaceSession` for an old Desktop, each workspace uses its own `remote-workspace:<legacyIdentity>:*` mirror, so an old version closing one workspace does not delete the shared Profile secret.
- The rollback snapshot must first write the Profile secret into the legacy mirror through `credentialService` and only then the matching credential key; if the mirror write fails the settings reference must not be committed.
- When one exact SSH route has several legacy workspaces, non-sensitive target metadata still comes from the entry with the latest `lastOpenedAt`, and password/passphrase each from the latest entry that "actually has a value".
- Profile migration writes the `connection-profile:<profileId>:*` reference only after the secret copy succeeded; empty references no longer propagate as new dangling references.
- `SourceServerDirectory.initialize()` runs an idempotent audit over SSH Profiles with migrationVersion=1: when the canonical secret is missing, restore it only from legacy siblings of the same `routeKey`; if no real secret is found keep the "interactive credentials needed" semantics, without fuzzy matching.
- The dialog must not call SSH when neither the password nor the key authentication chain is complete; the connect screen shows that credentials are needed and allows returning to configuration. This gate is defense in depth and does not replace mirror and migration repair.
- No change to workspace identity, Profile schema, credential encryption format or Mobile attachment semantics.

### Menu and minimize

- The device "more" menu has a stable minimum width and non-wrapping action rows; the maximum usable width is still bounded by content and viewport.
- In every installed state (online, offline, failed, retrying, needs upgrade, updating, etc.) the device "more" menu offers "移除设备" (remove device); removal deletes only the local record and credentials, does not depend on the remote connection, and Host `removeSourceServer` first idempotently disconnects and then deletes the record. "在侧边栏中显示" (show in sidebar) is offered only when the device has open projects, locating the existing project without depending on online state; the menu must never be empty.
- The minimize button is no longer gated by `loading || connectedSessionId`; it is visible at every step.
- Minimize is not close and cleans no state; close semantics keep the original contract.

## Install and update progress

- While an automatic or manual update is running, the subtitle shows "正在更新远端服务" (updating the remote service), taking precedence over the last connect's needs-upgrade error; after failure or cancel the retryable error scene is kept.
- The upload percentage represents archive transfer only, not install completion. After transfer it enters the extract phase immediately; the remote CLI emits optional `--progress` output as line-by-line JSON events `{type:"source-server-install-progress", phase}` with phase `verify-archive`, `extract`, `verify` or `restart`. Default CLI output and the last-line result JSON are unchanged.
- During command execution the Adapter validates and forwards progress, reusing the Host operation log; unknown/non-progress output is not a basis for phase or success. Failure still uses the exit code and final result, keeping staging cleanup, the running-task guard and rollback semantics.
- The connect screen's install phase shows localized sub-captions for upload, extract, verifying the package or verifying service files; only the current upload phase shows a percentage. Other phases keep an in-progress indicator and simulate no percentage. `restart` enters the existing "启动服务并握手" (start service and handshake) step and completes only on a real handshake and connection ready.

```text
before: upload 100% -> [extract / verify / restart, no events] -> result
after:  Adapter upload/extract -> CLI verify-archive/extract/verify/restart
        -> Host operation log -> UI phase projection -> handshake -> ready
```

Progress facts belong to the remote installer; connection state still belongs to the Host manager; the UI only projects existing events. No persisted state or retry is added and the session recovery boundaries of desktop continuous and phone replayable are unchanged. SSH/WSL/Docker share the Adapter progress parser.

Acceptance: during a delayed verify the verify phase is shown with no upload percentage; phases are visible while the command has not finished; chunked output and non-JSON logs do not affect the result; a verify/restart failure cannot show ready; during auto update there is no stale failure subtitle, and after cancel/failure the error remains visible.

## Connection logs and failure contract

- The Host forwards only progress that the connect pipeline reports actively via `onLog`; console and other services' diagnostics never enter the user-visible log. Absolute paths, credentials, tokens, connection profiles and device identifiers are filtered uniformly; paths containing spaces are filtered by quotes or an explicit path-field boundary, keeping the non-path failure reason after the path; unquoted, non-disambiguable path tails stay conservatively masked, keeping only explicit diagnostics such as exit codes; the wizard, recent log and feedback use the same filtered result. Known secrets such as passwords and key passphrases are masked only as whole tokens (when the secret is bordered by letters, digits or underscores, the adjacent characters must not be of that kind either); substring replacement is forbidden, because a short password would turn fixed copy like `device` into `[redacted]ice` and leak the password.
- Waiting for install confirmation is logged as info. A failure response always contains a non-empty message and a shared-registered error code; a confirmed domain code beats cause-text inference, and unclassified AggregateError and phase wrappers use the recognizable inner error. SSH authentication and known private-key decryption failures get `remote-authentication-failed` at the SSH adapter boundary and the phase fallback does not override that classification; the UI's zh/en classification is synced, and old codeless text keeps a compatible fallback. Connection refused/unreachable, timeout, DNS, trusted host-key error, download, upload, pre-check, install, space, permission, cancel and unknown are classified separately with zh/en mapping synced.
- The Host connection management service is the only owner of recent operation logs; each device keeps the latest connection or update, up to 100 lines, in runtime memory only. Connections not yet handshaken are isolated by profile; after the handshake they belong to sourceServerId and different routes of one device share the latest operation. A new operation replaces the old log; late output from an old operation cannot overwrite the new one. The internal reconnect after an update belongs to the same update.
- `getRecentOperationLogs(profileId)` queries the latest log of the owning device and remains readable after closing/reopening the wizard or settings page; it is cleared when the device/route is deleted and on Host exit. The settings device card and unfinished connections both offer "查看最近日志" (view recent log); the remote identity details in the sidebar/chat project menu read the same log while connecting and show only phase, progress and elapsed time, never the raw log (see [connection progress details](../remote/project-first-remote-navigation-spec.md#连接进度详情2026-10-15)). The query result is a display projection; the UI keeps no independent log history.

```text
connect/update -> SourceServerConnectionManager accepts the operation -> explicit progress -> uniform filter -> bounded in-memory log
                                                └-> event notification -> UI queries the latest log
failure -> shared error classification + non-empty message -> Host schema -> Main -> zh/en copy
```

This contract concerns only the device connection-management RPC and connection logs; the desktop continuous / mobile replayable recovery boundary of task streams is unchanged.

## Connecting and directory screens (RDUX-11, 2026-09-29)

As in the approved prototype 06: the connect screen is titled by device name, connection method and full address; the vertical phases are establish channel (named per SSH / WSL / Docker), identify device, install components, start connection. There is no "connection ready" phase; success goes directly to the directory or restores the specified project. The current phase is bold and shows elapsed time, completed items keep their duration; install sub-steps show upload/download progress, size, speed and estimated remaining time; when speed is unknown it explicitly shows estimating. Waiting for password/key passphrase, install, device reinstall confirmation, forced-update confirmation and classified errors are embedded in the respective phase. The log is collapsed by default and expanded on failure, and copy-log appears only after expansion. While running or waiting for the user, the footer has "在后台继续" (continue in background) at left and "取消连接" at right; a failed terminal state switches to "返回列表" (back to list) at left and "关闭" (close) at right, and an existing failure must not be rewritten as an active cancel. Retry is allowed after cancel. The install-complete marker shows install done and waiting for start, and does not regress to verifying files.

Install info comes from the Host's remote probe and the same release descriptor: version, absolute install path, and the package's actual byte size (explicitly labeled package footprint; the archive size is not passed off as post-extraction footprint); unknown info shows "暂无法获取" (currently unavailable), no fake values. The read-only install preview neither uploads nor installs; after confirmation it reuses the existing install command. The running-task list comes from the remote task owner's activity projection, and forced update still passes the force=false guard first. When an old remote provides no list, explicitly show that the list is unavailable and do not fabricate tasks. If extra reads of the install preview, release metadata or running-task list fail, the confirmed install/forced-update wait point is kept and information-unavailable is shown; the release resolution and verification needed by the actual install keep failing strictly and cannot bypass the force=false guard or confirm a forced update on the user's behalf.

```text
user select/retry -> wizard flow owner (requestId / epoch) -> Host connection owner
                   ^ read-only state, install preview, log, task activity projection v
              inline confirmation -> existing install/identity-confirm/update commands
cancel/close -> settle cancel telemetry immediately -> revoke epoch -> drop late results; minimize only changes visibility
explicit new entry -> flow owner clears old wait points/intent -> new epoch consumes; card restore keeps the original epoch
directory chip -> browser's latest navigation request -> success path -> open project
```

The directory screen shows the full path, with recent and remote records on separate rows; chip navigation must update directory content and an earlier request cannot overwrite a newer navigation. A read failure shows a friendly reason; during failure or loading an unconfirmed directory cannot be opened; the footer keeps "稍后选择" (choose later). The device name can be saved in place: success shows "已保存" (saved), failure keeps the draft with feedback; the status bar shows only connection state, connection method/route and known version, without repeating the device name or filling placeholders.

First-use notice: restore the original "本地离线，任务照常运行" intro page and remove the one-line hint on the directory page. It shows after a successful active connect, before continuing device completion / directory / original project; the first explicit remote directory browse of an already-connected device reuses the same confirmation entry. Background completion and silent startup recovery do not pop it; a background result shows it only when the user explicitly continues. When another confirmation dialog is occupying, the connect flow keeps the completion action and continues after release; closing the confirmation or changing entry revokes it. While reading the read state or saving, minimizing must also keep the completion result and wait for the user to continue explicitly: no automatic intro, no handing over the original completion callback. Only clicking "知道了" (got it) writes `remoteBoundaryIntroAcknowledgedVersion: 1`; showing, cancel, unmount, read failure and stale responses never record read. Version 2 covered both the old dialog confirmation and automatic read from the one-line hint and the two cannot be told apart reliably, so users whose new marker is unset (including old-field version 2) see it once more, and with the new marker 1 it does not repeat. The old field stays `remoteBoundaryOnboardingVersion?: 2`, for rollback compatibility only, and is not evidence of confirmation by the new version. A persisted old-field version 3 is migrated to old-field 2 and new marker 1 before full schema validation; SettingService reads via the existing write lock, re-reads, migrates and saves atomically, and the migration cannot overwrite concurrent preference updates. An old client strips the new marker and can still read and save the original settings, so rollback needs no extra compatibility release; rolling back then upgrading again may show the intro once more. A read/save failure keeps it unread and does not turn an intro failure into a connect failure; later active use can confirm again. The intro page's look and copy reuse the original component; Escape/backdrop do not count as confirmation; once the operation's entryEpoch/form epoch is invalid the old navigation does not continue. Task owner, identity isolation and recovery chain of desktop continuous and phone replayable are unchanged.

Intro body copy: Chinese is 「关闭 ZCode 或休眠本机，\n远程任务继续运行。」 with an explicit line break after the comma; English is "Remote tasks keep running, even when you close ZCode or put your computer to sleep." with balanced wrapping and no fixed break position. The body keeps the newline and still wraps on narrow windows, so the last line never holds just one or two Chinese characters. Existing dialog width, font size and theme are kept; at the default 14px both languages take two lines, at 16px Chinese still takes two lines and English may take three. Visual verification mounts the real dialog directly, covering desktop and a 390px narrow window, light/dark themes and 14/16px font sizes, with no remote server needed.

```text
old behavior: directory hint shown -> automatically record old marker 2
stored old marker 3 -> schema migration -> SettingService saves old marker 2 + new marker 1 under the write lock
new behavior: active connect success / explicit use of a connected device -> intro page -> "知道了" -> new marker 1 -> original flow
background completion -> wait for user to continue -----------┘
cancel/change entry -> revoke the original epoch -> drop late results
```

Acceptance: wizard DOM covers inline waits, auth retry, cancel and late responses, real install info, phases and transfer, directory navigation/errors/rename; real SSH covers auth failure / connection refused / first-install info / non-blocking notice, with screenshots covering light/dark themes and 900px.

Running-task list contract: Core keeps deriving the active set from the owner facts of `turn.started/turn.terminal`, isolated by `workspaceIdentity || workspacePath` + sessionId; the Supervisor heartbeat/task-activity gains an optional list. `running-tasks --json` returns that list read-only (null when unknown), and the Host reads it after the forced-update guard refuses and shows it via the management snapshot. This extension changes neither the persisted `status.json`, the version rollback format, App <-> Agent messages, desktop continuous nor phone replayable delivery.

## Settings guards, edit connection and machine labels (RDUX-05)

- The edit-connection dialog reuses existing connection fields; device name and connection name are validated and saved separately, and a device-name error must not show a connection-name error. Confirmation of dangerous operations focuses Cancel by default and Enter must not run a dangerous operation by default; before disconnecting an inline note explains the impact.
- The settings page never shows the "正在编辑：本机 / <设备名>（远程）" (editing: local / <device> (remote)) hint row and its icon, covering general, plugins, MCP, skills, commands, hooks and subagent lists and edit forms; desktop and phone, light/dark and zh/en are consistent. The scope menu keeps the device name; settings read/write ownership follows the existing service scope.
- Device operations are de-duplicated and mutually excluded by the same sourceServerId (profileId when unrecognized); unrelated device operations, read-only details and log viewing stay available, and one device's long update cannot lock the whole panel.
- "在设置中管理" (manage in settings) and starting an update only locate the matching device card; only an explicit "查看详情" (view details) intent opens the failure details. A device's current failure does not mean every locate action pops a modal.
- Failure reasons and update info of different connections of one device display independently; only the same reason of the same Profile can be de-duplicated, and another connection's update banner must not mask a failure.

## Settings device card and update prompts (RDUX-13)

Device card (layout settled 2026-10-15):

- **Title row**: neutral connection-method icon, name, five-state status and primary action/edit/more. The primary action comes from the presentation model; when connected, the primary action "断开" is a ghost button, and "断开后远端任务继续运行" (remote tasks keep running after disconnect) is only that button's hint (title), no longer a permanent line of text.
- **Connection row**: the connection description uses type tokens and prefers the actually online connection; followed by the remote version, and when offline by "最近在线" (last online). With only one connection the card shows no "当前 / 默认" (current / default); with several, the same neutral small tags mark "当前" and "默认".
- **Recent projects**: under the small title "最近项目", known projects ordered by `lastOpenedAt` descending, each row a folder icon, display name, full remote path (monospace, truncated, full text in title) and relative open time; a project already open in this window gets an "已打开" (opened) tag. 3 rows by default; beyond that "显示全部 (N)" (show all) expands within the card, never an unopenable +N. Clicking first resolves the unique existing entry from the shared project directory by Source and directory, passes preferredProjectEntryId, preferredProfileId and preferredDirectoryPath, and after connecting opens the original project directly without entering the creator; when the original entry cannot be determined, stay on the current page and prompt to choose from the sidebar. Entry and connect-completion validation: [project navigation](../remote/project-first-remote-navigation-spec.md#2-入口与连接顺序). With no projects it shows "0 个项目".
- **Footer**: below one divider at the card bottom are two collapsible entries "其他连接 (N)" (other connections) and "最近日志" (recent log), expanded content showing below the footer in order. The recent log is collapsed by default and expanded by default when the device presentation state is failed; once the user toggles it, the user's choice wins. The log box uses `bg-surface` without border to avoid a card within a card. Other connections, once expanded, keep actions always visible and wrappable, without a second card border.
- Device info (hostname, system user, device ID) and copy-ID stay in the more menu; the version is already in the connection row.
- **Page order**: description text and "新建连接" -> small title "设备 (N)" and device cards (snapshot order kept, not reordered by state so cards do not jump after user actions) -> "未完成的连接" (unfinished connections) without sourceServerId (collapsed by default, supporting retry, delete and cleanup after confirmation) -> archived connections -> connection preferences. A recognized device keeps its card even when offline or needing reinstall.

An optional update shows only a navigation dot and a neutral banner (later / update), no toast; a mandatory update uses a warning banner stating version and impact with actions only in the title row. The automatic-prompt dedupe key is sourceServerId + availableVersion, persisted in a versioned UI local preference; disconnect, connection change and restart do not clear it. "Later" hides the optional banner of the same device and version for this renderer run, and re-mounting the settings panel does not clear it; after app restart it is visible again. Persistent dedupe does not hide a device's actionable update state. An active update shows the existing phase/progress; success toast; failure toast can open that connection's details and recent log.

```text
Host state event -> management snapshot -> five-state presentation model -> device card/navigation dot
                        -> notification controller -> UI persistent dedupe (device + target version)
user update -> updateSource(force=false) -> running-task guard
         -> read the task list from the same Host snapshot -> user confirms -> force=true
```

The task list is read-only from the existing owner; an old remote without a list explicitly shows unavailable. Project identity, desktop continuous and phone replayable keep their original contracts. Acceptance covers failed-connection classification, recent project ordering and show-all, other connections current/default, dedupe across restart and reconnect, "later" lifecycle, forced-update list, themes and narrow screen.

## Visual and accessibility finish (RDUX-A11Y, 2026-09-29)

- Auxiliary text in remote UI, sidebar device tags and settings navigation uses `remote-foreground-muted` and reaches 4.5:1 on the actual surfaces of the four built-in themes; type tags and five-state tags are verified separately, and contrast is not met by lowering font size.
- Auth and resource-download segmented buttons provide a localized group name and `aria-pressed`; input labels associate with unique ids. Connection status offers readable semantics and dynamic status labels use a polite live region.
- Remote input placeholders are uniformly sans, path values keep mono. Description text uses natural wrapping and `text-pretty`; step numbers and directory buttons follow the radius spec.
- The dialog's close name follows language switching; the project drag preview keeps the same device name as the project row (same Source name projection).
- In sidebar project rows and the chat project list, the project name keeps `text-ui-base` and the device name `text-ui-sm`; both texts align on the text baseline in one container, with the cloud icon and selection mark centered vertically in the outer layer. Long names stay single-line with ellipsis and do not push out trailing row actions; desktop and narrow screens, light/dark themes and 14/16px UI font sizes all follow this rule.
- Keyboard covers wizard form, password show/hide, download choice, directory confirmation, sidebar details/more and settings card actions; light/dark x zh/en x 1400/900px screenshots all fix the sidebar at 264px.

Expansion, active item and password show/hide of history candidates are owned by the field component; input values still go back to the owner through the original form's `onChange`.

```mermaid
stateDiagram-v2
    Closed --> Open: focus / click the input
    Open --> Open: input filters / arrow keys change active item
    Open --> Closed: Enter fills the selected value
    Open --> Closed: Escape / Tab / outside interaction
```

When history opens, focus stays in the input and `aria-activedescendant` points to the active candidate; Escape only closes the candidates and Tab continues native focus movement. The password show/hide button does not submit the form.
