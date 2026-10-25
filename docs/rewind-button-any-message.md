# Message-level rewind entry removal

## Current state

The message-level "撤销" entry in the chat message card footer is removed and no longer shows under user or assistant messages. V4 has no conversation cascade rewind command.

This removal covers the chat message-level cascade rewind entry only; it does not affect file-level undo in the file change summary. The V4 file change summary panel (`ConversationFileSummaryPanel`) offers only "撤销": after undo it shows the "已撤销" marker and disables the undo button, with no "重新应用" (matching the upstream V4 panel; the old `MessageChangeSummaryPanel` "撤销 / 重新应用" toggle no longer applies).

## Constraints

- V4 `ConversationRowView` provides no conversation rewind action.
- The standalone `session/rewind` / `session/rewindCascade` commands are deleted from the protocol and call chains.
- Editing history uses `editUserQuery`; retrying uses `retryTurn`.
- File state rollback uses `applyFileRewind`, which never implicitly truncates chat history.

## Verification focus

- Message actions expose only what the current row projection allows: copy, edit, retry, fork, and similar.
- The file change summary panel offers file-level undo only: after undo the files are restored, the panel shows "已撤销" and the undo button is disabled; there is no "重新应用" entry (ISSUE-041 decision: undo only).
- Mobile remote control adds no replayable rewind entry.
