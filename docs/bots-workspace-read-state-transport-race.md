# Bot workspace state read and Agent restart race

## Problem

Bot handling of a workspace switch or a workspace config read calls `workspace/readState` over the ZCode Protocol for model and mode state. After the workspace client is obtained, a restart of that workspace (config update, model switch, or process lifecycle change) closes the old client's stdio transport before the request is sent, and the user receives `ZCode agent stdio transport is closed`.

## Semantics

- `workspace/readState` is read-only: on a transport-closed race it may re-fetch the current workspace client and retry once.
- The retry must re-fetch the current Environment's client and wait for that Environment's Provider Registry readiness before calling `workspace/readState`; it must not re-push Registry or credentials from Desktop.
- Retry only the explicit transport-closed error; do not extend this to non-idempotent requests such as session creation or prompt sending.
- At most one retry; if the host has shut down entirely or the new Agent is still unavailable, throw the second request's real error.
