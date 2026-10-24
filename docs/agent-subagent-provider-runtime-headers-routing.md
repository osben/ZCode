# Explore subagent provider runtime headers routing

## Background

The desktop subscribes to dynamic session events by the parent task's sessionId. An Explore subagent creates its own child sessionId inside the CLI for child session events, persistence, and trace archival.

Start Plan / bigmodel Start Plan must refresh `provider-runtime-headers` before each real model request (for example a one-time header required by the official build's request security check). This refresh is not a normal session event and does not go through `mirrorSubagentToolEvent` back to the parent task; it is a separate ZCode Protocol request.

## Problem

The Explore subagent reuses the parent runtime's `providerRuntimeHeadersPort`, but the refresh request is issued by the child runtime, so it carries the child sessionId. The desktop agent service dispatches dynamic events by the request's sessionId, while the UI subscribes only to the parent task's sessionId, never to `sess_subagent_agent_*`. Routed as-is, the child's runtime headers request lands on an unlistened child session channel: the renderer never handles it or calls `respondProviderRuntimeHeaders`, and the child's model request waits until the user stops it or the request is cancelled.

## Routing rule

The Explore subagent keeps its child sessionId for the CLI's internal ledger:

- Child session event persistence still writes to the child sessionId.
- Subagent lifecycle/tool events still mirror to the parent task as before.
- Trace context and parentSessionId relationships are unchanged.

Only when the subagent calls `providerRuntimeHeadersPort.refreshBeforeModelRequest` externally, the request sessionId is the parent task's sessionId. Runtime headers requests then route to the parent task channel the desktop UI already subscribes to, matching `mirrorSubagentToolEvent`'s external semantics: user-visible blocking interactions of a subagent belong to the parent task.

## Scope

The rule affects only model requests that need `provider-runtime-headers`, currently Start Plan / bigmodel Start Plan. It does not change session storage primary keys and does not write child session persistence into the parent session.

Any future standalone blocking protocol request added for subagents must explicitly decide whether it routes to the child session or the parent task session; eventSink mirroring does not cover protocol requests.

## Request isolation (2026-09-08)

The desktop production consumer is now the workspace-resident controller; parent session routing is kept. Runtime headers responses return to the subagent's current model call by unique requestId, and Host no longer rewrites the parent runtimeModel with the child model. Each child/parent model call owns its own per-request retry budget, never shared; parent user input is not edited and completed tools are not replayed.
