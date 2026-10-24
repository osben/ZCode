# Sidebar Primary Navigation Order

## Background

The WorkspaceSidebar top navigation hosts New Task, Command Center search, Automations, and the Plugins settings entry. Automations is a high-frequency task capability; on platforms that support it, it sits directly below Search. Plugins stays fixed below Automations. Mobile `/remote` does not host Automations and keeps only the Plugins entry.

## Rules

Desktop and regular Web top navigation order:

```text
New Task
  |
  v
Search / Command Center
  |
  v
Automations / 自动化
  |
  v
Plugins / 插件（定位到 `plugins` 设置分区）
  |
  v
Workspace task view switcher
```

Mobile `/remote` top navigation order:

```text
New Task
  |
  v
Search / Command Center
  |
  v
Plugins / 插件（定位到 `plugins` 设置分区）
  |
  v
Workspace task view switcher
```

Both layouts reuse the entry visual style, theme tokens, and button sizing of existing `WorkspaceSidebar` primary navigation buttons.
