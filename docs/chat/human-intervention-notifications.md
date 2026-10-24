# Human Intervention Notifications

When a ZCode task runs in the background and reaches a state that needs the user, desktop notifications must cover it so the task does not sit waiting for confirmation.

## Scope

Events that trigger a notification:

- `permission_request`: ordinary tool permission confirmation.
- `elicitation_request`: user input/choice confirmation, including `AskUserQuestion`, `ExitPlanMode` plan confirmation, and generic Q&A mapped from the protocol-level `interaction/requestUserInput`.

Events that do not trigger a notification:

- `task_complete` / `task_error`: they already have their own completion/failure notifications.
- `turn_steer_queued`, `runtime.pendingCommands`, queued prompts: future input or host queue, not the current task waiting for confirmation.
- `apiRetry` / provider retry: automatic retry state, no user action.
- `backgroundBashJobs`: background command runtime state, not a block on user input.
- `providerRuntimeHeaders.request`: current product semantics refresh the runtime header automatically before a model request; whether the interaction in the official-build security check needs a system notification is decided separately.

## Notification boundary

- When the live stream receives `permission_request` or `elicitation_request`, the renderer sends a localized notification through `IPlatformService.showTaskNotification`.
- Clicking a notification only activates the task's workspace/task; it does not open or submit the dialog.
- Dedupe key is `taskId + status + requestId`. The same request never fires twice; permission and elicitation use different `status` values for troubleshooting and future statistics.
- `pendingElicitations` restored from a `web-remote-replayable` snapshot restore UI state only and do not re-send system notifications, so reconnect recovery does not re-notify old blocking requests.
- Desktop `desktop-continuous` keeps consuming only live events and does not take on replayable recovery semantics.

## UI list semantics

The task list's "waiting for confirmation" badge means the task has a human-intervention blocking request (permission or elicitation). It does not light the unread blue dot; unread still means only an unviewed background terminal state or content update.

## Acceptance

- Foreground/background `permission_request` keeps sending the `permission_request` notification.
- Foreground/background `elicitation_request` sends the `elicitation_request` notification.
- AskUserQuestion and ExitPlanMode share the notification path through `elicitation_request`.
- Normal and grouped task list views show "waiting for confirmation" when an elicitation exists.
- Replayable snapshot recovery of `pendingElicitations` triggers no extra system notification.
