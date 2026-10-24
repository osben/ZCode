# Slash Command and Official Plugin Description Localization

## Background

The `/` panel merges the ZCode Agent's visible slash commands and enabled skills. Built-in command
descriptions come from the protocol command table; descriptions of official-plugin commands, skills and MCP
tools come from the plugin package's own metadata and MCP server registration.

## Goals

- In the Chinese UI, the built-in `/compact` and `/goal` descriptions show in Chinese.
- Command frontmatter `description`, skill frontmatter `description`, and MCP tool `title`, `description`
  and parameter `describe(...)` of official plugins are written in Chinese, so the tool list shows no
  English explanations.

## Boundaries

- User-defined commands, user/workspace skills and third-party plugin descriptions are not auto-translated
  and keep the author's text.
- Built-in commands keep the protocol layer's compatibility fields; the UI overrides stable built-in
  command descriptions by the current locale.
- Official plugins have no per-locale manifest/frontmatter protocol, so the display descriptions of
  official resources are written directly in Chinese.

## Acceptance

- In the Chinese `/` panel, `/compact` and `/goal` no longer show English descriptions.
- Skill descriptions of the official plugins `android-dev`, `ios-dev`, `control-browser`, `docx`, `pdf`,
  `skill-creator` are Chinese; command descriptions of `android-dev` and `ios-dev` are Chinese.
- Android Emulator and iOS Simulator MCP tool titles, descriptions and parameter descriptions are Chinese.
