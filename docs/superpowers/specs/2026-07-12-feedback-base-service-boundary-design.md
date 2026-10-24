# Feedback Base Service Boundary (SSH disconnect scenarios)

## Background

The feedback center is a desktop app-level capability: ticket creation, device snapshot, screenshot upload, and diagnostics packaging all run on the desktop's local host process via `feedbackService`, independent of the current workspace's filesystem, Agent runtime, or SSH connection.

`FeedbackHost` used to read `feedbackService` from workspace-scoped `services`. With an SSH workspace connected, the renderer merges base and remote services and the instance still came from base; but with a remote session unbound or disconnected, the workspace service resolver returns the disconnected proxy, so the first `getDeviceSnapshot()` threw `ZCODE_REMOTE_WORKSPACE_DISCONNECTED` inside the renderer before the request ever reached the feedback API.

## Goals

- The feedback center always explicitly uses the base `feedbackService` registered at desktop startup.
- Feedback can be submitted while SSH is connected, connecting, or disconnected.
- Existing feedback behavior for local workspaces and connected SSH is unchanged.
- Workspace routing of remote file, terminal, Git, Agent, task, and session services is unchanged.
- Desktop `desktop-continuous`, mobile `web-remote-replayable`, snapshot, queue, and owner/lease semantics are unchanged.
- Web remote control keeps its existing unsupported feedback fallback; no new Web feedback capability.

## Non-goals

- No change to the `ZCODE_REMOTE_WORKSPACE_DISCONNECTED` disconnected-proxy protection rules.
- No general workspace-scoped fallback to local services after disconnect.
- No changes to the feedback form, screenshots, log archiving, attachment upload, or feedback API protocol.
- No SSH auto-reconnect or remote session lifecycle work.

## Design

`Root` holds the base `IServiceAccessor` injected at desktop renderer startup and passes its `feedbackService` to the workspace UI as a dedicated dependency, which reaches `FeedbackHost`. `App` keeps receiving workspace-scoped `services` for file/task/terminal capabilities; the feedback center no longer reads `feedbackService` from it. The dependency boundary is explicit:

- workspace capabilities depend on `workspaceScopedServices`;
- the app-level feedback capability depends on `baseFeedbackService`.

Mount point, store, dialog lifecycle, and current task/model context reads of the feedback center are unchanged.

## Data flow

1. Desktop renderer receives the local host service port and creates base services.
2. `Root` receives base services and passes `baseServices.feedbackService` down as a separate prop.
3. The SSH tab keeps resolving workspace-scoped services by connection state: merged services when connected, the disconnected proxy otherwise.
4. `FeedbackHost` always calls the base feedback service from step 2, regardless of workspace state.
5. Device snapshot, ticket creation, screenshot upload, and log archiving keep running in the local host.

## Error handling

- SSH disconnect is no longer a feedback submission error source.
- Real errors from the feedback API, attachment upload, or local log archiving keep their existing flows; no new error swallowing or retries.
- Other service calls on a disconnected remote workspace still return `ZCODE_REMOTE_WORKSPACE_DISCONNECTED` from the proxy, preventing remote paths from mis-routing to the local machine.

## Compatibility

- Local workspace: the injected instance is the same base feedback service already used.
- Connected SSH: the merged-services instance already came from base; the called object is unchanged.
- SSH connecting/disconnected: switches from the disconnected proxy to the base feedback service — the only intended behavior change.
- Mobile web remote: keeps the entry-injected unsupported feedback service; no new remote business state, no bypass of replayable recovery boundaries.
- macOS/Windows/Linux: dependency selection only; no platform branches.

## Test design

Regression tests must prove feedback service selection does not depend on workspace-scoped services:

| Scenario            | Workspace services     | Feedback service | Expected                         |
| ------------------- | ---------------------- | ---------------- | -------------------------------- |
| Local workspace     | base services          | base feedback    | unchanged                        |
| SSH connected       | merged remote services | base feedback    | unchanged                        |
| SSH session unbound | disconnected proxy     | base feedback    | submittable, no disconnect error |
| SSH disconnected    | disconnected proxy     | base feedback    | submittable, no disconnect error |

Tests assert that `FeedbackHost` receives the explicit base feedback service, not that an object spread happens to keep the field. Existing feedback submission tests keep covering `getDeviceSnapshot`, ticket creation, attachments, and log flow.

## Verification

- New/related UI unit tests; `pnpm typecheck`; `pnpm lint`; confirm no extra diff in desktop local vs SSH service boundaries.
