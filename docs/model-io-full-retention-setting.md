# ModelIO Full Retention Setting

## Status

- Defines the product and implementation boundary of the ModelIO full-retention switch in Settings.
- App-global diagnostic preference; not part of conversation/session recovery state.
- Default off; historical `setting.json` without the field is treated as off.

## User semantics

Settings / General provides the "完整保留模型 I/O" (full model I/O retention) switch:

- Off: bounded mode. Production keeps at most 3 session files and resets a session after 64 MiB;
  dev resets after 256 MiB; request messages use `full` / `delta` / `tail` compaction with
  production duplicate large-field pruning.
- On: from the next model attempt, write complete records — no session-file eviction, no per-session
  size reset, no `delta` / `tail`, no production field pruning.
- Toggling does not rewrite, recover or delete existing records. Turning it back off resumes the
  bounded policy from the next write.
- On, prompt, tool input/result and model output are kept fully; the switch changes only retention
  policy, never security redaction boundaries.
- Header and Anthropic request metadata credential redaction is a security boundary that cannot be
  turned off in any mode.

## State and sync chain

```text
Settings Switch
  |
  | ISettingService.update({ modelIoFullRetentionEnabled })
  v
~/.zcode/v2/setting.json                    authoritative app preference
  |
  +--> current Local Host ------------------+
  |                                         |
  +--> active Remote/Bot Host --------------+ App runtime preference sync
                                            |
                                            v
                              workspace/updateModelIoPreferences
                                            |
                                            v
                              workspace-scoped zcode-cli process
                                            |
                          +-----------------+-----------------+
                          |                                   |
                    resident apps                      future apps
                    update adapter                     inherit snapshot
                          |                                   |
                          +-----------------+-----------------+
                                            v
                                  ModelIO write boundary
```

Sync constraints:

- Local, SSH, WSL, Docker and server remote all use the desktop app's single global preference; a
  remote workspace never reads its own remote `setting.json` as authoritative.
- The Host caches the latest preference and re-sends it to newly created or restarted workspace CLIs
  before allowing session work.
- Old CLIs answer the new protocol method with method-not-found: the setting still persists, the old
  CLI stays bounded; AskUserQuestion preference sync must not be affected.
- Mobile `/remote` attaches to the existing Host/CLI: no new runtime, no change to
  `desktop-continuous` / `web-remote-replayable` delivery semantics.

## Writer behavior

```text
write model_io record
  |
  v
sanitize headers / request metadata       always
  |
  +-- fullRetention = true --> append complete sanitized record
  |
  `-- fullRetention = false
         |
         +--> production duplicate-field pruning
         +--> full / delta / tail compaction
         +--> session-count rotation
         `--> per-session size reset
```

The switch value is snapshotted when a model attempt starts. A mid-request toggle leaves the
current attempt on its start-time mode; the next attempt picks up the new mode. A record never
mixes semantics.

## Owners

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache |
| --- | --- | --- | --- | --- |
| User choice | Settings React snapshot | `ISettingService` | `update()` | `setting.json` |
| Active CLI preference | Host latest preference snapshot | workspace CLI protocol context | `workspace/updateModelIoPreferences` | process memory only |
| Per-write mode | `AiSdkModelAdapter` | adapter attempt snapshot | runner input | none |

Single UI entry: `GeneralSectionContent` + `Switch` via `useSettings`; all workspaces read the app
global default (`false`) from `appSettingsSchema`. Standalone CLIs have no UI and stay `false`.

## Invariants

- Default off preserves old bounded behavior exactly (rotation/size/delta tests keep passing).
- Credential redaction always on, in full and bounded modes.
- Dormant workspaces are never started; runtime preference sync targets active clients only.
- No change to desktop/mobile delivery (`desktop-continuous` / `web-remote-replayable`); no new
  conversation E2E — schema/UI/protocol/adapter tests cover the boundary.
- Out of scope: conversation content, task snapshot, queue, stream replay, ModelIO read UI, log
  export policy.

## Acceptance cases

| Case ID | Setup | Action | Assertions |
| --- | --- | --- | --- |
| MIO-FR-01 | empty historical settings | load settings | switch/default is false |
| MIO-FR-02 | bounded production writer | write multiple sessions and growing context | max 3 files; delta/tail and size reset unchanged |
| MIO-FR-03 | full retention enabled | write multiple sessions and repeated context | all files remain; each record is full; production duplicate fields remain |
| MIO-FR-04 | full retention enabled with oversized session file | append next record | existing file is not reset and no `modelIOReset` marker is emitted |
| MIO-FR-05 | active local/remote services | toggle switch | setting persists, active Host ACKs, cross-window payload includes full snapshot |
| MIO-FR-06 | full retention record contains credentials in headers | write record | sensitive headers remain `[redacted]` |

Case pruning: the writer mode does not read/write session phase, queue or delivery kind (no
conversation coupling); the retention branch is provider-neutral after record construction (one
generate/stream representative suffices); the switch is a standard SettingsRow/Switch with no new
layout primitive (bilingual copy + component render test only).
