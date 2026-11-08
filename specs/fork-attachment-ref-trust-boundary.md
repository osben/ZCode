# Attachment ref trust boundary (fork)

## Background

A v4 `sendText`, `createSession.firstInput` or `editUserQuery` command carries
`AttachmentRef[]` (`packages/shared/src/zcode-protocol-v4/attachment-ref.ts`). Each agent runtime
maps `ref` to model input without checking it
(`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/attachment-refs.ts` and the
Rust agent behind the same stdio contract):

- a URI ref (`zcode-artifact://<session>/<id>`) is read from the session artifact store;
- any other string is a local path that the agent reads from its file system port.

`previewRef` is also a free string. The CLI gateway authorizes attachment preview reads when the
requested ref equals a row's `ref` or `previewRef`, so a planted `previewRef` would also authorize a
read.

Where refs come from today:

| Origin                                                    | Ref form                                                                    | Producer                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop renderer, local workspace                         | absolute local path (zero-copy)                                             | `useComposerAttachments` builds `ref: attachment.localPath` directly from a picked, dropped or path attachment; the Host transfer service is not called |
| Desktop renderer, remote workspace                        | path inside the remote staging dir                                          | `createRemotePromptAttachmentTransferService.stage`                                                                                                     |
| Desktop renderer, fallback / text material                | `zcode-artifact://<session>/<id>`                                           | `v4/attachment/commit`                                                                                                                                  |
| Web remote (paired phone over relay, plain `/ws` browser) | `zcode-artifact://<session>/<id>`                                           | `v4/attachment/commit`, uploaded for the target session                                                                                                 |
| Edit of an existing row (any origin)                      | the row's projected refs: local paths, own-session or fork-parent artifacts | `ConversationRowView` omits an untouched list; after a removal it sends the remaining list                                                              |

So only the desktop renderer legitimately sends local paths. A web-remote client never has a Host
path of its own; without a boundary it could name any Host file and have either agent read it into
the model context.

## Rule

The Host decides admission. The decision runs in
`sendConversationCommandV4` (`packages/services/src/zcode-agent/zcodeAgentService.ts`) on the Host
that spawns the agent, after the trusted `clientMode` is known and before any side effect (provider
sync, reservations, forwarding). Neither agent runtime repeats it; the Rust agent is covered because
it is spawned behind the same Host command path.

Origin is the Host-trusted connection mode, never a payload field:
`web-remote-replayable` → `mobile`, otherwise `desktop` (the same derivation that stamps
`inputOrigin`). A trusted relay forwards the downstream connection's mode.

1. Desktop origin: every ref is admitted. The desktop renderer is the user's own UI with full file
   access; fork-copied rows legitimately reference parent-session artifacts.
2. Mobile origin: every `ref` and `previewRef` must be an artifact URI of the command's own session:
   - exactly `zcode-artifact://` + `encodeURIComponent(envelope.sessionId)` + `/` + id;
   - id matches `[A-Za-z0-9._~-]+`, is not `.` or `..`, and has no query or fragment;
   - the session id is path-safe (`[A-Za-z0-9._-]{1,120}`). Both artifact stores map a session id
     to a directory by replacing other characters with `_` and cutting at 120 (Node
     `sanitizePathSegment`, Rust `segment`), so an unsafe id such as `ses/1` would share the
     directory of `ses_1`. Generated ids (`sess_<uuid>`, `session_<hex>`) are always path-safe;
     both stores keep the session segment's case.
   - a command without `sessionId` admits no mobile ref (a mobile `createSession` sends attachments
     with the first `sendText` after the session exists).
     Local paths, other schemes, other sessions (including `share`) and malformed URIs are refused.
3. A refused command throws `fault.attachment.refNotAuthorized` before reaching the agent. Nothing is
   partially admitted. Logs carry the command type and the reason kind only, never the ref.

Gated fields: `sendText.attachments`, `createSession.firstInput.attachments`,
`editUserQuery.attachments` (both `ref` and `previewRef`).

The error code and the edit-list rule are owned by the shared module
`@zcode/shared/fork-attachment-ref-trust` (`ATTACHMENT_REF_NOT_AUTHORIZED`,
`isAttachmentRefNotAuthorizedError`, `editAttachmentsToSubmit`), so the renderer uses them without
importing services.

## Editing a message

`editUserQuery.attachments` absent means "keep the edited message's canonical attachments"; an
explicit `[]` removes them all. The Node agent resolves an absent field to the canonical intent's refs
(`payload.attachments ?? stableAttachmentRefs(editTarget)` in `fork-edit-retry.ts`), read from its
own store, not from the client. The Rust agent (`zcode-rs`) does not implement `editUserQuery` yet
(it answers `unsupported`), so it has no attachment semantics to keep.

1. The inline edit view (`ConversationRowView` via `editAttachmentsToSubmit`) omits `attachments`
   when the list is unchanged (same refs in the same order). The edit view can only remove items, so
   any change is a removal and the remaining list is sent in full.
2. An unchanged mobile edit therefore carries no ref and passes the gate, whatever the row holds
   (desktop local paths, fork-parent artifacts). The gate itself is not relaxed for edits: the Host
   cannot see canonical rows, and admitting refs "already on the row" would trust the client.
3. A mobile edit that removes some attachments still resends the rest. If any of them is not an
   own-session artifact, the Host refuses the command; `SessionPane.handleEdit` catches the code and
   shows `chat.edit.attachmentRefNotAuthorized` (a warning toast) instead of failing silently. The
   edit stays open.

## Known limits

- Not covered yet: the legacy `session/send` surface. `ZCodePromptAttachment.localPath` reaches
  the agent through `IZCodeAgentService.sendPrompt` (the connection-scope facade passes it through
  with no trusted carrier) and through `IZCodeTaskService.sendPrompt` / `createTask` (mobile
  allowlisted; the task adapter falls back to `session/send` whenever attachments are present).
  Mobile legitimately uses that path with `dataBase64`, so the follow-up rule is "a web-remote
  origin may not send `localPath`", enforced where each surface is exposed to a web-remote
  attachment (desktop Host attachment and `packages/server` `/ws`).
- A mobile edit that removes some attachments of a row that also holds desktop local paths or
  fork-parent artifacts is refused (see "Editing a message", rule 3). Supporting it needs an
  agent-side "keep these canonical attachments by index" field, which is a protocol change.
- Canonical refs are not re-checked. A mobile `editUserQuery` without `attachments` (and a mobile
  `retryTurn`) replays the target message's stored attachments, which may include a desktop local
  path. The phone cannot choose that path: it is a file the desktop user attached to this session,
  so the agent reads the same file again (its current contents). The Host cannot see canonical rows;
  closing this needs the agent to refuse local-path replay for a mobile `inputOrigin`.
- The check reads `params.envelope` before the first `await`, and later stages read it again. A
  web-remote envelope is a deserialized object that no other code holds, so only trusted in-process
  Host code could mutate it in between; that is outside this boundary's threat model.
- A paired phone also has the Host `File` and `Terminal` channels
  (`windowHostAttachmentRpcPolicy.ts`). This rule closes the agent-read path only; it does not make
  the phone a least-privilege client.
- Desktop admission trusts the renderer for any path. Restricting desktop refs to picker-registered
  paths needs a renderer→Host registration contract (local zero-copy never calls the transfer
  service today) and is a follow-up that needs product alignment.

## Acceptance

- A mobile-origin `sendText` with a local path ref is refused with
  `fault.attachment.refNotAuthorized` and does not reach the agent.
- A mobile-origin ref `zcode-artifact://<other session>/<id>` is refused.
- A mobile-origin `previewRef` that is a local path is refused.
- A mobile-origin artifact ref of the command's own session is admitted.
- A mobile-origin artifact ref of a session id that is not path-safe is refused.
- A desktop-origin local path (picker) is admitted.
- An unchanged inline edit sends no `attachments`; a removal sends the remaining list; removing all
  sends `[]`.
- A refused edit shows the warning toast instead of failing silently.

Tests (fork manifest): `packages/services/test/forkAttachmentRefTrust.test.ts`,
`packages/shared/src/fork-attachment-ref-trust/contract.test.ts`.
The toast wiring in `SessionPane` has no automated test.
