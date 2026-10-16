# Model Provider Refactor Release Regression Scope

> Status: Pending Execution
>
> Baseline Date: 2026-09-03

This document lists the main functions that need regression testing before the model provider refactor goes live. Each section corresponds to one user function. The final regression should be executed after the latest staging is merged in.

## 1. Model Settings Page

- Check page entry, refresh, scrolling, and display under different window sizes.
- Check whether the left and right lists can scroll independently and display fully when there are many providers and models.
- Check renaming and sorting of providers and models, as well as model toggles and deletion.
- Check input box auto-save, save feedback, and continuous editing.
- Check model configuration editing and reset to defaults, including context, max output, input types, model capabilities, and reasoning tiers.
- Check light and dark themes, Chinese and English interfaces, and Chinese input methods.

## 2. Adding and Configuring Model Providers

- Enter the template list from "Add Provider", then add built-in providers and pure custom providers separately.
- Enter API Key from the first-use page, configure Z.AI or BigModel pay-per-use APIs.
- Check the new provider's name, Logo, endpoint URL, API format, and model list.
- Re-add the same template; check name differentiation, configuration isolation, and sorting.
- After filling API Key, endpoint URL, and models, check save, connection test, and actual chat.
- Check page feedback for incomplete configuration, duplicate names, wrong endpoints, and provider deletion.

## 3. Preserving Model Provider Configuration After Upgrade

- Configure built-in and custom providers in the old version, then upgrade to the new version; check original configuration, models, and order.
- Check first launch after upgrade, application restart, and continued model usage.
- Start with missing or corrupted old configuration; check error prompts and usage of other providers.
- After updating built-in model configuration, check existing providers, new models, and model defaults.

## 4. Zhipu Accounts and Plan Models

- Check Z.AI and BigModel login, logout, re-login, and application restart recovery.
- Check pages, models, quotas, and usage status for experience plans, personal plans, and team plans separately.
- Check claiming the experience plan, and page refresh after successful, failed, and duplicate claims.
- Check switching between different plans and different teams, and re-selecting the current plan.
- Check plan model editing, sorting, toggles, connection tests, and actual chat.
- Check upgrade entry, returning to the app after purchase, and plan info refresh.
- Check prompts and retries when plan info fails to load.
- Check prompts and continued usage after model requests trigger account verification.

## 5. Application Startup and Workspace Switching

- After cold-starting the app or opening a local workspace, immediately check the model list, default model, new task, and first send.
- Check prompts, retries, and recovery after model loading fails.
- Check model usage after switching workspaces, restarting the app, and restoring existing tasks.

## 6. Model Selection in Normal Chat

- Create a new task and send with the default model; verify interface display and the actual provider, model, and reasoning tier used.
- Switch providers, models, and reasoning tiers within a task; check current and subsequent messages.
- Check switching models during task execution, appending instructions, and operations with "confirm before change" enabled.
- Check continuous sending, stopping, re-sending, and sending with attachments.
- Check selection, usage, and restart recovery when different providers have same-name models.
- Check recovery and prompts for existing tasks after model disable or provider deletion.

## 7. Different API Formats and Model Capabilities

- Complete real requests using Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses separately.
- Check reasoning tiers for different models, including models whose reasoning cannot be disabled.
- Check long context, max output, and prompts when exceeding model limits.
- Check continued chat after conversation compression and restart recovery.
- Check images, video, and PDF input, and prompts when models do not support corresponding content.
- Check tool calls, structured output, native web access, and system messages.
- Check auth failure, rate limiting, network interruption, and request cancellation.

## 8. Usage Statistics and Quota Prompts

- Check total amounts, details, filters, and usage records for each model on the usage statistics page.
- Check plan quotas, context usage, and reset reminders in the chat area and sidebar.
- Check updates to statistics and quota information after switching account plans, models, or workspaces.

## 9. Memory Features

- Check the models used for memory reading, extraction, and organization.
- Check whether memory features continue to work after application restart.
- Check memory features when switching chat models or running multiple tasks simultaneously.
- Check page prompts and whether normal chat functions normally when memory model requests fail.

## 10. Task Title Generation

- Check first title generation, generation failure, slow responses, and behavior after application restart.
- Check situations where automatic title generation and user manual renaming occur simultaneously.
- Use models that cannot disable reasoning to generate titles.

## 11. Goal Titles and Completion Verification

- Check title generation for Goal creation, replacement, clearing, and restart.
- Check success, failure, cancellation, and retry of Goal completion verification.
- Check title results when quickly replacing Goals, and Goal status after verification failure.

## 12. Git Commit Message Generation

- Check behavior with and without staged changes, large changes, generation failure, and cancellation.
- Check behavior when the user has already filled in commit information and generates commit info again.
- Check situations where the workspace continues to change during generation.

## 13. Repo Wiki

- Check model selection, start generation, long-running, cancellation, and failure.
- Check continuing to view or generate Wiki after application restart.
- Check the model used when switching projects and modifying Wiki settings.

## 14. Model Connection Testing

- Test models in API Key providers, experience plans, personal plans, and team plans separately.
- Test the connection immediately after saving provider configuration.
- Test connection for models that cannot disable reasoning.
- Check model names in success prompts, failure prompts, and re-testing.
- Open the model settings page in a remote workspace and test the connection.

## 15. Sub-agents and Background Tasks

- Check the provider, model, and reasoning tier used by built-in and custom sub-agents.
- Check model usage and task switching when parent and child tasks run simultaneously.
- Check whether parent and child tasks continue to display and function normally after application restart.
- Check startup, stop, and completion notifications for background sub-agents and background commands.
- Check continuing to send messages or switching tasks while background tasks run.
- Check question cards, permission confirmation, and continued generation after tool completion.

## 16. Hooks, MCP, and Plugin Tools

- Check Hooks' blocking of model requests, supplementary information, errors, and subsequent execution.
- Check MCP server connection, login, and version compatibility.
- Check calls and errors for MCP, plugin tools, and built-in tools under different API formats.

## 17. Model Usage in Scheduled Tasks

- Check scheduled task creation, editing, start/stop, scheduled execution, missed executions, and history.
- Check the provider, model, and reasoning tier saved and used by scheduled tasks.
- Check task titles generated after scheduled task execution.
- Check existing tasks after application restart, and tasks created before upgrade.
- Check prompts and follow-up actions when models are discontinued, providers are deleted, plans expire, or requests fail.
- Check that scheduled task and normal chat model selections do not affect each other.

## 18. Idle-Time Tasks and Existing Tasks

- Fully experience idle-time task creation, model selection, waiting for scheduling, execution, viewing results, cancellation, and re-execution.
- Create idle-time tasks using Z.AI, BigModel, personal plans, and team plans separately.
- Create idle-time tasks before upgrade; after upgrade and app restart, check task records and current status.
- Check prompts and recovery when models are discontinued, plans expire, logins expire, quotas are insufficient, or networks are abnormal.
- Check that idle-time tasks do not change model selections in normal chat.
- Check idle-time task entries for remote workspaces and mobile devices.

## 19. Bot Tasks and Feishu Interaction

- Use configured bots like Feishu, Telegram, etc., to launch and complete tasks.
- After upgrading the app, check original bot configurations and task objectives.
- Check task startup, terminal events, final results, and error prompts.
- Check multi-select questions, custom answers, permission confirmations, and completed card states in Feishu.
- Check streaming replies, task progress, and terminal output on the same Feishu card.

## 20. Model Usage in Remote Workspaces

- After first connecting to a remote workspace, check whether local accounts, providers, and default models can be used remotely.
- After local login, logout, or model settings changes, check updates in already-connected remote workspaces.
- After opening multiple workspaces in the same remote environment, check model configuration and task usage.
- Check model config sync failure, network interruption, remote write failure, and SSH reconnection.
- Check account, provider, model, and task isolation between local workspaces and different remote environments.

## 21. Desktop, Web, Mobile, and CLI

- Check model lists, model selection, and task recovery in Desktop, local Web, and mobile remote control.
- Check switching between local and remote workspaces, and Desktop and mobile operating on the same task simultaneously.
- Check CLI login, logout, default models, explicit models, and sub-agents.
- Check model usage in TUI and script tasks.
- Check help, version, and other CLI commands that do not require models.

## 22. Production Install Packages

- Install production packages with a brand-new user directory; complete startup, login, adding providers, selecting models, and sending messages.
- Overwrite install from the previous official version; check existing logins, provider configurations, default models, and existing tasks, then continue sending messages.
- After logging in or purchasing plans on the official website, click "Open ZCode"; check app launch and account info refresh.
- Install macOS, Windows, and Linux official packages separately; check built-in providers, models, and Logos.
