# Retry Turn (current state)

The Retry entry sits in the assistant turn actions and sends the V4 `retryTurn { target: { rowId, entityId } }`; the envelope also carries `baseRevision/baseLogEpoch`. The unified CLI resolver resolves the canonical input intent, decides the CAS and generates the new authoritative turn; the UI does not perform the old rewind + resend combination.

The user row itself provides edit/copy. Editing uses `editUserQuery`, a different command with different product semantics from retry.
