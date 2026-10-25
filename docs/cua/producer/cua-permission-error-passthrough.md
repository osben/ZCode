# CUA permission error passthrough contract

## Conclusion

CUA no longer returns or translates `CUA_PERMISSION_REQUIRED`. Helper/Broker failures return as ordinary
MCP tool errors; the model uses the accurate original message to decide whether to call the read-only
`request_access`, prompt the user for authorization, or take other recovery actions such as re-activating
the app or re-observing.

## Reason

`permission_denied` is not equivalent to a missing macOS TCC grant. A foreground window mismatch, the
trusted Host's `prevent_activation` policy, Windows UIPI, Linux XTest, an invalid target and some native
capability failures can all use that code. The producer cannot reliably classify the permission kind from
a generic code alone, and a consumer that auto-opens a permission dialog from error text would spread one
unreliable inference into product behavior.

## Runtime contract

```text
Helper/Broker error
        |
        v
ordinary MCP tool error + original message + delivery evidence
        |
        v
model chooses request_access / re-observe / activate / stop

official request_access success (macOS only)
        |
        v
read-only text result + namespaced typed permission metadata
        |
        v
trusted ZCode Host may ask the user whether to open onboarding
```

- No producer-level macOS permission translation branch exists.
- No consumer-level error-text scan or ordinary-error-triggered automatic permission dialog exists.
- `request_access` stays read-only: it reports the current authorization subject, permission state and
  capabilities, and never opens a system dialog.
- A macOS success result carries a strict, versioned permission snapshot in the MCP result
  `_meta["zcode.cua/request-access-status-v1"]` for a trusted Host that has verified official-CUA
  authority; the model-visible JSON text is unchanged. On non-macOS, with missing fields or invalid
  enums, the metadata is not emitted.
- `accessibility=denied|stale` and `screenRecording=denied` are definite missing grants; `unknown` is not
  enough to trigger permission guidance.
- The Host must confirm official-CUA authority, the exact `request_access` tool name and live desktop
  delivery together; the UI then re-reads fresh state and asks the user. The producer never opens system
  settings itself.
- The settings page keeps user-initiated permission guidance.
- `action_sent`, `request_delivery_state` and `retryable` remain safety facts; a non-idempotent
  `possibly_sent` action must not be replayed automatically.
- `broker_unavailable` keeps using the existing `CUA_NOT_READY` contract, because it expresses transport
  readiness and the safe-retry boundary, not a permission classification.
- macOS, Windows and Linux use the same passthrough rule; error meaning is not rewritten by
  `process.platform`.

## Model recovery rules

- When the error explicitly mentions Accessibility or Screen Recording, call `request_access` once to get
  state. If the result shows a definite missing grant, tell the user authorization is needed and end the
  current turn; do not continue CUA, auto-retry or promise to continue automatically after authorization.
- For foreground, focus-policy, stale-target or capability errors, follow the recovery path in the
  original error; do not infer a macOS permission problem.
- On `possibly_sent`, re-observe or read independent business state first; never replay the action as is.

## Verification

- Real stdio MCP: the raw `permission_denied` message reaches the model, and the result has no
  `CUA_PERMISSION_REQUIRED`.
- `broker_unavailable` still returns `CUA_NOT_READY`.
- `possibly_sent`: delivery evidence is preserved and native dispatch is not repeated.
- Consumer replay: an ordinary failed ToolCallRow displays normally, live/cold restore are consistent, no
  automatic permission dialog.
- `request_access` metadata: valid macOS states output per schema with the text byte-identical; non-macOS,
  missing fields and invalid enums emit no trusted metadata.
- Real-model gates use the real model designated in the eval provider configuration; final success must be
  verified by fixture-owned app state.
