# Remote scenario usage telemetry V1

> Status: implemented

## Goals and definitions

This telemetry answers these product questions:

- How many users successfully use SSH, WSL, Docker or Server remote workspaces.
- How many users successfully use mobile Web Remote Control.
- The conversion of Web Remote Control from entry exposure through start and pairing to the workspace bridge.
- How many desktop devices the above scenarios involve.

User UV is de-duplicated by the `/event/report` common field `user_id` first; when logged out it falls back to
`device_mid`. The desktop device count is de-duplicated by `device_mid` only. The penetration-rate denominator
uniformly uses the same-definition UV of `app_daily_active`.

V1 counts neither mobile physical devices (no stable, compliant device identifier) nor SSH hosts (it would
introduce remote host identity and privacy risk).

## Architecture boundary

```text
Desktop renderer               Desktop main / manager              Telemetry core
       |                                  |                               |
       | remote connect / web entry       |                               |
       |--------------------------------->|                               |
       |                                  | terminal lifecycle result     |
       |                                  |------------------------------>|
       |                                  | low-cardinality fields + common identity |
       |                                  |                               |

Mobile Web -- replayable RPC --> relay/main passthrough --> shared desktop host
                 no new reporter         does not parse rpc-frame       desktop reports after the bridge succeeds
```

- Desktop main reports only at the terminal state of the existing connect, pairing and host-attachment
  lifecycles and holds no session/task business state.
- Mobile Web keeps `web-remote-replayable` and desktop keeps `desktop-continuous`; telemetry must not change the
  recovery semantics of either message chain.
- The external relay does not parse `rpc-frame` and the Web bundle adds no separate reporter.
- Remote-workspace remote control keeps using the shared-host attachment and creates no Agent runtime, local host
  or remote session.
- Telemetry failure is best effort and must not block connecting, pairing or the bridge.

## Event definitions

All events report low-frequency lifecycle terminal states in full. `event_extra_detail` allows only the fields in
the tables below, with string values.

### `remote_workspace_connect_result`

Trigger: a user-initiated remote-workspace connection reaches a success or failure terminal state in desktop main.

| Field             | Allowed values                      | Description                                    |
| ----------------- | ----------------------------------- | ---------------------------------------------- |
| `result`          | `success` / `failure`               | Connection result                              |
| `remote_kind`     | `ssh` / `wsl` / `docker` / `server` | Remote kind                                    |
| `connect_trigger` | `new` / `reconnect` / `restore`     | New, user reconnect or startup restore         |
| `error_category`  | see error categories; empty on success | Low-cardinality failure category            |

Startup restore currently restores only disconnected tabs and does not auto-connect, so V1 produces no `restore`;
the enum is reserved for a future real auto-restore, and a tab restore must not be recorded as a connection.

### `web_remote_control_entry_view`

Trigger: the user clicks the Web Remote Control entry and the dialog opens.

| Field            | Allowed values                                      | Description                                           |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------- |
| `workspace_kind` | `local` / `remote`                                  | Current desktop workspace kind                        |
| `remote_kind`    | `ssh` / `wsl` / `docker` / `server` / empty string  | Reported when resolvable from the unified workspace identity |

### `web_remote_control_start_result`

Trigger: desktop main handles an explicit start or re-pair request and reaches a terminal state.

| Field            | Allowed values                                      | Description                                                              |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| `result`         | `success` / `failure` / `cancelled`                 | Explicit start or re-pair terminal state; `cancelled` only for historical-data compatibility |
| `workspace_kind` | `local` / `remote`                                  | Target workspace kind                                                    |
| `remote_kind`    | `ssh` / `wsl` / `docker` / `server` / empty string  | Reported when resolvable from the unified workspace identity             |
| `error_category` | see error categories; empty when not a failure      | Low-cardinality failure category                                         |

Auto-restoring an existing remote-control runtime is not part of the explicit start funnel and produces no such
event. The current Desktop start and refresh chains no longer show a native confirmation, so only `success` /
`failure` occur; the schema keeps `cancelled` only for historical events or other cancellable platform
implementations, and it must not count toward the failure rate.

### `web_remote_control_pair_result`

Trigger: the desktop receives a pairing terminal state change from the relay.

| Field            | Allowed values                                      | Description                                                  |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `result`         | `success` / `failure`                               | Pairing result                                               |
| `pair_kind`      | `initial` / `reconnect`                             | First pairing in this manager lifecycle, or a later reconnect |
| `workspace_kind` | `local` / `remote`                                  | Target workspace kind when remote control started            |
| `remote_kind`    | `ssh` / `wsl` / `docker` / `server` / empty string  | Reported when resolvable from the unified workspace identity |
| `error_category` | see error categories; empty on success              | Low-cardinality failure category                             |

Repeated notifications of the same transport state do not report again; entering paired again from a
disconnected state is `reconnect`.

### `web_remote_control_bridge_result`

Trigger: the phone requests opening the workspace bridge and the shared-host attachment is established or fails.

| Field            | Allowed values                                      | Description                                  |
| ---------------- | --------------------------------------------------- | -------------------------------------------- |
| `result`         | `success` / `failure`                               | Bridge result                                |
| `workspace_kind` | `local` / `remote`                                  | Target workspace kind                        |
| `remote_kind`    | `ssh` / `wsl` / `docker` / `server` / empty string  | Remote target kind; empty for local          |
| `entry_kind`     | `home` / `task`                                     | Opened the workspace home or a specific task |
| `error_category` | see error categories; empty on success              | Low-cardinality failure category             |

Bridge success is the primary definition of "actually using Web Remote Control". Pairing succeeded without opening
a workspace does not count as an actual-use user.

## Error categories and privacy

`error_category` allows only: `auth`, `connect`, `deploy`, `host_start`, `attach`, `relay`, `unknown`.

The classifier may read error codes or messages locally but uploads only the enum value. No event may upload:

- `workspacePath`
- `workspaceIdentity`
- `remoteSessionId`
- SSH host, user name or port
- Docker container
- WSL distro
- raw error message or stack

## Metric computation

| Metric                          | Computation                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| SSH usage users                 | `remote_workspace_connect_result` with `result=success && remote_kind=ssh`, de-duplicated by actor |
| Usage users per remote kind     | Same, grouped by `remote_kind` and de-duplicated by actor                                       |
| Web Remote Control usage users  | `web_remote_control_bridge_result` with `result=success`, de-duplicated by actor                |
| Web Remote Control usage rate   | Web Remote Control usage users / same-period `app_daily_active` actor UV                        |
| Desktop device count            | Target success events de-duplicated by `device_mid`                                             |
| Funnel conversion               | entry view → start success → pair success → bridge success, each by actor UV in the same period |

The actor query rule is `user_id` when non-empty, otherwise `device_mid`. The client adds no `actor_id` field and
does no cross-event UV de-duplication.

## State ownership and implementation location

| State / fact                         | Owner                                            | Telemetry location                   |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------ |
| Remote workspace connection terminal | desktop remote IPC / session manager             | Before the IPC returns success/failure |
| Web Remote Control entry exposure    | desktop renderer                                 | Dialog-open action                   |
| Explicit start terminal              | desktop remote IPC                               | start/reset request terminal         |
| relay pairing state                  | WebRemoteControlManager                          | transport state transition           |
| workspace-scope Host attachment      | WebRemoteControlManager + shared-host attachment | bridge attachment terminal           |
| User and desktop device common fields | TelemetryCore                                   | Existing `/event/report` common fields |

## Case planning and pruning

Must cover:

- Field stability for SSH/WSL/Docker/Server new-connection success and failure.
- reconnect explicitly carries `connect_trigger=reconnect`; an ordinary connection defaults to `new`.
- Entry, start and bridge events for local and remote workspaces.
- First paired and reconnect paired after a disconnect.
- Attachment failure produces only allowed error categories and leaks no target information.
- A telemetry report failure does not change the original business return value.

Pruned in this phase:

- No new conversation/session E2E; this feature changes neither conversation state semantics nor the protocol.
- V1 counts no mobile devices, remote hosts, logical-session concurrency or connection duration; logical-session
  concurrency and observable connection duration are covered by
  [remote workspace connection ARMS custom events](./remote-usage-arms-telemetry.md), where the ARMS
  `active_target_count` is only a redacted diagnostic and not equal to the remote host count.
- No connection event is forged for a startup-restored disconnected tab.
- No telemetry is added in the relay, the Web bundle or `rpc-frame`.
