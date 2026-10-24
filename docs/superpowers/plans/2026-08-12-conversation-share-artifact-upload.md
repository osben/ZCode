# Conversation Share — Result Artifact Upload Contract

Shipped (2026-08-12). Implementation and tests:
`packages/services/src/conversation-share/conversationShareArtifactSource.ts`,
`conversationShareService.ts`, `conversationSharePublicProjection.ts` and their test files.

## Row protocol

- The formal V4 row protocol carries an artifact row projected from completed tool attachments.
  Text-only paths stay unrecognized.
- The public projection replaces local artifact identity/refs with stable public IDs and returns
  upload source metadata beside the public rows.

## Upload pipeline

- Only artifact rows in selected turns are materialized, through an injected async local file
  source. File IO is asynchronous, validates canonical realpath containment inside the workspace,
  and reads in bounded chunks.
- Capabilities and file integrity are validated; a preparation is created with the exact artifact
  count.
- Multipart descriptors/files are uploaded in deterministic order; all artifacts are uploaded
  before confirm, and the public projection confirmed afterwards is unchanged.
- Failure before confirm (selection, capability, integrity, upload) must not confirm: no confirm is
  sent on upload failure, and upload responses are verified.
