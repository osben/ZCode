# Topic resources in Rust mode (`ReadTopicResource`, `topic/resource/*`)

Part of `specs/fork-rust-agent-parity.md`. A bot-group task (a Feishu/Lark topic) gets the topic history as a file. The
file's resource index lists the files and images of earlier messages (A1, A2…). The model downloads one with the tool
`ReadTopicResource`. The agent asks the Host with the reverse request `topic/resource/read`; the Host fetches the
resource from the platform and uploads it into the session through `v4/attachment/*`.

Before this change zcode-rs had no such tool and never stored the input's `botGroupSource`. In Rust mode a topic task
could not read a historical resource at all.

## Node behaviour (the reference)

### Tool registration and metadata

Sources: `core/src/tool/handlers/read-topic-resource.ts`, `tool/topic-resource/contract.ts`, `reader.ts`.

- The tool is registered only when the runtime has a `topicResourcePort` (App-managed sessions, `server-operations.ts`).
  It is not offered to workflow actors.
- It is deferred (`shouldDefer`).
- It is not read-only and is concurrency-safe. It needs no approval (permission `session.topic_resource.read`).
- Timeout 300 s; result limit 4096 bytes.
- The model's description is `description` followed by `\n\nUsage:\n- …` built from `modelInstructions` (`registry.ts`
  `toolDescriptionForProvider`).
- Input: `{inputId?: string(1..256), messageId: string(1..256), index?: int ≥ 0}`, strict. `index` defaults to 0.

### Authorization

The tool reads the session's stored messages (`sessionStore.messages`): user messages that are not synthetic, newest
first.

- A message's intent is `metadata.conversationInputIntent` when that key exists, else `metadata.inputIntent`. A message
  without an intent is skipped.
- An intent is an identity when it parses as:
  - `sourceCommandId: string(1+)`;
  - `botGroupSource: {botId, chatId, threadId, authorizationId: string(1+), topicHistory?: {resourceMessages:
[{messageId, count > 0}]}, topicContext?: {messages: [{id, attachments?}]}}`.
- An identity whose `sourceCommandId` differs from a given `inputId` is skipped.
- An intent that has a `botGroupSource` key but does not parse stops the search.
- No identity found: `No admitted topic authorization is available for this input`.

When `inputId` is given, the resource must be indexed in that snapshot. Otherwise the error is
`Resource is not indexed in the selected history snapshot`. The resource is indexed when:

- `topicHistory.resourceMessages` has an entry for the `messageId` with `index < count`; or
- without `topicHistory`, `topicContext.messages[id = messageId].attachments[index]` exists.

### The port

`read` (`bootstrap/src/zcode-protocol/topic-resource-port.ts`) sends the reverse request `topic/resource/read`:

- Params: `{taskId: <session>, inputId: <sourceCommandId>, authorizationId, messageId, resourceIndex,
requestId: <uuid>}`.
- Timeout: 120 s.
- Reply: `{ref, fileName(1..1024), mime(1..256), bytes(0..20 MiB)}`, strict.

On abort it sends a best-effort **request** `topic/resource/cancel {requestId, taskId}` (reply `{cancelled}`) and
ignores its failure.

### Checking and writing the bytes

`ref` is the `zcode-artifact://<session>/<artifact>` that the Host's upload committed. The artifact holds
`data:<mime>;base64,<payload>`. The tool requires that:

- `bytes` is a safe integer in 0..20 MiB;
- the content matches `^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$`, with the reply's `mime`;
- the payload is no longer than `ceil(20 MiB / 3) * 4`;
- the decoded length equals `bytes`, and the decoded bytes re-encode to the same payload.

The bytes are written as a session-retention binary tool artifact; the extension comes from `fileName`, else `bin`. The
result is `{status: "success", path, fileName, mime, bytes, messageId, index}`, given to the model as JSON text.

### Where `botGroupSource` lives

- The `sendText` payload's `botGroupSource` is stored in the input intent after `conversationQuotes` (`input-intent.ts`,
  `v4-bridge.ts`).
- User rows carry it (`projection-rows.ts`, `product-projection.ts`). The App draws the bot source label and the topic
  preparation from `row.botGroupSource`.

## Owners in Rust

| State / step                                | Owner                                                                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The input's `botGroupSource`                | `protocol-zcode` `commands.rs` `input_intent` for a live input (edit/retry drop it, like Node). Stored on the user message like every intent field; a queued input keeps its intent |
| Which input authorizes a read               | `ReadTopicResourceTool` (`tools`), from the session's stored messages (`Store::load`, `earlier ++ messages`), not the in-memory model view, which may be compacted                  |
| The reverse request, its timeout and cancel | `protocol-zcode` `HostTopicResources`, which implements `kernel-api` `TopicResources`. When a read is dropped unanswered, it spawns a `topic/resource/cancel` request               |
| Upload of the bytes into the session        | The Host, through the existing `v4/attachment/begin\|chunk\|commit` (`attachments.rs`), concurrently with the pending tool request                                                  |
| The materialized file                       | The session's `ArtifactStore` (a `ToolOutput` artifact; its local path is returned)                                                                                                 |
| Whether the tool exists                     | `rust_cli_runtime::Extensions::topic_resources`: `Some` only in the app-server (`Controller::app`), so the TUI and `-p` have no such tool                                           |

## Event order

```mermaid
sequenceDiagram
  participant M as Model
  participant T as ReadTopicResourceTool
  participant S as Store
  participant P as HostTopicResources
  participant H as Host
  participant A as attachments.rs
  M->>T: tool_use ReadTopicResource {messageId, index}
  T->>S: load(session): newest admitting intent
  T->>P: read {task, input, authorization, message, index}
  P->>H: request topic/resource/read {requestId, …}
  H->>A: v4/attachment/begin, chunk…, commit (session = task)
  A-->>H: {ref: zcode-artifact://session/id}
  H-->>P: {ref, fileName, mime, bytes}
  P-->>T: resource
  T->>T: read ref, check data URL, write ToolOutput artifact
  T-->>M: {"status":"success","path":…,"fileName":…,"mime":…,"bytes":…,"messageId":…,"index":…}
  Note over T,P: tool call cancelled before the reply: P spawns request topic/resource/cancel {requestId, taskId}; the 120 s timeout sends none, like Node
```

## Differences kept on purpose

- **File extension.** It comes from the mime type (`node-store` naming: `.txt`, `.png`, `.pdf`…, else `.bin`), not
  from `fileName`, because zcode-rs's artifact store names files by purpose and type. Text, images and PDFs get the same
  extension as in Node; an office document gets `.bin` instead of `.docx`.
- **Ref session.** The `ref` must name the current session; the Host always uploads into the task it was asked for.
  Node reads any ref.
- **Request id.** `requestId` is the agent context's fresh id (`topic-resource-<prefix>-<n>`), not a UUID; the Host
  treats it as an opaque key.
- **Intent selection.** It uses zcode-rs's hydrated intent (`node-records` `of_message`). A stored
  `conversationInputIntent` that does not have Node's shape falls back to the legacy `inputIntent`, or is dropped when
  there is none, so the search goes on to older inputs; Node's tool stops at it instead. Both builds write
  Node-shaped intents, so only a hand-edited or foreign record can reach this.
- **Subagents.** The tool reads `context.session`, like Node's `context.sessionId`: a subagent's child session has no
  admitted input, so the read fails with the authorization error.

## Not ported (recorded in the parity spec)

- `ReplyToChannel` / `bot/channel/reply`.
- The bot-source model guidance Node appends to the input (`withConversationQuotes` with `botSource`): the
  automatic-delivery note, the trusted bot identity and the message addressing.
- The group task permission scope (`ensureGroupTaskPermissionScope`).

## Acceptance cases

Unit tests:

1. `sendText` with `botGroupSource` stores it in the intent right after `conversationQuotes`, before
   `sourceCommandId`; without it there is no key. Edit/retry drops it, as Node's `fork-edit-retry.ts` replay does
   (already covered by `row_commands` tests).
2. A user row, live and steer, whose intent has `botGroupSource` carries `row.botGroupSource` and shows the typed text.
3. The tool is registered, deferred, only when `Extensions::topic_resources` is set. Its definition equals Node's
   (generated from `contract.ts` and the handler metadata).
4. Authorization:
   - the newest human intent with a valid `botGroupSource` is used;
   - a newer intent without one does not hide it;
   - an intent whose `botGroupSource` is malformed stops the search (error);
   - `inputId` selects that snapshot only;
   - no intent at all gives the Node error text.
5. With `inputId`: `topicHistory.resourceMessages` bounds the index; without `topicHistory`, `topicContext` attachments
   do. An unindexed resource fails before any request.
6. A good reply is materialized:
   - the port gets `{task, input, authorization, message, index}`;
   - the result is Node's JSON with the stored file's path;
   - the file holds the decoded bytes.
7. Bad replies fail: `bytes` over 20 MiB, a mime mismatch, a byte count mismatch, non-canonical base64, a ref of
   another session, a missing artifact.
8. Cancelling the call while the read is pending ends it as cancelled. The port sends `topic/resource/cancel` with the
   same `requestId` and `taskId`. The port's 120 s timeout fails the read without a cancel; the tool's 300 s timeout
   fails the call.
9. `HostTopicResources`: params, and reply validation against the strict reply schema in `inbound.json` `replies`.

E2E, in the Linux box on both runtimes:

- `conversation-session/session-control/conversation-session-bot-topic-worker` ("downloads admitted historical
  resources through the actual ReadTopicResource tool");
- `bots/channels/feishu-topic-runtime` and `bots/channels/feishu-topic-interactions`, as regression checks.
