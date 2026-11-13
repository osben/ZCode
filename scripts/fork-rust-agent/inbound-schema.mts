// Generates zcode-rs's inbound schema (packages/rust-cli/crates/protocol-zcode/schema/inbound.json) from the App's
// zod schemas, with the conversion the upstream generator used (`z.toJSONSchema(schema, { io: "input" })`). The
// upstream generator is not in this repository, so the whole file is generated here: every v4 command payload, the
// `v4/command` envelope (its `type` enum gates a command before its payload), the CAS command lists, the method
// params zcode-rs validates and the reply schemas (specs/fork-rust-agent-parity.md "Inbound schema").
//
//   pnpm exec tsx scripts/fork-rust-agent/inbound-schema.mts          # rewrite
//   pnpm rust-agent:inbound-schema:check                         # fail when out of date (CI, pre-push)
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  zcodeMcpListParamsSchema,
  zcodeMcpReadResourceParamsSchema,
  zcodeProviderRefreshRegistryParamsSchema,
  zcodeProviderRuntimeHeadersResponseSchema,
  zcodeProviderUpdateAccountConfigParamsSchema,
  zcodeRuntimeCapabilitiesParamsSchema,
  zcodeSessionCloseParamsSchema,
  zcodeSessionListParamsSchema,
  zcodeSessionReadParamsSchema,
  zcodeWorkspaceHookTrustGrantParamsSchema,
  zcodeWorkspaceMcpTrustParamsSchema,
  zcodeWorkspaceReadPresentationParamsSchema,
  zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
  zcodeWorkspaceUpdateInteractionPreferencesParamsSchema,
  zcodeWorkspaceUpdateModelIoPreferencesParamsSchema,
  zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema,
} from "../../packages/shared/src/zcode-protocol/index.ts";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  commandEnvelopeSchema,
  commandPayloadSchemas,
  commandsQueryParamsSchema,
} from "../../packages/shared/src/zcode-protocol-v4/command.ts";
import { sessionsIndexReconcileParamsSchema } from "../../packages/shared/src/zcode-protocol-v4/sessions-index.ts";
import { credentialCipherReplySchema } from "../../packages/shared/src/validation.ts";
import {
  v4ConnectionFlowParamsSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationSubscribeParamsSchema,
  v4ConversationUnsubscribeParamsSchema,
} from "../../packages/shared/src/zcode-protocol-v4/transport.ts";

// The methods whose params zcode-rs validates; a method not listed here is not checked.
const METHODS = {
  "mcp/list": zcodeMcpListParamsSchema,
  "mcp/readResource": zcodeMcpReadResourceParamsSchema,
  "provider/refreshRegistry": zcodeProviderRefreshRegistryParamsSchema,
  "provider/updateAccountConfig": zcodeProviderUpdateAccountConfigParamsSchema,
  "runtime/capabilities": zcodeRuntimeCapabilitiesParamsSchema,
  "session/close": zcodeSessionCloseParamsSchema,
  "session/list": zcodeSessionListParamsSchema,
  "session/read": zcodeSessionReadParamsSchema,
  "v4/command": commandEnvelopeSchema,
  "v4/commands/query": commandsQueryParamsSchema,
  "v4/connection/flow": v4ConnectionFlowParamsSchema,
  "v4/conversation/resync": v4ConversationResyncParamsSchema,
  "v4/conversation/subscribe": v4ConversationSubscribeParamsSchema,
  "v4/conversation/unsubscribe": v4ConversationUnsubscribeParamsSchema,
  "v4/sessionsIndex/reconcile": sessionsIndexReconcileParamsSchema,
  "workspace/hooks/trustGrant": zcodeWorkspaceHookTrustGrantParamsSchema,
  "workspace/mcp/trust": zcodeWorkspaceMcpTrustParamsSchema,
  "workspace/readPresentation": zcodeWorkspaceReadPresentationParamsSchema,
  "workspace/updateDynamicWorkflowPolicy": zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
  "workspace/updateInteractionPreferences": zcodeWorkspaceUpdateInteractionPreferencesParamsSchema,
  "workspace/updateModelIoPreferences": zcodeWorkspaceUpdateModelIoPreferencesParamsSchema,
  "workspace/updateOffPeakToolPolicy": zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema,
};
// Replies to the agent's own requests that zcode-rs validates.
const REPLIES = {
  "interaction/requestProviderRuntimeHeaders": zcodeProviderRuntimeHeadersResponseSchema,
  // Desktop credentials: the Host's answer to the Rust agent's encrypt/decrypt request (specs/fork-rust-credential-cipher.md).
  "interaction/requestCredentialCipher": credentialCipherReplySchema,
};

const schemaPath = fileURLToPath(
  new URL("../../packages/rust-cli/crates/protocol-zcode/schema/inbound.json", import.meta.url),
);
// zod from the package that owns the schemas, so the converter and the schemas are one instance.
const { z } = createRequire(
  fileURLToPath(new URL("../../packages/shared/package.json", import.meta.url)),
)("zod") as typeof import("zod");

const json = (schema: Parameters<typeof z.toJSONSchema>[0]) =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
const byName = <T,>(entries: [string, T][]) =>
  Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const data = {
  methods: byName(Object.entries(METHODS).map(([name, schema]) => [name, json(schema)])),
  commands: byName(
    Object.entries(commandPayloadSchemas).map(([name, schema]) => [name, json(schema)]),
  ),
  requiresBaseRevision: [...COMMANDS_REQUIRING_BASE_REVISION].sort(),
  requiresBaseLogEpoch: [...ROW_TARGETING_COMMANDS].sort(),
  replies: byName(Object.entries(REPLIES).map(([name, schema]) => [name, json(schema)])),
};
const next = `${JSON.stringify(data, null, 2)}\n`;
const current = await readFile(schemaPath, "utf8");

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error(
      `${schemaPath} is out of date: run pnpm exec tsx scripts/fork-rust-agent/inbound-schema.mts`,
    );
    process.exit(1);
  }
} else if (next !== current) {
  await writeFile(schemaPath, next);
}
