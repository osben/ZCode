# fork-attachment-ref-trust-shared

Browser-safe half of the attachment ref trust boundary
(`specs/fork-attachment-ref-trust-boundary.md`). The Host admission lives in the services module
`fork-attachment-ref-trust`; this module only holds what the Host and the renderer must agree on.

- `ATTACHMENT_REF_NOT_AUTHORIZED`: the refusal code the Host throws.
- `isAttachmentRefNotAuthorizedError`: matches that code in an error bridged over IPC or RPC.
- `editAttachmentsToSubmit`: an untouched inline-edit list is omitted (the agent keeps the canonical
  attachments); a changed list is sent in full; an explicit `[]` removes all.

Pure: no IO, state or dependencies.
