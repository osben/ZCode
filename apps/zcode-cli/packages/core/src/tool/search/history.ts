import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  LOCAL_TOOL_SEARCH_NAME,
  TOOL_SEARCH_NAME,
  isToolSearchName,
  toolSearchNameForMode,
  type CompactBoundaryPayload,
  type ModelMessageContentBlock,
  type ModelToolContract,
  type ResolvedToolSearchMode,
} from "@zcode/contracts";
import {
  createLocalToolDefinitionRenderer,
  localToolsAlreadyLoadedReminder,
  localToolsLoadedReminder,
} from "./local-projection.js";
import { renderToolSearchAnnouncement } from "./description.js";

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

export function projectToolReferences(
  entries: readonly RuntimeMessageEntry[],
  mode: ResolvedToolSearchMode,
  tools: readonly ModelToolContract[],
  deferred: ReadonlySet<string> = new Set(),
): { entries: RuntimeMessageEntry[]; loadedToolCallIds: ReadonlySet<string> } {
  const catalog =
    mode === "off"
      ? undefined
      : buildProjectionCatalog(tools, toolSearchNameForMode(mode));
  const renderDefinition = mode === "local" ? createLocalToolDefinitionRenderer() : undefined;
  // 同批结果尚未被模型看到：直到下一条 assistant 才合入已交付集合，避免并行搜索互相去重。
  const visible = mode === "local" ? new Set<string>() : undefined;
  const pending = mode === "local" ? new Set<string>() : undefined;
  const projected: RuntimeMessageEntry[] = [];
  const loadedToolCallIds = new Set<string>();
  for (const sourceEntry of entries) {
    if (pending && sourceEntry.kind !== "attachment" && sourceEntry.message.role === "assistant") {
      for (const name of pending) visible!.add(name);
      pending.clear();
    }
    if (mode === "off" && sourceEntry.metadata?.toolSearchAnnouncement) continue;
    // 请求副本才使用当前模式名称；历史行保持原样，不能为了一种模式迁移存储。
    const entry = mode === "off" ? sourceEntry : projectSearchNames(sourceEntry, mode);
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
    const successfulSearch =
      isToolSearchName(entry.message.toolName ?? "") && !entry.message.isError;
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
      const tool = catalog?.get(block.toolName);
      if (tool && !renderDefinition) {
        // 结果外的成功提示仅用于 Native；Local 已在结果内给出加载和调用指引。
        if (successfulSearch && entry.message.toolCallId)
          loadedToolCallIds.add(entry.message.toolCallId);
        // 别名引用写回注册表规范名称，与执行入口解析保持一致。
        if (tool.name !== block.toolName) {
          content ??= original.slice(0, index);
          content.push({ ...block, toolName: tool.name });
        } else {
          content?.push(block);
        }
        continue;
      }
      // 仅在引用确实被移除/展开时复制；普通结果与有效 Native 引用直接共享原历史。
      content ??= original.slice(0, index);
      if (tool && renderDefinition) {
        if (successfulSearch && deferred.has(tool.name) && visible!.has(tool.name)) {
          (alreadyLoaded ??= new Set()).add(tool.name);
        } else {
          (definitions ??= []).push(renderDefinition(tool));
          // 常驻及 compact 提升工具仍直接调用，不能混入包装调用的首搜指引。
          if (successfulSearch && deferred.has(tool.name))
            (newlyLoaded ??= new Set()).add(tool.name);
        }
        if (successfulSearch) pending!.add(tool.name);
      }
      // 被删除的引用不切断连续段，保持原来“先过滤再展开”的合并语义。
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

// Both search names resolve to the mode's search definition, as the registry alias does at execution time.
function buildProjectionCatalog(
  tools: readonly ModelToolContract[],
  searchName: string,
): Map<string, ModelToolContract> {
  const catalog = new Map(tools.map((tool) => [tool.name, tool]));
  const search = catalog.get(searchName);
  if (search) {
    catalog.set(TOOL_SEARCH_NAME, search);
    catalog.set(LOCAL_TOOL_SEARCH_NAME, search);
  }
  return catalog;
}

// Announcements are re-rendered from metadata, and tool-call names are rewritten only in the request copy.
function projectSearchNames(
  entry: RuntimeMessageEntry,
  mode: ResolvedToolSearchMode,
): RuntimeMessageEntry {
  if (entry.kind === "attachment") {
    const delta = entry.metadata.toolSearchAnnouncement;
    if (!delta) return entry;
    const content = renderToolSearchAnnouncement(delta, mode);
    return content === entry.content ? entry : { ...entry, content };
  }
  const searchName = toolSearchNameForMode(mode);
  const message = entry.message;
  const renameTool =
    message.toolName !== undefined &&
    isToolSearchName(message.toolName) &&
    message.toolName !== searchName;
  const renameCalls =
    message.toolCalls?.some((call) => isToolSearchName(call.name) && call.name !== searchName) ===
    true;
  if (!renameTool && !renameCalls) return entry;
  return {
    ...entry,
    message: {
      ...message,
      ...(renameTool ? { toolName: searchName } : {}),
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

function localDefinitionsBlock(definitions: readonly string[]): ModelMessageContentBlock {
  return { type: "text", text: `<functions>\n${definitions.join("\n")}\n</functions>` };
}
