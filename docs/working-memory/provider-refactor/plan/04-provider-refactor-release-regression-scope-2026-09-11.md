# Model Provider Refactor Release Regression Scope (2026-09-11)

> Status: Pending execution. Reference: old staging (`staging_backup @ 790884b1ce`) → current staging (`b8499d8b2a`).

This refactor has not gone live. This is the cumulative release regression scope for the entire refactor, not an incremental list for the latest batch: all checks from the [previous regression scope](./03-provider-refactor-release-regression-scope.md) remain in effect, plus changes from the old staging and concurrently merged features. Existing development or test records never justify reducing scope. The list circumscribes product functions and key scenarios only — no detailed test cases, and nothing here counts as accepted. Later staging additions continue into this same list.

## 1. Model Settings Page

- Page entry, refresh, window sizes; independent scrolling and full display of left/right lists with many providers and models.
- Provider and model renaming, sorting, enabling/disabling, deletion — including dragging to list edges.
- Status prompts for disabled, incomplete, and ready providers; config retention after re-enabling.
- Input auto-save, continuous editing, save feedback, failure retry, dismissing prompts; watch for banner occlusion and clipping.

## 2. Adding and Configuring Providers

- Zhipu and other provider grouping, template addition, custom addition; name differentiation, isolation, and ordering after re-adding.
- Account login and manual API Key configuration on the first-use page; default model and first send afterwards.
- With both normal API and Coding Plan API: name, Logo, address, API format, model list, key acquisition entry, real chat.
- Manually entered personal or team plan keys: usage without login; acquisition entry after keys are filled.
- Config isolation between providers; feedback for incomplete config, duplicate names, wrong addresses, provider deletion.

## 3. Adding and Editing Model Configuration

- Adding and editing models, model ID modification, Smart Config toggle, fallback configuration for unknown models.
- Under Smart Config: single-item modification, modification markers, reset; after disabling: manual config completeness.
- Editing and saving context, max output, input types, model capabilities, reasoning config.
- Reasoning parameter mapping: layout, input, error prompts, dismissal, content after re-opening.

## 4. Upgrades, Rollbacks, and Data Retention

- Upgrade from the old version: built-in and custom provider configs, models, order, selection, sessions, scheduled tasks, idle-time tasks.
- First launch after upgrade: old model names, case sensitivity, reasoning tier recovery; continued use after restart.
- Built-in config updates: existing providers, new models, default configs, user modifications retained.
- Rollback to the old version, continued use, then upgrade again; both existing and newly created content before an overwrite upgrade.
- Invalidated model selection requiring re-selection is acceptable; session and task content must open with no read errors from missing model config.
- Startup, recovery, and prompts for missing/corrupted config, not logged in, or temporarily no available providers — without affecting other providers or deleting history.

## 5. Zhipu Accounts and Plans

- Z.AI and BigModel login, logout, re-login, restart recovery; pages, quotas, and usage for experience, personal, and team plans.
- Plan and team switching, re-selecting the current plan, model lists, provider toggles, status prompts.
- Plan model editing, sorting, enabling/disabling, connection testing, real chat.
- Unactivated states, credential fetch failures, plan expiration, refresh failures: prompts, retries, manual switching.
- Experience plan claiming (success, failure, duplicate), upgrades, purchases, quota resets, refresh after returning from the website.
- Prompts, verification failures, and continued usage when model requests trigger account verification.

## 6. Startup and Workspace Switching

- Cold start or freshly opened local workspace: model list, default selection, new tasks, first send immediately.
- Retry and recovery after model loading failure.
- Model selection after workspace switch, app restart, task restore — no cross-workspace interference.

## 7. Model Selection in Normal Chat

- New-task default model first send; provider/model/reasoning tier switching — UI and actual usage agree for current and subsequent messages.
- Appending instructions during execution: keeping the original model and switching models; continued execution after model config and output style adjustments.
- Continuous sending, queuing, stopping, re-sending, attachments, message editing, branch sessions, side chats.
- "Confirm before change" and full control; permission approval and continued execution after denial.
- Same-name models under different providers: selection, usage, restart recovery; prompts after model disable, provider deletion, or plan changes.
- Config modification never interrupts running tasks or clears existing session content.

## 8. API Formats and Model Capabilities

- Messages, Chat Completions, Responses; recently added and still-used old models; real requests and model switching.
- Reasoning tiers, disabling reasoning, models that cannot disable reasoning, tool calls, structured output, continuing conversations across models.
- Images, video, PDF, native web access, system messages; prompts for unsupported capabilities; difference between normal APIs and plan capabilities.
- Long context, max output, overflow prompts, continued generation after output interruption, continued chat after compression, restart recovery.
- Auth failure, rate limiting, empty responses, stream interruption, network recovery, retries, cancellation — completed operations are not re-executed.

## 9. Model Connection Testing

- Normal keys, manual plan keys, and experience/personal/team account plans — including testing immediately after saving config.
- Success, failure, retry, dismissing prompts; model names and feedback copy.
- Models that cannot disable reasoning; connection testing in remote workspaces.

## 10. Usage Statistics and Quota Prompts

- Usage statistics: totals, details, filters, historical model records.
- Plan quotas, context usage, reset reminders, insufficient-quota prompts in chat area and sidebar; watch for repeated reminders.
- Updates after switching accounts, models, workspaces; record continuity across upgrades.

## 11. Memory Features

- Models used for memory reading, extraction, organization; continued use after restart.
- Switching chat models, multiple simultaneous tasks, prompts after memory request failures; normal chat keeps working.

## 12. Titles and Commit Message Generation

- Task titles: first generation, failure, slow responses, post-restart behavior, automatic generation coinciding with manual renaming.
- Commit messages: with/without staged changes, large changes, cancellation, failure; existing filled content retained.
- Workspace changing during commit message generation.
- Different models, including ones that cannot disable reasoning.

## 13. Goals

- Creation, replacement, clearing, restart recovery; title generation.
- Completion verification: reasoning tiers, output limits, success, failure, cancellation, retry.
- Titles, verification results, and target statuses correspond after switching models or rapid target replacement.

## 14. Repo Wiki

- Model selection, start, long runs, long content, cancellation, failure, re-generation.
- Generation follows the model output limit; no separate output budget selection.
- Old Wiki configs, viewing/continuing after restart; model usage and config isolation when switching projects or settings.

## 15. Sub-agents and Background Tasks

- Built-in and custom sub-agents: specified and inherited models, reasoning tiers.
- User's existing sub-agent configs after upgrade: content and prompts retained.
- Parent-child task parallelism and switching; background sub-agent/command start, stop, completion notifications; display and usage after restart.
- Sending messages or switching tasks while background tasks run.
- Permission confirmation, questions, and continued execution in sub-tasks — without affecting parent task model selection.

## 16. Hooks, MCP, and Plugin Tools

- Blocking, supplementary info, errors, continued execution after tool completion.
- MCP connection, login, version compatibility; plugin and built-in tool calls and errors under different API formats, including plan-related tools.
- Permission confirmation, denial, retry; tool usage after switching models.

## 17. Scheduled Tasks

- Creation, editing, start/stop, scheduled execution, missed executions, history; task titles after execution.
- Saving of models and reasoning tiers; old tasks after upgrade and restart.
- Prompts and follow-ups for discontinued models, deleted providers, expired plans, failed executions — without affecting normal chat selections.

## 18. Idle-Time Tasks

- Creation entry, plan and quota limits; creation, model selection, waiting, execution, cancellation, results, re-execution.
- Z.AI, BigModel personal and team plans; pre-upgrade idle-time tasks — records, status, continued use after upgrade and restart.
- Prompts and recovery for discontinued models, expired logins/plans, insufficient quota, network problems — without changing normal chat selections.
- Remote workspace and mobile entries; task viewing.

## 19. Bots

- Feishu, Telegram, and other bots launching and completing tasks; original bot configs and bound tasks across upgrade and restart.
- Binding existing sessions, changing models and reasoning tiers, recovery after bound tasks are deleted.
- Model selection, content, and task status consistency when bots and desktop view the same session.
- Task start, terminal events, final replies, error prompts; streaming replies, progress, terminal output on one card.
- Multi-select questions, custom answers, permission confirmations, completed card states.

## 20. Remote Workspaces

- First connection: local accounts, providers, default models usable remotely; first launch after remote installation and upgrade.
- Local login/logout/settings changes reflected in connected remotes; continued chat.
- Config sync failure, remote write failure, disconnect, reconnect, remote restart; multiple workspaces in one remote.
- Accounts, providers, tasks, and model selections never cross-use between local and different remotes.

## 21. Multi-Device Display and Operations

- Desktop, local Web, mobile remote control: model settings, lists, selections, prompt copy, task recovery.
- Local/remote workspace switching; desktop and mobile operating one task; continued use after mobile disconnect/reconnect.
- Narrow windows, light/dark themes, Chinese/English, Chinese input methods.
- CLI login, logout, default models, explicit models, sub-agents; TUI and script tasks.
- Help, version, and other CLI commands not depending on models.

## 22. Production Install Packages

- Fresh user directory: startup, login, adding providers, selecting models, first chat.
- Overwrite install from the previous official version: logins, provider configs, default models, existing tasks; continued sending.
- macOS, Windows, Linux packages: providers, models, icons; install, upgrade, uninstall, re-installation.
- Install permission prompts, install failure feedback, launches under different installation methods.
- Launches after website login or plan purchase, account refresh, post-update restart, and desktop/Web version alignment.

## 23. Session Sharing and Import

- Selecting completed content, publishing shares, permission settings, cancellation, failure retry; running tasks and session switching.
- Share body, user attachments, generated files; prompts for missing, oversized, or non-shareable content.
- Browser viewing, login access, app launching, continued chat after import, viewing/opening imported files.
- Local and supported remote workspaces; no share-selection cross-use between tasks.

## 24. Plugin Management, Browser, and Computer Control

- Plugin install, enable/disable, update prompts, updates, uninstall, config retention after restart.
- Browser popups, window sizes, task switching, local file opening — no cross-task state leakage.
- Computer control system authorization, startup, recovery; availability in parent-child tasks, background tasks, remote workspaces.
- Continued use after stopping tasks, restarting apps, plugin updates while relevant tools run.

## 25. Workspace Display and File Recovery

- Workspace sidebar, independent panels, terminals, drag resizing, window borders and menus per OS.
- Messages, tool results, media previews, file opening — long content and large files included.
- File change records, rollbacks, recovery in tasks; prompts for insufficient disk space or oversized files.
- Response and content completeness when opening old tasks, switching tasks, and workspaces after restart.

## 26. Resource Management and Storage Cleanup

- Resource manager entries, CPU and memory display, updates after task/plugin enable/disable.
- Disk usage scanning, categorized viewing, cancellation, refresh, cleanup confirmation.
- Cleanup scope and protection prompts: sessions, tasks, configs, and still-needed files are never mistakenly deleted.
- Normal chat, window closing, reopening during scanning and cleanup.

## 27. Error Feedback and Diagnostic Information

- Error summaries, details, retries, feedback entries after model, tool, and task failures.
- States after stopping, abnormal exits, restart recovery — recovered tasks no longer shown as failed.
- Diagnostics and usage records correspond to actual tasks and models; no keys or private credentials exposed.
