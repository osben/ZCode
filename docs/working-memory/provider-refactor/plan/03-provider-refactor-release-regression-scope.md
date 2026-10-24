# Model Provider Refactor Release Regression Scope

> Status: Pending execution. Baseline date: 2026-09-03. Superseded by the cumulative scope in `04-provider-refactor-release-regression-scope-2026-09-11.md` — this list remains in effect there.

Main functions to regression-test before the model provider refactor goes live. Each section is one user function. The final regression runs after the latest staging is merged.

## 1. Model Settings Page

- Page entry, refresh, scrolling, and display under different window sizes.
- Left/right lists scroll independently and display fully with many providers and models.
- Provider and model renaming, sorting; model toggles and deletion.
- Input auto-save, save feedback, and continuous editing.
- Model config editing and restore-to-defaults: context, max output, input types, model capabilities, reasoning tiers.
- Light/dark themes, Chinese and English interfaces, Chinese input methods.

## 2. Adding and Configuring Model Providers

- From "Add Provider": template list, add a built-in provider and a fully custom provider.
- API Key entry from the first-use page; configure Z.AI or BigModel pay-per-use APIs.
- New provider's name, Logo, endpoint URL, API format, and model list.
- Re-add the same template: name differentiation, config isolation, ordering.
- After filling API Key, endpoint, and models: save, connection test, real chat.
- Feedback for incomplete config, duplicate names, wrong endpoints, and provider deletion.

## 3. Preserving Model Provider Configuration After Upgrade

- Configure built-in and custom providers in the old version, upgrade, and verify original config, models, and order.
- First launch after upgrade, app restart, continued model usage.
- Missing or corrupted old config: error prompts and usability of other providers.
- After a Built-in model config update: existing providers, new models, model defaults.

## 4. Zhipu Accounts and Plan Models

- Z.AI and BigModel login, logout, re-login, restart recovery.
- Pages, models, quotas, and usage for experience, personal, and team plans.
- Claiming the experience plan: success, failure, duplicate claims, and page refresh.
- Switching plans and teams; re-selecting the current plan.
- Plan model editing, sorting, toggles, connection tests, real chat.
- Upgrade entry, returning to the app after purchase, plan info refresh; prompts and retry when plan info fails to load.
- Prompts and continued usage after model requests trigger account verification.

## 5. Application Startup and Workspace Switching

- Cold start / opening a local workspace: model list, default model, new task, and first send immediately work.
- Model loading failure: prompts, retry, recovery.
- Switching workspaces, restarting the app, restoring existing tasks, continued model usage.

## 6. Model Selection in Normal Chat

- New task with default model: UI display versus the actually used provider, model, and reasoning tier.
- Switch provider/model/reasoning tier mid-task: current and subsequent messages.
- Switching models during execution, appending instructions, "confirm before change" enabled.
- Continuous sending, stopping, re-sending, sending with attachments.
- Same-name models under different providers: selection, usage, restart recovery.
- Recovery and prompts for existing tasks after a model is disabled or a provider deleted.

## 7. Different API Formats and Model Capabilities

- Real requests through Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses.
- Reasoning tiers per model, including models that cannot disable reasoning.
- Long context, max output, and prompts when exceeding model limits.
- Continued chat after conversation compression and restart recovery.
- Image, video, PDF input; prompts when the model lacks support.
- Tool calls, structured output, native web access, system messages.
- Auth failure, rate limiting, network interruption, request cancellation.

## 8. Usage Statistics and Quota Prompts

- Usage statistics page: totals, details, filters, per-model records.
- Plan quotas, context usage, reset reminders in the chat area and sidebar.
- Statistics and quota updates after switching account plan, model, or workspace.

## 9. Memory Features

- Models used for memory reading, extraction, and organization.
- Memory features after app restart.
- Memory features when switching chat models or running multiple tasks.
- Prompts and normal chat behavior when memory model requests fail.

## 10. Task Title Generation

- First generation, generation failure, slow responses, post-restart behavior.
- Automatic generation coinciding with manual user renaming.
- Title generation with models that cannot disable reasoning.

## 11. Goal Titles and Completion Verification

- Titles for Goal creation, replacement, clearing, restart.
- Completion verification: success, failure, cancellation, retry.
- Rapid Goal replacement titles; Goal status after verification failure.

## 12. Git Commit Message Generation

- With/without staged changes, large changes, failure, cancellation.
- Regenerating when the user already filled commit info.
- Workspace changing during generation.

## 13. Repo Wiki

- Model selection, start, long runs, cancellation, failure.
- Viewing or generating the Wiki again after restart.
- Model used when switching projects or modifying Wiki settings.

## 14. Model Connection Testing

- Test models in API Key providers, experience plans, personal plans, and team plans.
- Test immediately after saving provider config.
- Test models that cannot disable reasoning.
- Model names in success/failure prompts and re-testing.
- Open model settings in a remote workspace and test the connection.

## 15. Sub-agents and Background Tasks

- Provider, model, and reasoning tier used by built-in and custom sub-agents.
- Model usage and task switching with parent and child tasks running together.
- Parent/child task display and behavior after restart.
- Background sub-agent and background command start, stop, and completion notifications.
- Sending messages or switching tasks while background tasks run.
- Question cards, permission confirmation, continued generation after tool completion.

## 16. Hooks, MCP, and Plugin Tools

- Hooks blocking model requests, supplementary info, errors, and subsequent execution.
- MCP server connection, login, version compatibility.
- Calls and errors for MCP, plugin, and built-in tools under different API formats.

## 17. Model Usage in Scheduled Tasks

- Scheduled task create, edit, start/stop, scheduled execution, missed executions, history.
- Provider, model, and reasoning tier saved and used by scheduled tasks.
- Task titles generated after scheduled execution.
- Existing tasks after restart; tasks created before upgrade.
- Prompts and follow-ups when models are discontinued, providers deleted, plans expire, or requests fail.
- Scheduled task and normal chat model selections do not affect each other.

## 18. Idle-Time Tasks and Existing Tasks

- Full lifecycle: creation, model selection, waiting for scheduling, execution, results, cancellation, re-execution.
- Idle-time tasks created with Z.AI, BigModel, personal plans, and team plans.
- Idle-time tasks created before upgrade: records and current status after upgrade and restart.
- Prompts and recovery for discontinued models, expired plans/logins, insufficient quota, network problems.
- Idle-time tasks never change normal chat model selections.
- Idle-time task entries in remote workspaces and on mobile.

## 19. Bot Tasks and Feishu Interaction

- Launch and complete tasks through configured bots (Feishu, Telegram, …).
- After upgrade: original bot configs and task objectives.
- Task start, terminal events, final results, error prompts.
- Multi-select questions, custom answers, permission confirmations, completed card states in Feishu.
- Streaming replies, task progress, terminal output on the same Feishu card.

## 20. Model Usage in Remote Workspaces

- First connection to a remote workspace: local accounts, providers, and default models usable remotely.
- Local login/logout/settings changes reflected in connected remote workspaces.
- Multiple workspaces in one remote environment: model config and task usage.
- Config sync failure, network interruption, remote write failure, SSH reconnection.
- Account, provider, model, and task isolation between local and different remote environments.

## 21. Desktop, Web, Mobile, and CLI

- Model lists, selection, and task recovery on Desktop, local Web, and mobile remote control.
- Local/remote workspace switching; Desktop and mobile operating the same task simultaneously.
- CLI login, logout, default models, explicit models, sub-agents.
- Model usage in TUI and script tasks.
- Help, version, and other CLI commands that need no model.

## 22. Production Install Packages

- Fresh user directory: startup, login, adding providers, selecting models, sending messages.
- Overwrite install from the previous official version: logins, provider configs, default models, existing tasks, continued sending.
- "Open ZCode" after website login or plan purchase: app launch and account info refresh.
- macOS, Windows, and Linux official packages: built-in providers, models, Logos.
