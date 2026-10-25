# Desktop Renderer User Action Trace

## Status

- Implementation spec of the Electron Desktop Renderer user-semantic action Trace.
- Adds only the `ui_action` Span; Web, mobile, Host, CLI, RPC and ZCode Protocol are not wired in.
- `/event/report` keeps its current events, fields and counts and does not reuse this Catalog.

## Architecture

```text
user action
  -> Renderer Feature Catalog
  -> Renderer creates/ends ui_action
  -> Renderer bounded batching
  -> Main transparent Broker
  -> OTLP
```

Main only distributes the canary config, validates batches and exports with its own credentials. Main
never creates, ends, resamples, rewrites or reparents Spans; Host/CLI receive no Trace Context.

## Catalog

### Core: 25 leaf features

| feature_id                         | action                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `workspace.local.lifecycle`        | `open` / `switch` / `close`                                                                                         |
| `workspace.remote.lifecycle`       | `open_dialog` / `connect` / `reconnect` / `disconnect`                                                              |
| `workspace.project_binding`        | `attach` / `detach` / `work_outside_project`                                                                        |
| `task.lifecycle`                   | `create` / `open` / `archive` / `rename` / `delete`                                                                 |
| `task.layout`                      | `open_split` / `split_right` / `split_down` / `close_pane`                                                          |
| `conversation.composer.message`    | `send` / `stop`                                                                                                     |
| `conversation.composer.attachment` | `add` / `remove` / `retry_upload`                                                                                   |
| `conversation.composer.config`     | `change_model` / `change_thought_level` / `change_mode`                                                             |
| `conversation.queue.item`          | `send_now` / `edit` / `remove` / `reorder`                                                                          |
| `conversation.queue.policy`        | `resume` / `toggle_auto_drain` / `toggle_followup` / `clear_and_send` / `keep_and_send`                             |
| `conversation.history.branch`      | `retry` / `edit` / `fork` / `rewind_files`                                                                          |
| `conversation.history.feedback`    | `like` / `dislike` / `clear_feedback` / `copy`                                                                      |
| `conversation.blocking.user_input` | `select_option` / `submit_text` / `cancel`                                                                          |
| `conversation.blocking.hook`       | `review` / `dismiss`                                                                                                |
| `conversation.navigation`          | `load_older` / `jump_bottom` / `open_turn`                                                                          |
| `conversation.subagent`            | `expand` / `open_side_pane` / `open_split`                                                                          |
| `conversation.background_work`     | `open` / `cancel`                                                                                                   |
| `workbench.file`                   | `open_tree` / `refresh` / `open_file` / `open_preview`                                                              |
| `workbench.terminal`               | `open` / `close`                                                                                                    |
| `workbench.browser`                | `open` / `navigate` / `back` / `forward` / `refresh` / `open_external`                                              |
| `workbench.git`                    | `open` / `commit` / `generate_commit_message` / `run_action`                                                        |
| `extension.plugin`                 | `open_store` / `search` / `open_detail` / `install` / `enable` / `disable` / `update` / `uninstall` / `save_config` |
| `extension.mcp`                    | `authorize` / `refresh` / `enable` / `disable`                                                                      |
| `automation.lifecycle`             | `create` / `update` / `run_now` / `enable` / `disable` / `pause` / `resume` / `delete`                              |

### Settings: 17 leaf features

| feature_id               | action                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings.navigation`    | `open_section` / `back_to_workspace` / `open_onboarding`                                                                                                                       |
| `settings.locale`        | `change_locale`                                                                                                                                                                |
| `settings.appearance`    | `change_theme` / `change_ui_font_size` / `change_code_light_theme` / `change_code_dark_theme` / `toggle_code_line_numbers` / `toggle_code_line_wrap` / `change_code_font_size` |
| `settings.terminal`      | `toggle_system_profile` / `save_font_family` / `change_shell`                                                                                                                  |
| `settings.search`        | `toggle_native_search`                                                                                                                                                         |
| `settings.network`       | `save_http_proxy` / `save_no_proxy` / `save_ca_certificate`                                                                                                                    |
| `settings.desktop`       | `toggle_hardware_acceleration` / `toggle_close_to_tray` / `toggle_keep_awake`                                                                                                  |
| `settings.update`        | `toggle_preview_updates` / `toggle_auto_update`                                                                                                                                |
| `settings.notification`  | `toggle_notification` / `toggle_notification_sound`                                                                                                                            |
| `settings.conversation`  | `change_interaction_behavior` / `toggle_ask_user_auto_resolution` / `toggle_model_io_retention` / `toggle_show_reasoning` / `toggle_show_todos`                                |
| `settings.tool_grouping` | `toggle_explore_grouping` / `toggle_terminal_grouping` / `toggle_changes_grouping`                                                                                             |
| `settings.task`          | `toggle_auto_archive` / `change_auto_archive_days`                                                                                                                             |
| `settings.storage`       | `change_data_directory`                                                                                                                                                        |
| `settings.memory`        | `toggle_memory` / `refresh_memory` / `change_memory_scope`                                                                                                                     |
| `settings.browser`       | `toggle_browser_use` / `import_browser_data` / `toggle_insecure_certificates` / `clear_cache` / `clear_all_data`                                                               |

`toggle_*` expresses the target value via `state_after=enabled|disabled`; `change_*` allows only
low-cardinality enums; `save_*` starts only on explicit submit. `toggle_memory` does not delete existing
Memory.

## Lifecycle and fields

An action starts when local validation passes and a real semantic side effect is about to happen.
Navigation ends once the target view is committed; settings end once the preference or service write
succeeds; Commands complete only when the Renderer receives the `accepted` ACK. Confirm-type actions
start from the final confirmation; timeout or unmount ends as `abandoned`. Telemetry exceptions must not
change the business result.

Fixed outcome: `completed` / `failed` / `rejected` / `cancelled` / `noop` / `abandoned`. Fixed result
source: `local_commit` / `shared_settings` / `setting_service` / `platform_result` / `authority_ack` /
`optimistic_projection`.

Span Name is fixed `ui_action`, service.name fixed `zcode-desktop-renderer`. Allowed fields: Catalog
identifiers, surface/trigger, result, controlled state, workspace/remote type and action_id. Forbidden:
prompt, reply, file content, paths, workspaceIdentity, remoteSessionId, proxy address, certificate path,
font name, Cookie, browsing history, Model I/O, full error and stack.

## Canary, batching and failure contract

`/api/v1/client/configs` delivers `data.configs.rendererActionTrace`:

```json
{
  "enabled": true,
  "sampleRatio": 0.05,
  "enabledGroups": ["core", "settings"],
  "configVersion": "2026-08-25-v1"
}
```

1. Off by default in production; a missing config, first timeout, parse failure or invalid config
   collects nothing.
2. Production sampleRatio is limited to 0..0.20; development/automated tests use 1.0 explicitly.
3. Unknown groups are ignored; config updates affect only new Spans.
4. Renderer queue 256; batch 32 items / 256 KiB; triggered at 2 seconds or a full batch.
5. Main ingress 32 batches; OTLP timeout 3 seconds, at most one retry.
6. A full queue, invalid DTO or export failure only drops telemetry and never back-pressures the business.

## Acceptance

- Catalog feature/action unique and complete.
- `/event/report` calls and payloads unchanged.
- Host/CLI/RPC/Protocol unchanged.
- Web/mobile do not initialize or send batches.
- Main preserves the Renderer-generated traceId/spanId/time/Resource/Attribute.
- No sensitive fields; no new 50 ms Long Task; Renderer Heap increase at most 10 MB; batch IPC P95 under 5 ms.
