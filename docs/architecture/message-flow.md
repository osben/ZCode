# Message Flow (Current Facts)

## Main Path

```text
ConversationComposer / SessionPane
  │ createSession | sendText | other V4 command
  ▼
agentConversationTransport
  ▼
Host: sendConversationCommandV4
  ▼
zcode-cli for the workspaceKey
  ├─ command inbox adjudicates
  ├─ core executes
  └─ ProductProjection updates
       │ snapshot / delta
       ▼
SessionDataLayer
  ▼
ConversationProjectionStore
  ▼
ConversationTimeline / Composer / StatusPanel
```

The UI does not call the old `sendPrompt()` to construct chat state, nor does it assemble messages from legacy task events. `IZCodeTaskService` may still serve lists, metadata, or transitional compatibility surfaces, but it is not the source of truth for V4 conversation content.

## Input Sequence

```text
UI          Host             CLI inbox        Core/Projection
 | command   |                  |                    |
 |---------->| forward          |                    |
 |           |----------------->| validate/CAS       |
 |           |<-----------------| ACK                |
 |<----------|                  |                    |
 |           |                  |----execute-------->|
 |           |                  |<---events----------|
 |<========== snapshot/delta from conversation topic |
```

ACK and projection have different meanings: ACK answers “Was the command accepted or rejected?”; projection answers “What is the product state now?” The UI must ultimately converge on the latter.

## Multi-Client Delivery

- Desktop: `desktop-continuous`, subscribes directly to the live topic; recovers by `seq` after a disconnection.
- Mobile remote control: `web-remote-replayable`, subscribes to the same Host/CLI through a shared-host attachment and retains gap/snapshot recovery.
- Relay and Electron Main handle only authentication, pairing, heartbeats, frame forwarding, and attachment scheduling; they do not own conversation state.

```text
mobile /remote
  -> relay
  -> Electron main
  -> existing Host attachment
  -> existing workspace CLI
```

## SSH Remote Source Routing

SSH remote workspaces are routed by the registry inside the window's sole Host. Main only forwards connection-control requests and ports; it does not change the V4 conversation source-of-truth path:

```text
remoteSessionId A -- attachment A --┐
                                    ├-> Window Host / RemoteConnectionRegistry
remoteSessionId B -- attachment B --┘
                                    -> one SSH connection / zcode-server for the remoteHostKey
                                    -> independent CLI/runtime for workspaceKey A/B
```

Each attachment carries its own `attachmentId` and trusted `clientMode`. A Renderer reload replaces only the corresponding desktop attachment. `DetachServicePort` releases only one logical workspace's RPC/subscription; it does not destroy the window Host or an SSH connection that is still in use, and it does not bring mobile replayable recovery semantics into the desktop continuous path.

## Key Entry Points

| Layer               | Current entry point                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------- |
| UI pane             | `packages/ui/src/v4/SessionPane.tsx`                                                          |
| UI transport        | `packages/ui/src/v4/agentConversationTransport.ts`                                            |
| UI projection       | `packages/ui/src/v4/sessionDataLayer.ts`, `packages/ui/src/v4/conversationProjectionStore.ts` |
| Host service        | `packages/services/src/zcode-agent/zcodeAgentService.ts`                                      |
| V4 schema           | `packages/shared/src/zcode-protocol-v4/`                                                      |
| CLI gateway/reducer | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`                                    |
| Desktop host        | `packages/desktop/src/host/index.ts`                                                          |
