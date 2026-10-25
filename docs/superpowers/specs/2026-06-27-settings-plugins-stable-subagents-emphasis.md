# Settings Plugins Stable Status and Subagents Scope Emphasis

Plugins management is out of beta. The Subagents panel still does not support workspace-level creation or editing, and the settings UI keeps that limitation visible.

Rules:

- The Plugins settings page shows no `Beta` / `测试` badge — not in the content-area title and not in the left settings navigation. Narrow/mobile layouts keep a normal title with no badge placeholder.
- The Subagents settings page keeps its base description; the scope-limitation hint sits next to the save button in the new-subagent form footer, with a leading info icon and `text-foreground`, sourced from i18n (no hardcoded Chinese strings).
- No changes to the plugin protocol, install logic, or marketplace data; no new Subagents workspace-level create/edit capability.
