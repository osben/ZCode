# Model Provider Refactor Release Regression Scope (2026-09-11)

> Status: Pending Execution
>
> Reference: Old staging (`staging_backup @ 790884b1ce`) → Current staging (`b8499d8b2a`)

This refactor has not yet gone live. This document is the cumulative release regression scope for the entire refactor, not an incremental list for the latest batch. All checks from the [previous regression scope](./03-provider-refactor-release-regression-scope.md) remain in effect, with changes from the old staging and concurrently merged features added. Existing development or test records do not justify reducing scope.

The following only circumscribes product functions and key scenarios, without expanding into detailed test cases, and does not represent that anything has been accepted. Subsequent staging additions continue to be added to the same list.

## 1. Model Settings Page

- Check page entry, refresh, different window sizes, and independent scrolling and full display of left/right lists when there are many providers and models.
- Check provider and model renaming, sorting, enabling/disabling, and deletion, including dragging to list edges.
- Check status prompts for provider disablement, incomplete configuration, and readiness, as well as configuration retention after re-enabling.
- Check input box auto-save, continuous editing, save feedback, failure retries, and dismissing prompts; watch for banner occlusion and clipping.

## 2. Adding and Configuring Providers

- Check Zhipu and other provider grouping, template addition, custom addition, and name differentiation, isolation, and sorting after re-adding.
- Check account login and manual API Key configuration on the first-use page, as well as default model and first send after configuration.
- Using both normal API and Coding Plan API separately, check name, Logo, address, API format, model list, key acquisition entry, and actual chat.
- Check manually entering personal or team plan keys, usage without logging in, and the acquisition entry after keys are filled.
- Check configuration isolation between different providers, and feedback for incomplete configuration, duplicate names, wrong addresses, and provider deletion.

## 3. Adding and Editing Model Configuration

- Check adding and editing models, modifying model IDs, smart configuration toggle, and fallback configuration for unknown models.
- Check single-item modification, modification markers, and reset under smart configuration; check manual configuration completeness after disabling.
- Check editing and saving context, max output, input types, model capabilities, and reasoning configuration.
- Check reasoning parameter mapping layout, input, error prompts, dismissal, and content after re-opening.

## 4. Upgrades, Rollbacks, and Data Retention

- Upgrade from the old version; check original built-in and custom provider configurations, models, order, and selection, as well as sessions, scheduled tasks, and idle-time tasks.
- Check first launch after upgrade, old model names, case sensitivity, and reasoning tier recovery, as well as continued use after restart.
- Check retention of existing providers, new models, default configurations, and user modifications after built-in config updates.
- Check rollback to the old version, continued use after rollback, then upgrade; covering both existing and newly created content before overwrite upgrade.
- Model selection becoming invalid and requiring re-selection is acceptable; session and task content must be openable, with no read errors due to missing model configuration.
- Check startup, recovery, and prompts when configuration is missing or corrupted, not logged in, or temporarily without available providers; this does not affect other providers and does not delete historical content.

## 5. Zhipu Accounts and Plans

- Check Z.AI and BigModel login, logout, re-login, and restart recovery separately; check pages, quotas, and usage for experience, personal, and team plans.
- Check plan and team switching, re-selecting the current plan, model lists, provider toggles, and status prompts.
- Check plan model editing, sorting, enabling/disabling, connection testing, and actual chat.
- Check prompts, retries, and manual switching for unactivated states, credential fetch failures, plan expiration, and refresh failures.
- Check experience plan claiming success, failure, and duplicate claiming, as well as upgrades, purchases, quota resets, and refresh after returning from the official website.
- Check prompts, verification failures, and continued usage after verification completion when model requests trigger account verification.

## 6. Startup and Workspace Switching

- On cold start or just opening a local workspace, immediately check the model list, default selection, new tasks, and first send.
- Check retry and recovery after model loading fails.
- Check model selection after switching workspaces, restarting the app, and restoring tasks, avoiding cross-workspace interference.

## 7. Model Selection in Normal Chat

- Check new task default model first send, provider/model/reasoning tier switching, and whether the interface and actual usage of current and subsequent messages are consistent.
- Check appending instructions during execution, separately covering keeping the original model and switching models; note continued execution after model configuration and output style adjustments.
- Check continuous sending, queuing, stopping, re-sending, sending with attachments, editing messages, branch sessions, and side chats.
- Check operations under "confirm before change" and full control, permission approval, and continued execution after denial.
- Check selection, usage, and restart recovery for same-name models under different providers, as well as prompts after model disable, provider deletion, or plan changes.
- Check that modifying configuration does not unexpectedly interrupt running tasks or clear existing session content.

## 8. API Formats and Model Capabilities

- Cover Messages, Chat Completions, Responses three API types, recently added models, and still-used old models; check real requests and model switching.
- Check reasoning tiers, disabling reasoning, models whose reasoning cannot be disabled, tool calls, structured output, and continuing existing conversations across models.
- Check images, video, PDF, native web access, and system messages in conversations, and prompts when capabilities are not supported; note the difference between normal APIs and plan capabilities.
- Check long context, max output, overflow prompts, continued generation after output interruption, continued chat after compression, and restart recovery.
- Check auth failure, rate limiting, empty responses, streaming interruption, network recovery, retries, and cancellation, without re-executing completed operations.

## 9. Model Connection Testing

- Cover normal keys, manual plan keys, and experience, personal, and team account plans, including testing immediately after saving configuration.
- Check success, failure, retry, and dismissing prompts, as well as model names and feedback copy.
- Check models whose reasoning cannot be disabled, and connection testing in remote workspaces.

## 10. Usage Statistics and Quota Prompts

- Check total amounts, details, filters, and historical model records in usage statistics.
- Check plan quotas, context usage, reset reminders, and insufficient quota prompts in the chat area and sidebar; watch for reminders appearing repeatedly.
- Check updates after switching accounts, models, or workspaces, as well as record continuity before and after upgrades.

## 11. Memory Features

- Check the models used for memory reading, extraction, and organization, as well as continued use after restart.
- Check switching chat models, running multiple tasks simultaneously, and prompts after memory request failures, and whether normal chat functions normally.

## 12. Titles and Commit Message Generation

- Check task title first generation, failure, slow responses, and behavior after restart, as well as situations where automatic generation and user manual renaming occur simultaneously.
- Check commit message generation with and without staged changes, large changes, cancellation, and failure, as well as retention of existing filled content.
- Check situations where workspace changes continue during commit message generation.
- Cover different models, including models whose reasoning cannot be disabled.

## 13. Goals

- Check creation, replacement, clearing, and restart recovery, as well as title generation.
- Check completion verification reasoning tiers, output limits, success, failure, cancellation, and retry.
- Check whether titles, verification results, and target statuses correspond after switching models or quickly replacing targets.

## 14. Repo Wiki

- Check model selection, start generation, long-running, long content, cancellation, failure, and re-generation.
- Check generation follows the model output limit; no longer requires separate output budget selection.
- Check old Wiki configurations, viewing or continuing generation after restart, and model usage and configuration isolation when switching projects and modifying Wiki settings.

## 15. Sub-agents and Background Tasks

- Check specified models and inherited models for built-in and custom sub-agents, as well as reasoning tiers.
- Check retention of configuration content and prompts after user existing sub-agent configurations upgrade.
- Check parent-child task parallelism and task switching, as well as startup, stop, completion notifications for background sub-agents and background commands, and display and usage after restart.
- Check continuing to send messages or switching tasks while background tasks run.
- Check permission confirmation, questions, and continued execution in sub-tasks, without affecting parent task model selection.

## 16. Hooks, MCP, and Plugin Tools

- Check blocking, supplementary information, errors, and continued execution after tool completion.
- Check MCP connection, login, and version compatibility, as well as plugin and built-in tool calls and errors under different API formats, including plan-related tools.
- Check permission confirmation, denial, and retry, as well as tool usage after switching models.

## 17. Scheduled Tasks

- Check creation, editing, start/stop, scheduled execution, missed executions, and history, as well as task titles after execution.
- Check saving of models and reasoning tiers, as well as running of old tasks after upgrade and restart.
- Check prompts and follow-up actions when models are discontinued, providers are deleted, plans expire, or executions fail, without affecting normal chat selections.

## 18. Idle-Time Tasks

- Check creation entry, plan and quota limits, as well as creation, model selection, waiting for scheduling, execution, cancellation, viewing results, and re-execution.
- Cover Z.AI, BigModel personal and team plans; check records, status, and continued use of existing idle-time tasks from before upgrade, after upgrade and restart.
- Check prompts and recovery when models are discontinued, logins expire, plans expire, quotas are insufficient, or networks are abnormal, without changing normal chat model selections.
- Check remote workspace and mobile device entries and task viewing.

## 19. Bots

- Use configured Feishu, Telegram, and other bots to launch and complete tasks; check original bot configurations and bound task upgrades and restart recovery.
- Check binding existing sessions, modifying models and reasoning tiers, and recovery after bound tasks are deleted.
- Check consistency of model selection, content, and task status when bots and desktop view the same session.
- Check task startup, terminal events, final replies, and error prompts, as well as streaming replies, progress, and terminal output on the same card.
- Check multi-select questions, custom answers, permission confirmations, and card states after completion.

## 20. Remote Workspaces

- Check usage of local accounts, providers, and default models remotely after first connection, as well as first launch after remote installation and upgrade.
- Check updates and continued chat in already-connected remotes after local login, logout, or model settings changes.
- Check config sync failure, remote write failure, disconnection, reconnection, and remote restart, as well as multiple workspaces in the same remote.
- Check that accounts, providers, tasks, and model selections between local and different remotes do not cross-use.

## 21. Multi-Device Display and Operations

- Check model settings, lists, selections, prompt copy, and task recovery on desktop, local Web, and mobile remote control.
- Check switching between local and remote workspaces, operating the same task on desktop and mobile, and continued use after mobile disconnection reconnection.
- Cover narrow windows, light/dark themes, Chinese/English, and Chinese input methods.
- Check CLI login, logout, default models, explicit models, and sub-agents, as well as usage in TUI and script tasks.
- Check help, version, and other CLI commands that do not depend on models.

## 22. Production Install Packages

- Install with a brand-new user directory; complete startup, login, adding providers, selecting models, and first chat.
- Overwrite install from the previous official version; check existing logins, provider configurations, default models, and existing tasks, then continue sending.
- Cover providers, models, and icons in macOS, Windows, and Linux install packages, as well as installation, upgrade, uninstall, and re-installation.
- Check install permission prompts, install failure feedback, and app launches under different installation methods.
- Check launching apps after official website login or plan purchases, account refresh, post-update restart, and usage after desktop and Web version alignment.

## 23. Session Sharing and Import

- Check selecting completed content, publishing shares, permission settings, cancellation, and failure retries; cover running tasks and session switching.
- Check body, user attachments, and generated files in shares, as well as prompts for missing, oversized, or non-shareable content.
- Check browser viewing, login access, app launching, continued chat after import, and viewing/opening imported files.
- Check local and supported remote workspaces, avoiding share selection cross-use between different tasks.

## 24. Plugin Management, Browser, and Computer Control

- Check plugin installation, enable/disable, update prompts, updates, uninstall, and configuration retention after restart.
- Check browser popups, window sizes, task switching, and local file opening, without cross-task state leakage.
- Check computer control system authorization, startup, and recovery, as well as availability scope in parent-child tasks, background tasks, and remote workspaces.
- Check continued use after stopping tasks, restarting apps, and plugin updates when relevant tools run.

## 25. Workspace Display and File Recovery

- Check workspace sidebar, independent panels, terminals, drag resizing, and window borders and menus under different systems.
- Check messages, tool results, media previews, and file opening, including long content and large files.
- Check file change records, rollbacks, and recovery in tasks, as well as prompts when disk space is insufficient or files are too large.
- Check response and content completeness when opening old tasks, switching tasks, and workspaces after restart.

## 26. Resource Management and Storage Cleanup

- Check resource manager entries, CPU and memory display, and updates after task and plugin enable/disable.
- Check disk usage scanning, categorized viewing, cancellation, refresh, and cleanup confirmation.
- Check cleanup scope and protection prompts; confirm that sessions, tasks, configurations, and still-needed files will not be mistakenly deleted.
- Check normal chat, window closing, and reopening during scanning and cleanup.

## 27. Error Feedback and Diagnostic Information

- Check error summaries, details, retries, and feedback entries after model, tool, and task failures.
- Check states after stopping, abnormal exits, and restart recovery, avoiding continuing to show recovered tasks as failed.
- Check that diagnostic information and usage records correspond to actual tasks and models, without exposing keys or private credentials.
