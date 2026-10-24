# ZCode CLI Usage Guide

This guide is for users who build the CLI from the open-source repository. It covers non-interactive invocation, extension configuration and task evaluation. The TUI started without arguments is also available for interactive use. The guide is maintained with the source; do not assume two builds have the same capabilities just because both report a `0.16.x` version.

## Where to start

1. [Quick start](01-quickstart.md): build from source, executables, self-check and the first call.
2. [CLI reference](02-cli-reference.md): flags, output formats and exit codes.
3. [Configuration](03-config.md): runtime configuration, personal model configuration, legacy migration and environment variables.
4. [Tools and evaluation setup](04-tools.md): tool visibility, non-interactive limits and evaluation boundaries.
5. [Permissions](05-permissions.md): permission modes, denial behavior and execution evidence.
6. [Sessions](06-sessions.md): create, resume, targets, usage and persistence.
7. [MCP](07-mcp.md): connect external tool servers.
8. [Skills](08-skills.md): skill discovery, invocation and custom commands.
9. [Hooks](09-hooks.md): lifecycle scripts and workspace trust.
10. [Plugins](10-plugins.md): install, marketplaces, local plugins and data directories.
11. [Instructions and memory](11-memory.md): `AGENTS.md`, memory isolation and extraction.
12. [Troubleshooting](12-troubleshooting.md): startup, configuration, permission and output problems.
13. [Batch tasks and run records](13-automation.md): reproducible runs, result judgment and trajectory export.

## Versions and verification

For every run, save at least `zcode --version`, `zcode doctor --json`, and the build commit or the binary SHA-256. Record the plugin versions, model ID, model configuration and task workspace. The model catalog and plugin marketplaces can update independently, so the same CLI version does not mean the same run conditions.

This guide describes the current source interface. Older builds may lack `--workflow-mode` or still use the old model configuration. Use the small self-check in the relevant chapter to determine capabilities; `--help` may not list every flag the parser supports, so do not rely on help text alone.

This guide was last checked on 2026-10-14. The verified scope and the unverified items are in the [run record](13-automation.md#verification-scope).

## Scope of the open-source build

A source build needs this repository's workspace dependencies and runtime assets. Do not copy only `zcode.cjs` and assume plugins, model configuration and native tool assets are complete. Computer Use uses a placeholder implementation in the open-source export, so the open-source build cannot claim full native desktop control. Browser Use is a separate capability and still needs a usable Chrome/Chromium and the matching plugin.

Service addresses, API keys, model IDs and absolute paths in the examples must be replaced with your own values. The examples provide no usable credentials. The generic model API configuration and account login are different entry points; choose according to the provider you actually use.
