import type { PermissionOptionsPolicy, PermissionUpdate } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME, type ZCodePermissionOption } from "@zcode/shared";

const PROJECT_RULE_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern"] as const;

// When a user rejects a regular interactive permission request, explicitly tell the model that the
// tool did not run and wait for further instructions; this reason is also provider-visible tool_result.content.
export const PERMISSION_DENIED_BY_USER_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export function buildPermissionDeniedContent(feedback?: string): string {
  const trimmed = feedback?.trim();
  return trimmed
    ? `${PERMISSION_DENIED_BY_USER_CONTENT} To tell you how to proceed, the user said:\n${trimmed}`
    : PERMISSION_DENIED_BY_USER_CONTENT;
}

/**
 * Session permission option identifiers, internal kinds, and display names.
 * optionId is passed unchanged on the v4 wire (the broker uses it for exact matching); kind is an
 * internal CLI value mapped to the closed set's `allowAlways` by the v4 projection; name is a GUI
 * localization key matched through PermissionDialog's global name map.
 */
const SESSION_ALLOW_PERMISSION_OPTION_ID = "allowSession";
export const SESSION_ALLOW_PERMISSION_OPTION_KIND = "allow_session";
const SESSION_ALLOW_PERMISSION_OPTION_NAME = "Always allow in this session";

interface PermissionOptionSource {
  approvalMode?: "user-once";
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  optionsPolicy?: PermissionOptionsPolicy;
  toolName: string;
}

/**
 * Pure permission-option projection shared by v3 and v4. It lives outside the protocol directory so
 * the authoritative v4 projection does not depend on the legacy protocol.
 */
export function buildProtocolPermissionOptions(
  source: PermissionOptionSource,
): ZCodePermissionOption[] {
  const permissionUpdates = source.suggestedPermissionUpdates?.length
    ? source.suggestedPermissionUpdates
    : defaultPermissionUpdates(source);
  const officialCuaProjectScope = permissionUpdates.some((update) =>
    update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
  const options: ZCodePermissionOption[] = [
    {
      kind: "allow_once",
      name: "Allow once",
      optionId: "allow_once",
      response: {
        decision: "allow",
        reason: "Approved once",
      },
    },
    // A tool can declare no-always-allow: when each call runs different code, a persistent rule would
    // permanently disable this confirmation instead of "remembering this decision." session-always-allow
    // instead skips confirmation for the current session. The response has **no** permissionUpdates;
    // zcodePermissionUpdateSchema is strict on the wire, so the broker synthesizes sessionPermissionUpdates
    // when responding (in memory only, never as a project rule).
    ...(source.optionsPolicy === "no-always-allow"
      ? []
      : source.optionsPolicy === "session-always-allow"
        ? [
            {
              description: "Do not ask again for this tool in this session",
              kind: SESSION_ALLOW_PERMISSION_OPTION_KIND,
              name: SESSION_ALLOW_PERMISSION_OPTION_NAME,
              optionId: SESSION_ALLOW_PERMISSION_OPTION_ID,
              response: {
                decision: "allow" as const,
                reason: "Approved for this session",
              },
            },
          ]
        : [
            {
              description: officialCuaProjectScope
                ? "Do not ask again for official Computer Use tools in this project"
                : "Do not ask again for matching requests in this project",
              kind: "allow_always" as const,
              name: officialCuaProjectScope
                ? "Always allow Computer Use in this project"
                : "Always allow in this project",
              optionId: "allow_project",
              response: {
                decision: "allow" as const,
                permissionUpdates,
                reason: "Approved for this project",
              },
            },
          ]),
    {
      kind: "deny",
      name: "Deny",
      optionId: "deny",
      response: {
        decision: "deny",
        reason: PERMISSION_DENIED_BY_USER_CONTENT,
      },
    },
  ];
  return source.approvalMode === "user-once"
    ? options.filter((option) => option.kind === "allow_once" || option.kind === "deny")
    : options;
}

/**
 * Session permission is granted for the tool as a whole (without ruleContent): each script differs,
 * so the permission applies to "this tool," not to a particular script.
 */
export function buildSessionPermissionUpdates(toolName: string): PermissionUpdate[] {
  return [{ behavior: "allow", rules: [{ toolName }], type: "addRules" }];
}

/**
 * Legacy v3 (session-mapper and the broker's v3 reverse RPC) does not understand session semantics:
 * the old desktop returns the option response verbatim, so presenting a session option would amount
 * to a misleading "allow once." Therefore both strategies reduce to removing "always allow" on legacy.
 */
export function toLegacyPermissionOptionsPolicy(policy: unknown): "no-always-allow" | undefined {
  switch (policy) {
    case "no-always-allow":
    case "session-always-allow":
      return "no-always-allow";
    default:
      return undefined;
  }
}

function defaultPermissionUpdates(source: PermissionOptionSource): PermissionUpdate[] {
  const ruleContent = ruleContentFromPermissionInput(source.input);
  return [
    {
      behavior: "allow",
      rules: [
        {
          toolName: source.toolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
      type: "addRules",
    },
  ];
}

function ruleContentFromPermissionInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) {
    return input;
  }

  const record = asRecord(input);
  for (const key of PROJECT_RULE_INPUT_KEYS) {
    const value = stringField(record, key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
