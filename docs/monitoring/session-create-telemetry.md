# Session creation business telemetry

## Definition

`session_create` counts, via `/api/v1/event/report`, formal sessions that a user draft or automation actually
creates and whose first input is accepted. A Group / Project click only determines the source; typing directly in
the default empty state has source `session`. Warm-up `createSession`, repeated new clicks, unsent drafts, opening
history, later turns, fork, subagent and automation reusing an existing session are not counted. It is reported
after the first ordinary input or a valid Goal command is accepted; failures are not reported. Automation counts
only when a session is actually created and its first sendPrompt is accepted, without waiting for
message_completion.

```text
Group / Project / default Session empty state
    -> draft source (frozen before the first send)
    -> warm-up session or fallback createSession
    -> first input accepted
    -> session_create (de-duplicated by workspace identity + session)

Desktop IPlatformService -> IPC -> TelemetryCore -> /event/report
Mobile  IPlatformService -> paired relay app payload -> Desktop Main -> TelemetryCore
Automation Host creation + first-send accepted -> strict telemetry message -> Desktop Main -> TelemetryCore
```

The event is fixed to `element_name=session_create`, `event_region=app`, `event_type=result`. The top-level
`talk_id` is the created session ID; `message_id` is required and is the command ID of the first accepted input,
equal to the `message_id` of that turn's message_completion. Common user/device/version/marketing fields follow
TelemetryCore.

| event_extra_detail field | Value |
| --- | --- |
| create_source | `group` / `project` / `session` / `automation_idle` / `automation_scheduled` |
| client_kind | `desktop` / `mobile` / `web`; mobile means the Web remote-control entry, devices are not guessed from the UA |
| workspace_kind | `local` / `remote` |
| remote_kind | `ssh` / `wsl` / `docker` / `server` / empty string |

The workspace kind reuses conversation telemetry: a non-empty identity or remoteSessionId means remote;
remote_kind is extracted by `parseRemoteWorkspaceIdentity`, and an unknown identity stays remote. Identity
isolation uses `workspaceIdentity?.trim() || workspacePath`; no path, raw identity or remote address is reported.

The sidebar Project is currently a workspace grouping with no independently persisted project ID. The CLI session
table does have `project_id`, but `projectIdFromDirectory` merely lowercases the directory, replaces symbols and
truncates to 80 characters: it is not an opaque ID, does not distinguish remote hosts with the same path and may
collide. The V4 create ACK does not expose it. The Tab ID is a UI identity and the Coding Plan projectId is a
billing project; neither is used for this field. No project_id is added or forged; project-level statistics first
need a stable cross-end, remote-isolated identity contract.

## Automation and idempotency contract

- create_source adds `automation_idle` / `automation_scheduled`. For off-peak only `init` counts, while
  `bound-first-run` / `resume` do not; for scheduled tasks only the branch with no `targetTaskId` that actually
  calls createTask counts. Appending a message to the original session of a scheduled task whose prompt created and
  bound that session does not count.
- Automation trigger attribution is decided by the current Host dispatch function; after sendPrompt is accepted a
  strict Host → Main event is forwarded. Main only validates/forwards and keeps no Session state; the UI does not
  back-report from subscriptions.
- Automation `client_kind` is desktop (the executing host) and does not infer on which device the task
  configuration was first created. The Host context uses the runtime timezone/locale and leaves screenResolution
  empty rather than forging a screen size.
- TelemetryCore generates for session_create a UUIDv8-format event_id from the first 128 bits of the SHA-256 over
  `[version namespace, user_id, talk_id]`. The Session ID itself is a globally unique UUID; source/device do not
  take part in the key, so the same user and Session keep the same ID across reports, retries and Core rebuilds.
  Other events still use random UUIDs.
- event_id serves server-side idempotent consumption; this repo contains no production-receiver de-duplication, so
  end-to-end exactly-once is not claimed. Network failures reuse the existing bounded retry and no persistent send
  queue is introduced. Reporting happens right after accepted and does not depend on a completion event; message_id
  uses the first-send input command identity, already available at accepted, not the Assistant row ID.
- No change to scheduling, owner/lease, CLI admission or the desktop continuous / mobile replayable recovery
  boundaries.
- Tests: the real dispatch function covers off-peak init/bind/resume, cron create/bind-to-original-session, first
  send rejected/pending; Host schema/message forwarding, event_id retry and multi-instance stability; a desktop E2E
  verifies the final event_id.

## Boundary

The sole fact source of message_id is the input command: a UI ordinary/warm-up/Goal first send uses the accepted
`ACK.commandId`, and createSession(firstInput) uses the `ACK.commandId` of that create command; when a first send
follows an empty createSession, the commandId of sendText/Goal is used and the empty create command must not be
used by mistake. A user-confirmed recovery resend uses the new ACK's commandId. Automation uses the traceId of the
actual sendPrompt (runId for cron, task.traceId for off-peak init). The strict forwarding schemas of mobile and
Host both require a non-empty messageId; no second ID scheme is added and nothing is looked up back from the
completion message. event_id is still idempotent only by user and Session; message_id is not added to the
idempotency key of the creation event.

```text
first command ID -> accepted ACK -> session_create.message_id
          \-> later completion fact -> message_completion.message_id (same value)
```

A user draft is reported by the originating UI and an automation creation by the dispatching Host; Desktop does
not back-report from the mobile/desktop subscription stream. Mobile only passes through this event's strict schema
and does not enable the other desktop-only conversation events. Main keeps no session, queue, owner or
de-duplication business state and uses the existing paired connection and TelemetryCore. The command, snapshot and
recovery behavior of Desktop continuous and Mobile replayable is unchanged, and workspaceIdentity/remoteSessionId
keep travelling along the original attachment.

De-duplication keeps the latest 4096 workspace/session combinations of the current Renderer, covering repeated
creation callbacks and multiple panes; exactly-once across a crash or a lost ACK on disconnect is not claimed.
Telemetry is a side channel: it does not block navigation or sending and a report failure does not become a
creation failure.

## Verification

- Unit tests: the three sources; local/SSH/WSL/Docker/server/unknown identity; mobile+SSH; repeated callbacks of
  the same session report once, same path with different remote identities are isolated; no project_id/path leak.
- Unit tests: setting/relocating the draft source; the mobile schema rejects other events/extra fields; Host
  forwarding.
- Pending E2E: warm-up produces zero events, the first send produces one with talk_id, follow-ups and reopening
  history add none; Group/Project sources are verified from the real UI creation entries.
- `pnpm typecheck`, `pnpm lint`, `pnpm --filter @zcode/desktop typecheck:e2e`.

### Verification record

- macOS Electron + case-local model replay passed: the final `/event/report` bodies for the Project / Group /
  direct-first-send-after-refresh entries, zero reports during warm-up, no duplicates for follow-ups and history
  reopening. Run: `desktop-e2e-20260915062832206-p33122-e75382b73612e1b7`.
- Repo-wide typecheck, E2E typecheck, lint (0 errors) and architecture check pass.
- 8 related unit-test files, 173 tests passed, including Goal accepted/rejected and report-failure isolation.
- The mobile strict schema and Desktop Main forwarding are covered by unit tests; mobile real devices,
  SSH/WSL/Docker real machines and Windows/Linux UI are not accepted and do not count as cross-platform E2E.
- The repo-wide conversation coverage audit failed: the baseline already had D19/I74/I75 reference errors and
  stale statistics and generated documents; this change's pending fixture metadata has 0 rejected.
- The E2E stays pending, without manual review / promotion.

Automation and event_id verification: 11 related unit-test files / 137 tests passed; repo-wide typecheck, E2E
typecheck, lint (43 pre-existing warnings, 0 errors) and architecture:check (0 violations) pass. The three-entry
creation and final UUIDv8 event_id E2E passed (creation-event case of
`desktop-e2e-20260915070847887-p40115-4254803e37acd6f0`). The full Host → Main → `/event/report` chain E2E of
creating a scheduled task in the UI and running it right away passed
(`desktop-e2e-20260915071458180-p44110-b9e884f38651cbd9`), asserting source automation_scheduled, talk_id and the
stable event_id; both cases' fixture checks pass. Off-peak init/bind/resume, cron targetTaskId append and first-send
failure/wait are verified by isolated tests of the production dispatch function and are not counted as off-peak/
remote/mobile real-machine E2E. Production-receiver event_id de-duplication is unverified. Repo-wide typecheck emits
the Host build output and must not run in parallel with Electron packaging/running; the final automated E2E was
rebuilt and run after typecheck finished. The account mock is explicitly isolated and the form explicitly selects
the case replay model.

message_id verification: 8 related unit-test files / 110 tests passed, covering ordinary/warm-up/Goal, send after
an empty create, confirmed recovery resend, off-peak/scheduled first-send IDs, the mobile/Host required schema and
forwarding; event_id does not change with message_id. The three-entry E2E passed
(`desktop-e2e-20260915072807214-p50394-fa16c0175fef4bc5`), confirming round by round that the creation and
completion events have equal message_id (the Group correlation assertion finishes before refresh so an unfinished
async report at refresh is not misjudged as an ID mismatch). The scheduled-task E2E passed (automation-run-title-stable
case of `desktop-e2e-20260915072551534-p48619-f5fdee3f954ae066`), and the two final HTTP events' message_id equal
runId. Repo-wide typecheck, E2E typecheck, lint (43 warnings, 0 errors) and architecture check pass; both fixture
checks pass. Mobile and remote real-machine verification stays as above and no new real-machine coverage is
claimed.
