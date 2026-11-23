// MCP tool bridge - projects MCP descriptors into core tool entries

import {
  modelMessageContentToText,
  resolveMcpToolVisibility,
  SessionEventType,
  ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  ZCODE_MCP_ERROR_PRESENTATION_META_KEY,
  type JsonSchema,
  type McpPort,
  type McpToolCallResult,
  type McpToolDescriptor,
  type McpToolDefinition,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ModelToolSideEffectScope,
  type PermissionCapabilityGroup,
  type RiskLevel,
  type SessionEvent,
  type ToolCallProgressPayload,
} from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME as ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME } from "@zcode/shared";
import { OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION } from "@zcode/zcode-cua/frame-contract";
import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../tool/registry.js";
import { createToolRuleNameSet } from "../tool/tool-visibility.js";
import type { ToolEntry } from "../tool/types.js";
import {
  asDataUrl,
  base64PayloadFromMcpImageData,
  normalizeMcpToolResultForModel,
} from "./image-normalization.js";
import { toMcpToolName, toModelVisibleMcpNamePart } from "./name.js";

export {
  createMcpAppProvidedToolEntry,
  MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS,
  type McpAppProvidedToolDefinition,
  type McpAppProvidedToolExecutor,
} from "./app-tools.js";
export { toMcpToolName } from "./name.js";

export {
  HOST_NODE_REPL_IMAGE_MAX_DIMENSION,
  MCP_IMAGE_INLINE_BASE64_BYTES,
  MCP_IMAGE_INLINE_RAW_BYTES,
} from "./image-normalization.js";

const MCP_TOOL_TIMEOUT_MS = 30_000;
const OFFICIAL_CUA_PERMISSION_CAPABILITY_GROUP = "official_cua" satisfies PermissionCapabilityGroup;
const CUA_USER_TITLE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description:
    "Required short user-facing title in the user's language that describes why the app interface is being read without implementation terms such as CUA, MCP, or get_app_state",
} satisfies JsonSchema;
export const ZCODE_CUA_CANONICAL_MODEL_PREFIX = "mcp__computer-use__";
const ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX = "mcp__computer_use__";

export interface ResolvedMcpTool {
  descriptor: McpToolDescriptor;
  /** 权限或 hook 等待之后复查目标；返回不可用原因，仍可调用时返回 undefined。 */
  checkTarget(): string | undefined;
  /** 调用失败后复查：server 正等待或需要用户授权时返回固定原因，否则返回 undefined。 */
  authorizationReason(): string | undefined;
}

export type McpToolResolution = ResolvedMcpTool | { unavailableReason: string };

/** 执行准入与 handler 共用的不可用文本；不带原因时只报工具名。 */
function unavailableToolMessage(name: string, reason?: string): string {
  return `MCP tool is unavailable in the current session: ${name}${reason ? `. ${reason}` : ""}`;
}

function unavailableToolError(name: string, reason: string): Error {
  return new Error(unavailableToolMessage(name, reason));
}

export interface RegisterMcpToolsOptions {
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /**
   * Official CUA server validated by the runtime using unforgeable product-authority credentials.
   * The name alone does not establish trust; if omitted, fail closed and treat every MCP as an ordinary tool,
   * without projecting official CUA canonical names or attaching provider spelling aliases.
   */
  officialCuaServerNames?: ReadonlySet<string>;
  /** advertisement cache 命中时，执行前解析当前 session 的 live descriptor。 */
  resolveLiveDescriptor?: (
    descriptor: McpToolDefinition,
    signal?: AbortSignal,
  ) => Promise<McpToolResolution | undefined>;
  /**
   * Namespaced server name → stable plugin ID, from the PluginReferenceCatalog frozen for this session.
   * Used only to project ownership into display.ui; if absent, this server's tools do not project UI.
   */
  pluginIdByServerName?: ReadonlyMap<string, string>;
}

export function registerMcpTools(
  registry: ToolRegistry,
  mcpPort: McpPort,
  descriptors: readonly McpToolDefinition[],
  options: RegisterMcpToolsOptions = {},
): string[] {
  const registered: string[] = [];
  for (const { name, descriptor, officialCuaAuthorityVerified } of selectMcpTools(
    descriptors,
    options,
  )) {
    registry.register(
      createMcpToolEntry(
        name,
        descriptor,
        mcpPort,
        officialCuaAuthorityVerified,
        { pluginId: options.pluginIdByServerName?.get(descriptor.serverName) },
        options.resolveLiveDescriptor,
      ),
    );
    registered.push(name);
  }
  return registered;
}

/** 执行注册和实时搜索共用名称、别名及权限准入；搜索不创建执行 handler。 */
export function* selectMcpTools(
  descriptors: readonly McpToolDefinition[],
  options: RegisterMcpToolsOptions = {},
) {
  const allowed = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowed = createToolRuleNameSet(options.disallowedTools);
  for (const descriptor of descriptors) {
    const officialCuaAuthorityVerified =
      options.officialCuaServerNames?.has(descriptor.serverName) === true;
    const descriptorName = toMcpToolName(descriptor);
    const name = toRegisteredMcpToolName(descriptor, officialCuaAuthorityVerified);
    // Deny if either the old or new name matches deny, accept if either matches allow; search must not loosen this.
    if (allowed && !allowed.has(name) && !allowed.has(descriptorName)) continue;
    if (disallowed?.has(name) || disallowed?.has(descriptorName)) continue;
    yield {
      name,
      descriptor,
      officialCuaAuthorityVerified,
      aliases: officialCuaProviderSpellingAliases(name, descriptor, officialCuaAuthorityVerified),
    };
  }
}

function toRegisteredMcpToolName(
  descriptor: McpToolDefinition,
  officialCuaAuthorityVerified: boolean,
): string {
  if (
    officialCuaAuthorityVerified &&
    descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME
  ) {
    // The adapter namespaces the official plugin serverName, so descriptor.name is
    // mcp__plugin_zcode-cua_computer-use__*; using it directly would mean the provider's expected computer-use
    // tools never exist. Once the trust gate passes, project only the model-visible name; the handler keeps the descriptor's original route.
    return `${ZCODE_CUA_CANONICAL_MODEL_PREFIX}${toModelVisibleMcpNamePart(descriptor.toolName)}`;
  }
  return toMcpToolName(descriptor);
}

export function createMcpToolEntry(
  name: string,
  descriptor: McpToolDefinition,
  mcpPort: McpPort,
  officialCuaAuthorityVerified: boolean,
  presentation: { pluginId?: string } = {},
  resolveLiveDescriptor?: RegisterMcpToolsOptions["resolveLiveDescriptor"],
  target?: ResolvedMcpTool,
): ToolEntry {
  const readOnly = descriptor.annotations?.readOnlyHint === true;
  // The cache carries no execution annotations, so schedule as possibly destructive; unknown must not be treated as false.
  const destructive =
    descriptor.catalogOnly === true || descriptor.annotations?.destructiveHint === true;
  // Plugin UI: tools whose visibility excludes "model" are available only through UI callbacks (mcp/uiCallTool).
  // Keep them in the registry to reuse metadata, but omit them from provider contracts (registry.toContracts filters providerVisible=false).
  // Fix: previously only ui.visibility was checked, so app-only data tools without a resourceUri were incorrectly exposed to the model.
  const providerVisible = resolveMcpToolVisibility(descriptor).includes("model");
  const isHostNodeReplExecution =
    descriptor.serverName === "node_repl" && descriptor.toolName === "js";
  const isCuaAppObservation = isZCodeCuaGetAppState(descriptor);
  // The host node_repl js can execute local Node code, so it must not inherit the medium/network default for ordinary unknown MCPs;
  // otherwise the permission UI would misdescribe filesystem/process capabilities as ordinary network calls.
  const sideEffectScope: ModelToolSideEffectScope = isHostNodeReplExecution ? "system" : "network";
  const riskLevel: RiskLevel = isHostNodeReplExecution
    ? "high"
    : destructive
      ? "high"
      : readOnly
        ? "low"
        : "medium";
  const needsApproval = true;
  const timeoutMs = descriptor.timeoutMs ?? MCP_TOOL_TIMEOUT_MS;
  const resultBudget = officialCuaAuthorityVerified
    ? {
        // Base64 in image blocks does not count toward the model text budget, but tree text may still exceed the ordinary MCP
        // 50 KiB limit. Give official CUA enough bounded text space so generic truncation does not degrade structured
        // image/image_ref blocks into plain strings or change their adjacency.
        maxInlineBytes: 256 * 1024,
        maxModelBytes: 256 * 1024,
        strategy: "truncate" as const,
        preview: { direction: "head" as const },
      }
    : isHostNodeReplExecution
      ? {
          maxInlineBytes: 1_000_000,
          maxModelBytes: 64 * 1024,
          strategy: "artifact" as const,
          preview: { direction: "tail" as const, maxBytes: 64 * 1024 },
          artifact: { enabled: true, retention: "session" as const },
        }
      : {
          maxInlineBytes: 100_000,
          maxModelBytes: 50_000,
          strategy: "truncate" as const,
          preview: { direction: "head" as const },
        };

  const entry: ToolEntry = {
    // Exact lookup returned Tool not found. Add a one-way alias only when the unforgeable official-authority gate passes and the internal
    // serverName is still the official namespaced name; the provider continues to see only the canonical name.
    aliases: officialCuaProviderSpellingAliases(name, descriptor, officialCuaAuthorityVerified),
    capability: `MCP tool exposed by ${descriptor.serverName}: ${descriptor.toolName}`,
    // Project-level CUA authorization must reuse the unforgeable official-authority gate.
    // Server/tool names can be spoofed by third parties, so never express this permission with a name wildcard.
    ...(officialCuaAuthorityVerified
      ? {
          permissionCapabilityGroup: OFFICIAL_CUA_PERMISSION_CAPABILITY_GROUP,
          // The final raster and immediately following image_ref together define the only pixel coordinate system available to the model.
          // modelContentProtection is the sole Host authority; generic resultBudget / hook
          // projections cannot truncate, discard, or reorder these blocks, avoiding drift between parallel booleans.
          modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
        }
      : {}),
    inputSchema: createModelFacingMcpInputSchema(descriptor, isCuaAppObservation),
    outputSchema: McpToolOutputJsonSchema,
    metadata: {
      shouldDefer: true,
      alwaysLoad: descriptor.alwaysLoad,
      searchHint: descriptor.searchHint,
      concurrentSafe: readOnly || descriptor.annotations?.idempotentHint === true,
      destructive,
      // Pass the MCP tool description through to metadata so the registry includes it in model input;
      // otherwise the model sees only name + inputSchema and lacks context for calling the MCP tool.
      description: descriptor.description,
      name,
      mcpPresentation: {
        serverName: descriptor.serverName,
        toolName: descriptor.toolName,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        // Only results from official MCPs may carry structured identifiers trusted by the client (quota exhausted / no plan).
        ...(descriptor.official ? { official: true } : {}),
        ...(presentation.pluginId ? { pluginId: presentation.pluginId } : {}),
        ...(descriptor.ui ? { ui: descriptor.ui } : {}),
      },
      needsApproval,
      ...(providerVisible ? {} : { providerVisible: false }),
      readOnly,
      riskLevel,
      sideEffectScope,
      timeoutMs,
    },
    permission: {
      permission: "mcp",
      reason: `MCP tool ${descriptor.serverName}/${descriptor.toolName} executes through an external server`,
      riskLevel,
      sideEffectScope,
      needsApproval,
      patternSources: ["toolName", "input", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget,
    timeout: {
      defaultMs: timeoutMs,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `MCP tool ${name} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    handler: async (input, context) => {
      // 权限/hook 可异步等待；准入之后配置被替换、连接不可用或工具已下线时不能继承这次授权。
      if (descriptor.catalogOnly) throw new Error(`MCP tool is unavailable: ${name}`);
      const unavailable = target?.checkTarget();
      if (unavailable) throw unavailableToolError(name, unavailable);
      const startedAt = Date.now();
      const result = await mcpPort
        .callTool(
          {
            serverName: descriptor.serverName,
            toolName: descriptor.toolName,
            arguments: toMcpRuntimeArguments(input, isCuaAppObservation),
            trace: {
              traceId: context.traceId,
              spanId: context.spanId,
              parentSpanId: context.parentSpanId,
              sessionId: context.sessionId,
              turnId: context.turnId,
            },
            runtimeScope: context.runtimeScope ?? "main",
            workspacePath: context.workingDirectory,
            ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
            ...(context.workspaceIdentity?.trim()
              ? { workspaceIdentity: context.workspaceIdentity.trim() }
              : {}),
            // Fix reason: local sessions used to always key by working directory; a managed worktree session's working directory is the worktree,
            // so the Host's key-isolated MCP could not find the owning project. The session key is supplied by the protocol entry (docs/git/worktree.md §9.3).
            workspaceKey:
              context.workspaceKey ??
              (context.workspaceIdentity?.trim() || context.workingDirectory),
            ...(context.turnId ? { turnId: context.turnId } : {}),
            clientMode: context.clientMode ?? "desktop-continuous",
            deliveryKind: context.deliveryKind ?? "desktop-continuous",
          },
          {
            signal: context.abortSignal,
            timeoutMs,
            // MCP progress notifications (A8) → ToolCallProgress: use the same event as Bash output progress, so the UI uses its existing tool-row progress path.
            ...(context.emitEvent
              ? {
                  onProgress: (progress: {
                    progress: number;
                    total?: number;
                    message?: string;
                  }) => {
                    void context.emitEvent?.(
                      createMcpProgressEvent(context, name, startedAt, progress),
                    );
                  },
                }
              : {}),
          },
        )
        .catch((error: unknown) => {
          // Fix reason: a 401 during the call makes the adapter start authorization, and after the link is published the call ends with the raw error;
          // the raw error does not tell the model that user authorization is needed. By then the server is already needs-auth, so use the same fixed text as execution admission.
          // User cancellation is not rewritten; other failures (including exhausted recovery) still return the raw error.
          const authorization = context.abortSignal?.aborted
            ? undefined
            : target?.authorizationReason();
          if (authorization) throw unavailableToolError(name, authorization);
          throw error;
        });
      // MCP servers can return large base64 images, while resultBudget sees only image placeholder text.
      // Save a copy and replace model-visible content in the handler to prevent oversized provider requests.
      return normalizeMcpToolResultForModel({
        compressOversizedImages: isHostNodeReplExecution,
        context,
        descriptor,
        preserveOfficialCuaFrames: officialCuaAuthorityVerified,
        result,
        toolName: name,
      });
    },
    formatModelContent: (output) => formatMcpToolResult(output),
  };
  if (resolveLiveDescriptor) {
    entry.resolveForExecution = async ({ signal }) => {
      const resolved = await resolveLiveDescriptor(descriptor, signal);
      if (resolved && "unavailableReason" in resolved)
        return {
          status: "unavailable",
          message: unavailableToolMessage(name, resolved.unavailableReason),
        };
      const liveDescriptor = resolved?.descriptor;
      // live 名称必须走同一套官方 CUA 投影规则，否则缓存命中的 CUA 工具在执行时会被误判为不可用。
      if (
        !liveDescriptor ||
        toRegisteredMcpToolName(liveDescriptor, officialCuaAuthorityVerified) !== name
      ) {
        return {
          status: "unavailable",
          message: unavailableToolMessage(name),
        };
      }
      const liveEntry = createMcpToolEntry(
        name,
        liveDescriptor,
        mcpPort,
        officialCuaAuthorityVerified,
        presentation,
        undefined,
        resolved,
      );
      // 调度（提前执行、并发分组、可见性）按注册时定义做出；live 定义更严格时，
      // 本次不调用 handler，也不在旧并发组内重试，下一次请求会拿到新定义。
      const stricter = findStricterLiveConstraint(entry, liveEntry);
      if (stricter) {
        return {
          status: "unavailable",
          message: `MCP tool ${name} now has a stricter live ${stricter} constraint than its registered definition; it was not called. Call it again in the next request.`,
        };
      }
      return { status: "ready", entry: liveEntry };
    };
  }
  return entry;
}

// 直接比较两份 entry metadata：未声明 destructiveHint 的注册定义按非破坏性调度，live 改为 true 同样算收紧。
function findStricterLiveConstraint(registered: ToolEntry, live: ToolEntry): string | undefined {
  if (registered.metadata.readOnly && !live.metadata.readOnly) return "readOnly";
  if (registered.metadata.concurrentSafe && !live.metadata.concurrentSafe) return "concurrency";
  if (!registered.metadata.destructive && live.metadata.destructive) return "destructive";
  if (registered.metadata.providerVisible !== false && live.metadata.providerVisible === false) {
    return "visibility";
  }
  return undefined;
}

function createMcpProgressEvent(
  context: Parameters<ToolEntry["handler"]>[1],
  toolName: string,
  startedAt: number,
  progress: { progress: number; total?: number; message?: string },
): SessionEvent {
  const payload: ToolCallProgressPayload = {
    toolCallId: context.toolCallId as ToolCallProgressPayload["toolCallId"],
    toolName,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    progress: progress.progress,
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    ...(progress.message !== undefined ? { message: progress.message } : {}),
  };
  return {
    id: randomUUID() as SessionEvent["id"],
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload,
  };
}

function officialCuaProviderSpellingAliases(
  name: string,
  descriptor: McpToolDefinition,
  officialCuaAuthorityVerified: boolean,
): readonly string[] | undefined {
  if (
    !officialCuaAuthorityVerified ||
    descriptor.serverName !== ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME ||
    !name.startsWith(ZCODE_CUA_CANONICAL_MODEL_PREFIX)
  ) {
    return undefined;
  }
  const toolName = name.slice(ZCODE_CUA_CANONICAL_MODEL_PREFIX.length);
  return toolName.length > 0
    ? [`${ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX}${toolName}`]
    : undefined;
}

export const McpToolOutputJsonSchema = {
  type: "object",
  required: ["content"],
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    structuredContent: {},
    isError: {
      type: "boolean",
    },
    _meta: {
      type: "object",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies JsonSchema;

function normalizeInputSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties:
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {},
  };
}

function createModelFacingMcpInputSchema(
  descriptor: McpToolDefinition,
  isCuaAppObservation: boolean,
): JsonSchema {
  const schema = normalizeInputSchema(descriptor.inputSchema);
  if (!isCuaAppObservation) return schema;

  const properties = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];

  // title is an intent summary shown to the user by ZCode, not an upstream zcode-cua parameter. Add the required field only to the model contract
  // and strip it during runtime dispatch, so the model consistently generates a readable title while remaining compatible with the strict upstream schema.
  return {
    ...schema,
    properties: {
      ...properties,
      title: CUA_USER_TITLE_SCHEMA,
    },
    required: [...new Set([...required, "title"])],
  };
}

function isZCodeCuaGetAppState(
  descriptor: Pick<McpToolDescriptor, "serverName" | "toolName">,
): boolean {
  if (descriptor.toolName.trim().toLowerCase().replace(/-/g, "_") !== "get_app_state") {
    return false;
  }

  const serverName = descriptor.serverName.trim().toLowerCase().replace(/_/g, "-");
  return (
    descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME ||
    serverName === "zcode-cua" ||
    serverName === "computer-use" ||
    (serverName.includes("zcode-cua") && serverName.includes("computer-use"))
  );
}

export function formatMcpToolResult(output: unknown): ModelMessageContent {
  if (!isMcpToolCallResult(output)) {
    return stringify(output);
  }

  const blocks = output.content.flatMap(formatContentBlock);
  // content is the server's representation for the model; fall back to the structured result only when there are no visible blocks, avoiding double-written compatibility output.
  if (blocks.length === 0 && output.structuredContent !== undefined) {
    blocks.push({
      type: "text",
      text: `Structured content:\n${stringify(output.structuredContent)}`,
    });
  }

  const content = blocks.length > 0 ? collapseModelBlocks(blocks) : stringify(output);
  if (!output.isError) return content;
  // The MCP result explicitly declares its display policy; the generic bridge should not identify specific servers
  // or parse error strings to guess which content is a stack trace.
  const errorPresentation = output._meta?.[ZCODE_MCP_ERROR_PRESENTATION_META_KEY];
  return typeof errorPresentation === "string" &&
    errorPresentation === ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY
    ? content
    : `MCP tool returned an error:\n${modelMessageContentToText(content)}`;
}

function formatContentBlock(block: Record<string, unknown>): ModelMessageContentBlock[] {
  if (block.type === "text" && typeof block.text === "string") {
    return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
  }
  if (block.type === "image") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    if (typeof block.data === "string" && typeof block.mimeType === "string") {
      return [
        {
          type: "image",
          mediaType: block.mimeType,
          dataUrl: asDataUrl(block.data, block.mimeType),
          source: {
            id: "mcp-image",
            kind: "inline",
            mimeType: block.mimeType,
            placeholder: "MCP image",
            sizeBytes: estimateBase64Bytes(block.data),
          },
        },
      ];
    }
    return [{ type: "text", text: `[MCP image content omitted: ${mimeType}]` }];
  }
  if (block.type === "audio") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    return [{ type: "text", text: `[MCP audio content omitted: ${mimeType}]` }];
  }
  if (block.type === "resource") {
    return [{ type: "text", text: `MCP resource content:\n${stringify(block.resource ?? block)}` }];
  }
  return [{ type: "text", text: stringify(block) }];
}

function collapseModelBlocks(blocks: ModelMessageContentBlock[]): ModelMessageContent {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n");
  }
  return blocks;
}

function estimateBase64Bytes(value: string): number | undefined {
  const data = base64PayloadFromMcpImageData(value);
  if (data.length === 0) return undefined;
  return Math.floor((data.replace(/=+$/, "").length * 3) / 4);
}

function isMcpToolCallResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as McpToolCallResult).content)
  );
}

function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function toMcpRuntimeArguments(
  input: unknown,
  stripCuaUserTitle: boolean,
): Record<string, unknown> {
  const argumentsRecord = toRecordInput(input);
  if (!stripCuaUserTitle || !("title" in argumentsRecord)) return argumentsRecord;

  const runtimeArguments = { ...argumentsRecord };
  delete runtimeArguments.title;
  return runtimeArguments;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
