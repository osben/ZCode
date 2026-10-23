import {
  DEFERRED_TOOL_CALL_NAME,
  LOCAL_TOOL_SEARCH_NAME,
  TOOL_SEARCH_NAME,
  toolSearchNameForMode,
  type ResolvedToolSearchMode,
} from "@zcode/contracts";

function description(opening: string, callingConvention: string, resultNote: string): string {
  return `${opening}

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. ${callingConvention}

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block${resultNote}

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;
}

export const NATIVE_TOOL_SEARCH_DESCRIPTION = description(
  "Fetches full schema definitions for deferred tools so they can be called.",
  "Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.",
  " — the same encoding as the tool list at the top of this prompt.",
);

// Local 返回的定义描述目标参数，不能把它误读成已注册的直接调用入口。
export const LOCAL_TOOL_SEARCH_DESCRIPTION = `${description(
  "Fetches full schema definitions for deferred tools so they can be called using DeferredToolCall.",
  "Call deferred tools through DeferredToolCall with {name, input}. Call resident tools directly using their normal tool calls, even if their definitions were returned by direct selection.",
  ". For deferred tools, parameters describes the input object passed to DeferredToolCall.",
)}

Example (TodoWrite is deferred and already loaded):
<example>
DeferredToolCall({"name":"TodoWrite","input":{"todos":[{"content":"Inspect the implementation","status":"in_progress","priority":"high"}]}})
</example>`;

const ADDED_TOOLS_NOTICE = `The following deferred tools are now available via ${TOOL_SEARCH_NAME}. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ${TOOL_SEARCH_NAME} with query "select:<name>[,<name>...]" to load tool schemas before calling them:`;
const LOCAL_ADDED_TOOLS_NOTICE = `The following deferred tools are available via ${LOCAL_TOOL_SEARCH_NAME}. Use query "select:<name>[,<name>...]" to load their complete schemas, then call them through ${DEFERRED_TOOL_CALL_NAME} with {name, input}. Call resident tools directly:`;
const MAX_REMOVED_NAME_LINES = 30;
const AMBIENT_CONTEXT_NOTICE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";

export interface ToolSearchAnnouncementDelta {
  readonly addedNames: readonly string[];
  readonly removedNames: readonly string[];
  readonly readdedNames: readonly string[];
}

// Rendered per request from metadata so replayed announcements name the search tool of the current mode.
export function renderToolSearchAnnouncement(
  delta: ToolSearchAnnouncementDelta,
  mode: ResolvedToolSearchMode,
): string {
  const searchName = toolSearchNameForMode(mode);
  const readded = new Set(delta.readdedNames);
  const listedNames = delta.addedNames.filter((name) => !readded.has(name));
  const paragraphs: string[] = [];
  if (listedNames.length)
    paragraphs.push(
      `${mode === "local" ? LOCAL_ADDED_TOOLS_NOTICE : ADDED_TOOLS_NOTICE}\n${listedNames.join("\n")}`,
    );
  // 目录变化只证明当前可用性，不能据此推断 MCP 连接状态或其他变化原因。
  if (delta.readdedNames.length) {
    paragraphs.push(
      `${delta.readdedNames.length} deferred tool${delta.readdedNames.length === 1 ? " is" : "s are"} available again (names announced earlier in this conversation): ${summarizeToolNames(delta.readdedNames)}. Load via ${searchName} as before.`,
    );
  }
  if (delta.removedNames.length) {
    // 名称事实仍完整保留在 metadata；只有模型可见文案按 server 分组，避免大批删除刷屏。
    paragraphs.push(
      delta.removedNames.length > MAX_REMOVED_NAME_LINES
        ? `${delta.removedNames.length} deferred tools are no longer available: ${summarizeToolNames(delta.removedNames)}. Do not search for them — ${searchName} will return no match.`
        : `The following deferred tools are no longer available. Do not search for them — ${searchName} will return no match:\n${delta.removedNames.join("\n")}`,
      AMBIENT_CONTEXT_NOTICE,
    );
  }
  return paragraphs.join("\n\n");
}

export function summarizeToolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const group = name.startsWith("mcp__") ? `${name.split("__", 2).join("__")}__*` : name;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => (count > 1 ? `${name} (${count})` : name))
    .join(", ");
}
