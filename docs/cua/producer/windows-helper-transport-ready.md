# Windows Helper transport-ready handshake

Windows named pipes do not support the Unix helper rendezvous rename, so the Windows development Helper has
two startup milestones:

```text
fork -> bind/auth named pipe -> transport_ready -> load native/backend -> ready
```

`transport_ready` is emitted only after the broker listener is bound and the expected bearer-token gate is
installed. The Host validates the pipe and child PID before publishing the tuple to the Agent. During the
gap before native/UIA initialization, broker methods other than `broker_info` return retryable
`broker_unavailable` with `ready_state=warming_up`; the listener stays the same for the lifetime of that
Helper. `ready` remains the full health signal.

This avoids starting an Agent without CUA credentials during normal Windows cold start. A native/backend
failure still closes the one listener and follows the existing Host recovery/recycle path. No
close-and-rebind and no fixed pipe name is introduced.

## Backend initialization invariant

The listener may accept authenticated health probes while native initialization is still in progress, but
the native AX source and automation adapter are constructed only after the native addon has been installed
into the deferred surface. The warming backend returns `broker_unavailable` with
`request_delivery_state=not_sent` for tool requests; `broker_info` stays available for the startup health
probe. This ties capability detection (`typeof`, Session 0 gating, the Windows screen-capture ABI check) to
the real addon rather than a placeholder Proxy. Once the real backend is installed, missing optional exports
remain absent and are not reported as warming-up capabilities.
