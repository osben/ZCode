import {
  isToolSearchName,
  toolSearchNameForMode,
  TOOL_SEARCH_NAME,
  LOCAL_TOOL_SEARCH_NAME,
} from "@zcode/contracts";
import { renderToolSearchAnnouncement } from "./description.js";
import type { RuntimeMessageEntry, RuntimeMessageMetadata } from "../../agent/message-history.js";
import type {
  CompactBoundaryPayload,
  ModelMessageContentBlock,
  ModelToolContract,
  ResolvedToolSearchMode,
  ToolSearchDelivery,
} from "@zcode/contracts";
import {
  createLocalToolDefinitionRenderer,
  localToolsAlreadyLoadedReminder,
  localToolsLoadedReminder,
} from "./local-projection.js";

const NO_NAME_CHANGES = { addedNames: [], removedNames: [], readdedNames: [] } as const;

/**
 * ToolSearch 公告的唯一识别：严格的名称增量与宽松的 MCP 状态有其一。
 * 只有状态的公告不写名称增量（旧版本按三个空数组重渲染会得到空正文并报错），
 * 所以 off 隐藏、重渲染、空正文过滤、冷恢复和状态累积都只读这个判定。
 */
export function isToolSearchAnnouncementMetadata(
  metadata:
    | Pick<RuntimeMessageMetadata, "toolSearchAnnouncement" | "toolSearchMcpDelta">
    | undefined,
): boolean {
  return Boolean(metadata?.toolSearchAnnouncement || metadata?.toolSearchMcpDelta);
}

export function compactDiscoveryMetadata(
  boundary: Pick<CompactBoundaryPayload, "boundaryId" | "preCompactDiscoveredTools">,
) {
  return {
    boundaryId: boundary.boundaryId,
    preCompactDiscoveredTools: [...(boundary.preCompactDiscoveredTools ?? [])],
  };
}

export function collectToolSearchHistory(entries: readonly RuntimeMessageEntry[]) {
  const discovered = new Set<string>();
  const preCompactDiscoveredTools = new Set<string>();
  for (const entry of entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? []) {
      discovered.add(name);
      preCompactDiscoveredTools.add(name);
    }
    if (entry.kind === "attachment" || entry.message.role !== "tool" || entry.message.isError)
      continue;
    if (!Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_reference") discovered.add(block.toolName);
    }
  }
  return { discovered, preCompactDiscoveredTools };
}

export function collectDiscoveredTools(entries: readonly RuntimeMessageEntry[]): Set<string> {
  return collectToolSearchHistory(entries).discovered;
}

export function toolReferenceKey(toolCallId: string, toolName: string): string {
  return JSON.stringify([toolCallId, toolName]);
}

/** 历史记录是唯一持久事实；索引仅用于本次投影，不保存第二份工具目录。 */
export function collectToolSearchDelivery(entries: readonly RuntimeMessageEntry[]) {
  const definitions = new Map<string, ToolSearchDelivery["definitions"][number]>();
  const stripped = new Map<string, ToolSearchDelivery["strippedReferences"][number]>();
  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    for (const definition of entry.toolSearchDelivery?.definitions ?? [])
      definitions.set(definition.tool.name, definition);
    for (const reference of entry.toolSearchDelivery?.strippedReferences ?? [])
      stripped.set(toolReferenceKey(reference.toolCallId, reference.toolName), reference);
  }
  const references = entries.flatMap((entry) => {
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "tool" ||
      entry.message.isError ||
      !Array.isArray(entry.message.content)
    )
      return [];
    return entry.message.content.flatMap((block) =>
      block.type === "tool_reference"
        ? [{ toolCallId: entry.message.toolCallId ?? "", toolName: block.toolName }]
        : [],
    );
  });
  const retained = new Map<string, ToolSearchDelivery["definitions"][number]>();
  for (const reference of references) {
    const definition = definitions.get(reference.toolName);
    if (definition && !stripped.has(toolReferenceKey(reference.toolCallId, reference.toolName)))
      retained.set(reference.toolName, definition);
  }
  return { definitions, stripped, references, retained };
}

/** compact 后仍保留的撤销：只有 not_configured 的工具继续原位声明。 */
const COMPACT_KEPT_RETRACTION_CAUSE = "not_configured";

export function compactToolSearchDelivery(
  entries: readonly RuntimeMessageEntry[],
  preserved: readonly RuntimeMessageEntry[],
  isAvailable: (name: string) => boolean = () => true,
): ToolSearchDelivery | undefined {
  const history = collectToolSearchDelivery(entries);
  const tail = collectToolSearchDelivery(preserved);
  const names = new Set(tail.references.map((reference) => reference.toolName));
  const keys = new Set(
    tail.references.map((reference) => toolReferenceKey(reference.toolCallId, reference.toolName)),
  );
  const retracted = new Map<string, string>();
  for (const entry of entries) {
    const delta = entry.metadata?.toolSearchMcpDelta;
    for (const item of delta?.retractedTools ?? []) retracted.set(item.name, item.cause);
    for (const name of delta?.restoredNames ?? []) retracted.delete(name);
  }
  // 已离开的常驻记录跨 compact 继续原位声明，已撤销的除外（not_configured 照样携带）；
  // 仍在目录中的常驻记录不携带，compact 后首个请求按 live 定义重新记录。
  const departedResident = ({ tool, mcp }: ToolSearchDelivery["definitions"][number]) =>
    mcp !== undefined &&
    !history.retained.has(tool.name) &&
    !isAvailable(tool.name) &&
    (retracted.get(tool.name) ?? COMPACT_KEPT_RETRACTION_CAUSE) === COMPACT_KEPT_RETRACTION_CAUSE;
  const definitions = [...history.definitions.values()].filter(
    (definition) => names.has(definition.tool.name) || departedResident(definition),
  );
  const strippedReferences = [...history.stripped]
    .filter(([key]) => keys.has(key))
    .map(([, reference]) => reference);
  return definitions.length || strippedReferences.length
    ? { definitions, strippedReferences }
    : undefined;
}

export function projectToolReferences(
  entries: readonly RuntimeMessageEntry[],
  mode: ResolvedToolSearchMode,
  tools: readonly ModelToolContract[],
  deferred: ReadonlySet<string> = new Set(),
  hideAnnouncements = mode === "off",
  strippedReferences: ReadonlySet<string> = new Set(),
): { entries: RuntimeMessageEntry[]; loadedToolCallIds: ReadonlySet<string> } {
  const catalog = mode === "off" ? undefined : new Map(tools.map((tool) => [tool.name, tool]));
  const searchName = toolSearchNameForMode(mode);
  const searchTool = catalog?.get(searchName);
  if (searchTool) {
    catalog!.set(TOOL_SEARCH_NAME, searchTool);
    catalog!.set(LOCAL_TOOL_SEARCH_NAME, searchTool);
  }
  const renderDefinition = mode === "local" ? createLocalToolDefinitionRenderer() : undefined;
  // Results from the same batch have not been seen by the model yet: they join the delivered set only at the next assistant message, so parallel searches do not dedupe each other.
  const visible = mode === "local" ? new Set<string>() : undefined;
  const pending = mode === "local" ? new Set<string>() : undefined;
  const projected: RuntimeMessageEntry[] = [];
  const loadedToolCallIds = new Set<string>();
  for (const originalEntry of entries) {
    let entry = originalEntry;
    if (pending && entry.kind !== "attachment" && entry.message.role === "assistant") {
      for (const name of pending) visible!.add(name);
      pending.clear();
    }
    // Announcements are hidden only when the request mode is off; an emptied catalog or temporarily unavailable control tools must not rewrite an announcement already sent.
    if (hideAnnouncements && isToolSearchAnnouncementMetadata(entry.metadata)) continue;
    // A session can switch modes; names are rewritten in pairs only in the request copy, without polluting the original history or the request being sent.
    if (mode !== "off") {
      if (entry.kind === "attachment") {
        if (isToolSearchAnnouncementMetadata(entry.metadata)) {
          const content = renderToolSearchAnnouncement(
            entry.metadata.toolSearchAnnouncement ?? NO_NAME_CHANGES,
            mode,
            entry.metadata.toolSearchHiddenNames,
            entry.metadata.toolSearchMcpDelta,
          );
          if (content !== entry.content) entry = { ...entry, content };
        }
      } else {
        const message = entry.message;
        const renameResult = isToolSearchName(message.toolName) && message.toolName !== searchName;
        const renameCalls = message.toolCalls?.some(
          (call) => isToolSearchName(call.name) && call.name !== searchName,
        );
        if (renameResult || renameCalls)
          entry = {
            ...entry,
            message: {
              ...message,
              ...(renameResult ? { toolName: searchName } : {}),
              ...(renameCalls
                ? {
                    toolCalls: message.toolCalls!.map((call) =>
                      isToolSearchName(call.name) ? { ...call, name: searchName } : call,
                    ),
                  }
                : {}),
            },
          };
      }
    }
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "tool" ||
      !Array.isArray(entry.message.content)
    ) {
      projected.push(entry);
      continue;
    }
    const original = entry.message.content;
    let content: ModelMessageContentBlock[] | undefined;
    let definitions: string[] | undefined;
    let alreadyLoaded: Set<string> | undefined;
    let newlyLoaded: Set<string> | undefined;
    const successfulSearch = isToolSearchName(entry.message.toolName) && !entry.message.isError;
    for (let index = 0; index < original.length; index++) {
      const block = original[index]!;
      if (block.type !== "tool_reference") {
        if (definitions) {
          content!.push(localDefinitionsBlock(definitions));
          definitions = undefined;
        }
        content?.push(block);
        continue;
      }
      const tool = strippedReferences.has(
        toolReferenceKey(entry.message.toolCallId ?? "", block.toolName),
      )
        ? undefined
        : catalog?.get(block.toolName);
      if (tool && !renderDefinition) {
        // The success hint outside the result is used only by Native; Local already gives loading and calling guidance inside the result.
        if (successfulSearch && entry.message.toolCallId)
          loadedToolCallIds.add(entry.message.toolCallId);
        if (tool.name !== block.toolName) {
          content ??= original.slice(0, index);
          content.push({ ...block, toolName: tool.name });
        } else content?.push(block);
        continue;
      }
      // Copy only when a reference is actually removed or expanded; ordinary results and valid Native references share the original history directly.
      content ??= original.slice(0, index);
      if (tool && renderDefinition) {
        if (successfulSearch && deferred.has(tool.name) && visible!.has(tool.name)) {
          (alreadyLoaded ??= new Set()).add(tool.name);
        } else {
          (definitions ??= []).push(renderDefinition(tool));
          // Resident and compact-promoted tools are still called directly; they must not be mixed into the first-search guidance for wrapped calls.
          if (successfulSearch && deferred.has(tool.name))
            (newlyLoaded ??= new Set()).add(tool.name);
        }
        if (successfulSearch) pending!.add(tool.name);
      }
      // A removed reference does not break the contiguous run, keeping the original "filter first, then expand" merge semantics.
    }
    if (definitions) content!.push(localDefinitionsBlock(definitions));
    if (newlyLoaded)
      content!.push({ type: "text", text: localToolsLoadedReminder([...newlyLoaded]) });
    if (alreadyLoaded)
      content!.push({ type: "text", text: localToolsAlreadyLoadedReminder([...alreadyLoaded]) });
    projected.push(
      content === undefined
        ? entry
        : {
            ...entry,
            message: {
              ...entry.message,
              content: content.length
                ? content
                : [
                    {
                      type: "text",
                      text:
                        mode === "off"
                          ? "[Tool references removed - tool search not enabled]"
                          : "[Tool references removed - tools no longer available]",
                    },
                  ],
            },
          },
    );
  }
  return { entries: projected, loadedToolCallIds };
}

function localDefinitionsBlock(definitions: readonly string[]): ModelMessageContentBlock {
  return { type: "text", text: `<functions>\n${definitions.join("\n")}\n</functions>` };
}

/** Announcement hidden names are a lenient field: cold resume keeps only the strings listed in the announcement removedNames and ignores the rest. */
export function parseToolSearchHiddenNames(
  value: unknown,
  announcement: { removedNames: readonly string[] },
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const removed = new Set(announcement.removedNames);
  const names = value.filter(
    (name): name is string => typeof name === "string" && removed.has(name),
  );
  return names.length ? names : undefined;
}
