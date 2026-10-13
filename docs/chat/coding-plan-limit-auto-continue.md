# Coding Plan 5-hour limit auto-continue

## Scope

When a Z.AI or BigModel Coding Plan conversation ends with provider business code `1308` and the message `Usage limit reached for 5 hour. Your limit will reset at YYYY-MM-DD HH:mm:ss`, the quota banner can automatically resume the same session after the reset. This does not apply to Start Plan or unrelated provider errors.

The banner checkbox is checked by default. Settings / General has a global default switch; changing it affects newly shown limit banners, while the current banner keeps its own checkbox state. The banner may render before an initial settings snapshot exists, but its checkbox is disabled and its timer is not armed until a snapshot is available. A settings refresh keeps the existing snapshot ready; an initial read failure keeps auto-continue disabled. The checkbox initializes once from the persisted default. Unchecking the banner cancels its pending auto-continue.

Auto-continue waits until the parsed reset time, then adds a random delay from 1 to 3 minutes and sends the existing `Continue from where you left off` input through the current session command path. It does not replay the failed turn or alter retry policy. If the timestamp is missing or malformed, show the existing provider message and do not schedule a continuation.

## Time interpretation

The provider message has no UTC offset. The user compared `2026-10-13 10:16:31` with a reset 16 minutes after 19:00 on October 12 in Los Angeles. On that date Los Angeles observes PDT (UTC-7), so the provider timestamp corresponds to UTC+8. Parse this exact provider message as UTC+08:00, then display the resulting instant in the device's local timezone, including its timezone abbreviation. Do not let JavaScript interpret the zone-less string in the device timezone.

## State and event order

```text
provider error 1308 + supported Coding Plan provider
  -> parse reset instant as UTC+08:00
  -> show quota banner with timer disabled until an AppSettings snapshot exists
  -> initialize its checkbox from the snapshot once
  -> checked: wait until reset instant + random 1-3 minute grace
  -> invoke existing session resume command once for this error key
  -> accepted next turn clears the error and removes the banner/timer
```

The checkbox draft belongs to the visible quota banner. The global default belongs to `AppSettings` in `setting.json`. The active session remains the authority for command admission. Dismissing the banner, changing its error/session, or unchecking the box cancels that banner's timer. No timer survives renderer teardown or app restart in this version.

## Accepted cases

| ID       | Setup                                                                | Action                                    | Assertions                                                                                         |
| -------- | -------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| CPLAC-01 | Coding Plan provider, code 1308, supported 5-hour reset message      | View banner                               | Reset instant is parsed at UTC+08:00, rendered in local timezone, checkbox follows General default |
| CPLAC-02 | Same error, checkbox checked                                         | Advance clock past reset plus 1-3 minutes | One existing continuation input is sent to the same session                                        |
| CPLAC-03 | Same error, checkbox unchecked                                       | Advance clock past reset                  | No continuation is sent                                                                            |
| CPLAC-04 | Malformed/missing reset timestamp, Start Plan, or non-1308 error     | View banner/advance clock                 | No auto-continue is scheduled; existing error behavior remains                                     |
| CPLAC-05 | Pending timer, then dismiss/change error or session                  | Advance clock                             | Stale timer does not resume the old session                                                        |
| CPLAC-06 | Saved default is disabled and settings are still loading             | Mount banner, then resolve settings       | Timer stays unarmed while loading; checkbox initializes unchecked after load                       |
| CPLAC-07 | Settings snapshot exists and a refresh starts, or initial read fails | Keep banner mounted                       | Refresh does not reset the grace period; initial failure does not enable auto-continue             |

## Implementation boundaries

- Reuse `handleResumeError` and `CHAT_ERROR_RESUME_MESSAGE`; do not replay the failed turn.
- Limit eligibility to Z.AI/BigModel Individual Coding Plan provider identities and code `1308`.
- Do not write reset data to session/runtime state or call provider quota APIs.
- Settings switch changes only the default for newly mounted banners.
