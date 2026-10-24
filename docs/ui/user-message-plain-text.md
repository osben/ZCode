# User Message Row (Current Facts)

The V4 user row presents plain text/attachments and offers copy and a real inline edit. Edit submits
`editUserQuery { target: { rowId, entityId }, newText, attachments, workspaceMode }`; the envelope also
carries `baseRevision/baseLogEpoch`, and the CLI decides by the projection-authoritative `actions.canEdit`.
The editor fixedly offers "Cancel / file-reset icon / Send": the middle action uses the `FileClock` icon,
the same size as the send button with outline color, and hover/focus shows "与文件一起重置" (Reset together
with files). In the disabled state, a hover trigger wrapping the icon button receives pointer events and
shows the specific disabled reason, while the real button stays disabled. Ordinary send uses
`workspaceMode=preserve`; combined reset uses `workspaceMode=rewind`, and on conflict shows the file list
and allows downgrading to preserve. Cancelling the edit only restores the local edit state.

Retry is not on the user row: it is an assistant turn action and sends `retryTurn`.
