# Host business API proxy support

## Background

The Electron Renderer, WebView, and `electron.net` use the Chromium Session proxy. The Window Host is a separate Node process whose `NodeApiClient` defaults to Node `fetch` and therefore does not inherit `session.setProxy`. On forced-proxy networks, OAuth token exchange and other Host business APIs fail when connecting directly.

## Minimal approach

Add a request-level transport only at the Host API exit in `packages/services`, injected through the existing `NodeApiClient` `fetchImpl` hook:

- Proxy, No Proxy, and CA come from the existing `AppSettings`.
- The Host lazily loads and freezes the policy on first request.
- No Proxy is evaluated per request against the final URL.
- Without an explicit proxy, stay direct; when explicit proxy config fails, do not fall back to direct.
- Only `NodeApiClient` is covered — Renderer, Electron Session, Agent, Bot, telemetry, and other bare `fetch` calls are unchanged.

```text
AppSettings
    |
    v
Host Node transport -- final URL -> No Proxy? --+--> direct
    |                                           `--> proxy
    v
NodeApiClient -> OAuth / Coding Plan / client-scenes / provider APIs
```

## Boundaries and follow-up

This change does not pull the CLI adapter into services and does not set a Host-process global dispatcher. Sharing a Node egress adapter between Host and Agent is a possible follow-up refactor of its own, to avoid widening this ticket's regression scope over model requests, WebFetch, and HTTP MCP.

## Verification

Cover direct-without-proxy, proxied forwarding, No Proxy hits, proxy errors not falling back to direct, and routing after endpoint rewrite. Existing timeout, abort, and response-stream semantics must stay unchanged.
