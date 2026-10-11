import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";

/**
 * The App `/` panel and plus menu display entries in this order (the UI does not maintain a separate
 * ordering allowlist). `workflow` follows `goal`; both start a unit of work (see "Workflow entry" in
 * docs/ui/chat-composer-action-menu.md). It is gated by the gradual-rollout flag and filtered during
 * assembly by zcode-protocol/slash-commands.ts.
 */
export const APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES = [
  "goal",
  "workflow",
  "compact",
  "init",
] as const;

/** Commands used only by the App Composer; do not add them to the CLI TUI/help surface. */
export const APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS = [
  {
    description: "Switch to Plan mode and optionally send a task.",
    inputHint: "/plan [task]",
    name: "plan",
    source: "builtin",
  },
] as const satisfies readonly ZCodeSlashCommand[];

const EXTRA_RESERVED_SLASH_COMMAND_NAMES = ["compress", "plan"] as const;

const RESERVED_SLASH_COMMAND_NAMES = new Set(
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.flatMap((entry) => [
    entry.name,
    ...(entry.aliases ?? []),
  ]).concat([...EXTRA_RESERVED_SLASH_COMMAND_NAMES]),
);

export function normalizeZCodeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isReservedZCodeSlashCommandName(name: string): boolean {
  return RESERVED_SLASH_COMMAND_NAMES.has(normalizeZCodeSlashCommandName(name));
}
