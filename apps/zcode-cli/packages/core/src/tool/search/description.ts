import {
  DEFERRED_TOOL_CALL_NAME,
  LOCAL_TOOL_SEARCH_NAME,
  TOOL_SEARCH_NAME,
  toolSearchNameForMode,
  type ResolvedToolSearchMode,
} from "@zcode/contracts";
import { isMcpToolName } from "../../mcp/name.js";

function description(opening: string, callingConvention: string, resultNote: string): string {
  return `${opening}

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. ${callingConvention}

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block${resultNote}

Query forms:
Regular expressions are not supported. Use space-separated keywords for broad searches, or "select:<name>[,<name>...]" for exact tool names. Characters such as "|" and ".*" are treated literally. For example, use "shell terminal execute command".

- "select:TodoWrite,mcp__byob__browser_navigate" — fetch these exact deferred tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;
}

export const NATIVE_TOOL_SEARCH_DESCRIPTION = description(
  "Fetches full schema definitions for deferred tools so they can be called.",
  "Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.",
  " — the same encoding as the tool list at the top of this prompt.",
);

// Definitions returned in Local mode describe the target parameters; they must not be mistaken for a registered direct-call entry point.
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
const MCP_READDED_REASON =
  "(MCP server reconnected — names announced earlier in this conversation)";
const READDED_REASON = "in this session (announced earlier in this conversation)";
const AMBIENT_CONTEXT_NOTICE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";

// Announcement metadata is the single source of truth; a mode switch only re-renders the text and never rewrites arbitrary text in user messages or tool results.
// hiddenNames are the removedNames that are still in the registry and hidden only by this turn's restrictions; they are persisted with the announcement
// so every request renders the same text from the same facts.
export function renderToolSearchAnnouncement(
  {
    addedNames,
    removedNames,
    readdedNames,
  }: {
    addedNames: readonly string[];
    removedNames: readonly string[];
    readdedNames: readonly string[];
  },
  mode: ResolvedToolSearchMode,
  hiddenNames: readonly string[] = [],
): string {
  const searchName = toolSearchNameForMode(mode);
  const noSearchNotice = `Do not search for them — ${searchName} will return no match`;
  const readded = new Set(readdedNames);
  const listedNames = addedNames.filter((name) => !readded.has(name));
  const paragraphs: string[] = [];
  if (listedNames.length)
    paragraphs.push(
      `${mode === "local" ? LOCAL_ADDED_TOOLS_NOTICE : ADDED_TOOLS_NOTICE}\n${listedNames.join("\n")}`,
    );
  // MCP and other tools get separate paragraphs: MCP names are summarized per server with the reconnect reason, other tools are listed comma-separated.
  const readdedMcp = readdedNames.filter(isMcpToolName);
  const readdedOther = readdedNames.filter((name) => !isMcpToolName(name));
  const availableAgain = (count: number, reason: string, names: string) =>
    `${count} deferred tool${count === 1 ? " is" : "s are"} available again ${reason}: ${names}. Load via ${searchName} as before.`;
  if (readdedMcp.length)
    paragraphs.push(
      availableAgain(readdedMcp.length, MCP_READDED_REASON, summarizeToolNames(readdedMcp)),
    );
  if (readdedOther.length)
    paragraphs.push(availableAgain(readdedOther.length, READDED_REASON, readdedOther.join(", ")));
  if (removedNames.length) {
    // Tools still in the catalog that are hidden only by this turn's restrictions must not be reported as unavailable in this session.
    const hiddenSet = new Set(hiddenNames);
    const hidden = removedNames.filter((name) => hiddenSet.has(name));
    const departed = removedNames.filter((name) => !hiddenSet.has(name));
    // Removal reasons are distinguished per tool; a non-MCP tool must not be reported as an MCP disconnect.
    // Disconnects are judged only by the mcp__ name prefix without reading connection state; the full name facts stay in metadata.
    const disconnected = departed.filter(isMcpToolName);
    const gone = departed.filter((name) => !isMcpToolName(name));
    if (disconnected.length) {
      paragraphs.push(
        disconnected.length > MAX_REMOVED_NAME_LINES
          ? `${disconnected.length} deferred tools are no longer available (MCP server disconnected): ${summarizeToolNames(disconnected)}. ${noSearchNotice}.`
          : `The following deferred tools are no longer available (their MCP server disconnected). ${noSearchNotice}:\n${disconnected.join("\n")}`,
      );
    }
    if (gone.length) {
      paragraphs.push(
        `The following deferred tools are no longer available in this session. ${noSearchNotice}:\n${gone.join("\n")}`,
      );
    }
    if (hidden.length) {
      // Group by server when there are many names so a large batch removal does not flood the output.
      paragraphs.push(
        hidden.length > MAX_REMOVED_NAME_LINES
          ? `${hidden.length} deferred tools are no longer available: ${summarizeToolNames(hidden)}. ${noSearchNotice}.`
          : `The following deferred tools are no longer available. ${noSearchNotice}:\n${hidden.join("\n")}`,
      );
    }
    paragraphs.push(AMBIENT_CONTEXT_NOTICE);
  }
  return paragraphs.join("\n\n");
}

function summarizeToolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const group = isMcpToolName(name) ? `${name.split("__", 2).join("__")}__*` : name;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => (count > 1 ? `${name} (${count})` : name))
    .join(", ");
}
