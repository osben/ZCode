# fork-attachment-ref-trust

Host-side admission of `AttachmentRef.ref` and `previewRef` for v4 commands
(`specs/fork-attachment-ref-trust-boundary.md`). `sendConversationCommandV4` calls it once, on the
Host that spawns the agent, before any side effect; neither agent runtime repeats it.

Invariants:

- Origin comes from the Host-trusted connection mode, never from the payload.
- Desktop origin admits every ref.
- Mobile origin admits only `zcode-artifact://<encoded envelope.sessionId>/<id>`; everything else is
  refused with `fault.attachment.refNotAuthorized`.
- Pure and synchronous: no IO, no logging of ref values.
