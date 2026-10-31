import { assertNotExternalAgentModel } from "@zcode/contracts";
import { isAbsolute } from "node:path";

import type {
  ModelInputMessage,
  ModelUsage,
  ModelResult,
  Model,
  ModelRequest,
  ModelToolCall,
  ModelToolContract,
} from "@zcode/contracts";

import {
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
  type RuntimeMessageEntry,
} from "../agent/message-history.js";
import { toolBatchModelEntries } from "../runtime/helpers/tool-result.js";
import { projectMessagesForModelMediaPolicy } from "../runtime/helpers/media-budget.js";
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
} from "../tool/handlers/bash-command-parser.js";
import { isRuntimeReadOnlyBashCommand } from "../tool/handlers/bash-semantics.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../tool/types.js";
import {
  isDreamJournalRelativePath,
  memoryFileRelativePath,
  resolveContainedMemoryFilePath,
  resolveSafeMemoryFilePath,
} from "./memory-file-path.js";
import { auxiliaryModelOptions } from "../model/auxiliary-model-options.js";

export type MemoryAgentModelRequest = ModelRequest;

/** Per provider request timing + usage captured for callers that record usage facts (manual Dream). */
export interface MemoryAgentLoopRequestUsage {
  index: number;
  completedAt: number;
  durationMs: number;
  startedAt: number;
  status: "completed" | "error" | "cancelled";
  result?: ModelResult;
  error?: unknown;
  usage?: ModelUsage;
}

/** One request produced by the renderer: messages, the tool catalog, and the ToolSearch switch. */
export interface MemoryAgentRenderedRequest {
  messages: ModelInputMessage[];
  tools: ModelToolContract[];
  toolSearchEnabled: boolean;
}

export interface MemoryAgentLoopResult {
  entries: RuntimeMessageEntry[];
  requests: MemoryAgentLoopRequestUsage[];
  turns: number;
}

export interface MemoryAgentToolPolicyInput {
  rootDir: string;
  toolCall: ModelToolCall;
  tools: readonly ModelToolContract[];
  workingDirectory: string;
  workspaceRoot: string;
}

export type MemoryAgentToolPolicyDecision = { allowed: true } | { allowed: false; reason: string };

const MEMORY_AGENT_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);
const MEMORY_AGENT_MISSING_RESULT = "Tool call returned no result";

/**
 * Memory Agent loop (Extraction, Dream). It shares Main's single-step kernel instead of a separate "tool result -> next request" path:
 * each turn renders the request from entries with Main's renderer; calls that pass the Memory policy run through Main's scheduler;
 * a result batch becomes entries (tool results + batch attachments) via the same function Main uses to settle. See memory/README.md.
 */
export async function runMemoryAgentLoop(input: {
  abortSignal?: AbortSignal;
  onRequestStart?: (index: number) => void;
  onRequestSettled?: (request: MemoryAgentLoopRequestUsage) => Promise<void>;
  /** Initial entries: Main's provider entries plus the prompt. */
  entries: readonly RuntimeMessageEntry[];
  /** Main's renderer: builds each request from all entries. */
  renderRequest: (entries: readonly RuntimeMessageEntry[]) => MemoryAgentRenderedRequest;
  /** Main's scheduling and execution; receives only calls that pass the Memory policy. */
  executeToolCalls: (
    toolCalls: ExecutableToolCall[],
    options: { abortSignal?: AbortSignal },
  ) => Promise<ToolExecutionResult[]>;
  /** Settlement reads the batch hints declared by tools. */
  registry: Pick<ToolRegistry, "get">;
  maxTurns: number;
  model: Model;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<MemoryAgentLoopResult> {
  const entries = [...input.entries];
  const requests: MemoryAgentLoopRequestUsage[] = [];
  let turns = 0;

  for (; turns < input.maxTurns; turns += 1) {
    input.abortSignal?.throwIfAborted();
    const rendered = input.renderRequest(entries);
    // Projecting only the initial Memory snapshot would miss media produced later by tools such as Read; every
    // provider request must apply the same capability + budget policy.
    const mediaProjection = projectMessagesForModelMediaPolicy(
      rendered.messages,
      input.model.properties.inputFormat,
    );
    const request: ModelRequest = {
      abortSignal: input.abortSignal,
      messages: mediaProjection.messages,
      options: auxiliaryModelOptions(input.model),
      // The Memory agent's provider request must preserve Main's real tool catalog; execution permissions are narrowed only at the tool-use boundary.
      tools: rendered.tools,
      toolSearchEnabled: rendered.toolSearchEnabled,
    };
    input.onRequestStart?.(turns);
    const startedAt = Date.now();
    let response: ModelResult;
    try {
      response = await assertNotExternalAgentModel(input.model, "memory agent").generateText(request);
    } catch (error) {
      const completedAt = Date.now();
      await input.onRequestSettled?.({
        index: turns,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        status: input.abortSignal?.aborted ? "cancelled" : "error",
        error,
      });
      throw error;
    }
    const completedAt = Date.now();
    const observation: MemoryAgentLoopRequestUsage = {
      index: turns,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      status: "completed",
      result: response,
      usage: response.usage,
    };
    requests.push(observation);
    // Persist before abort checks and tools: a later failure must not erase paid requests.
    await input.onRequestSettled?.(observation);
    input.abortSignal?.throwIfAborted();

    const toolCalls = response.toolCalls ?? [];
    entries.push(createRuntimeAssistantEntry(response.text, toolCalls, response.reasoning));
    if (toolCalls.length === 0) {
      turns += 1;
      break;
    }

    const deniedReasons = new Map<string, string>();
    const allowedCalls: ExecutableToolCall[] = [];
    for (const toolCall of toolCalls) {
      const decision = evaluateMemoryAgentToolPolicy({
        rootDir: input.rootDir,
        toolCall,
        tools: rendered.tools,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      });
      if (decision.allowed) {
        allowedCalls.push({ id: toolCall.id, input: toolCall.input, name: toolCall.name });
      } else {
        deniedReasons.set(toolCall.id, decision.reason);
      }
    }
    const results =
      allowedCalls.length > 0
        ? await input.executeToolCalls(allowedCalls, { abortSignal: input.abortSignal })
        : [];
    const batch = toolBatchModelEntries(results, { registry: input.registry });
    const executedById = new Map(
      batch.toolResults.map((entry) => [entry.message.toolCallId, entry] as const),
    );
    // Tool results follow the calls' declared order; denied calls are not scheduled and get their rejection result in place.
    // Every tool_use needs a tool_result or the provider rejects the next request; fill in an error result when the executor returns none.
    for (const toolCall of toolCalls) {
      const deniedReason = deniedReasons.get(toolCall.id);
      entries.push(
        deniedReason === undefined
          ? (executedById.get(toolCall.id) ??
              createRuntimeToolResultEntry(
                toolCall.id,
                toolCall.name,
                MEMORY_AGENT_MISSING_RESULT,
                true,
              ))
          : createRuntimeToolResultEntry(toolCall.id, toolCall.name, deniedReason, true),
      );
    }
    entries.push(...batch.attachments);
  }

  return { entries, requests, turns };
}

export function evaluateMemoryAgentToolPolicy(
  input: MemoryAgentToolPolicyInput,
): MemoryAgentToolPolicyDecision {
  const contract = input.tools.find((tool) => tool.name === input.toolCall.name);
  // If a catalog miss is merged into a Memory permission rejection, an unregistered tool will not first receive
  // the "No such tool" handling. This branch only closes the original call ID and does not enter tool execution.
  if (!contract) return denyUnavailableMemoryAgentTool(input.toolCall.name);

  if (
    input.toolCall.name === "Agent" ||
    input.toolCall.name.startsWith("mcp__") ||
    contract.sideEffectScope === "network"
  )
    return denyMemoryAgentTool(input.rootDir);

  if (input.toolCall.name === "Write" || input.toolCall.name === "Edit") {
    return isContainedMarkdownMutation(input)
      ? { allowed: true }
      : denyMemoryAgentTool(input.rootDir);
  }

  if (input.toolCall.name === "Bash") {
    const command = stringProperty(input.toolCall.input, "command");
    // The Memory Agent reuses the existing read-only classifier to avoid narrowing safe env, redirect, and background execution a second time here.
    if (
      command &&
      (isRuntimeReadOnlyBashCommand(command, {
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) ||
        isContainedMarkdownBashRemoval(command, input))
    ) {
      return { allowed: true };
    }
    return denyMemoryAgentBash(input.rootDir);
  }

  if (MEMORY_AGENT_READ_ONLY_TOOLS.has(input.toolCall.name)) {
    return { allowed: true };
  }

  return denyMemoryAgentTool(input.rootDir);
}

function isContainedMarkdownMutation(input: MemoryAgentToolPolicyInput): boolean {
  const filePath = stringProperty(input.toolCall.input, "file_path");
  if (!filePath?.endsWith(".md")) return false;
  try {
    return (
      resolveSafeMemoryFilePath({
        filePath,
        rootDir: input.rootDir,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) !== undefined
    );
  } catch {
    return false;
  }
}

function isContainedMarkdownBashRemoval(
  command: string,
  input: MemoryAgentToolPolicyInput,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis) || analysis.commands.length !== 1) return false;
  const invocation = analysis.commands[0];
  if (!invocation || invocation.argv[0] !== "rm") return false;
  if (invocation.redirects.length > 0 || invocation.envAssignments.length > 0) return false;

  let afterOptions = false;
  let pathCount = 0;
  for (const argument of invocation.argv.slice(1)) {
    if (!afterOptions) {
      if (argument === "--") {
        afterOptions = true;
        continue;
      }
      if (argument.startsWith("-")) {
        if (argument === "--recursive" || /^-[a-zA-Z]*[rR]/u.test(argument)) return false;
        continue;
      }
    }
    if (/[*?[]/u.test(argument)) return false;
    if (!isAbsolute(argument) || !argument.endsWith(".md")) return false;
    const resolved = resolveContainedPath(argument, input);
    if (resolved === undefined) return false;
    // Dream snapshots are runtime-owned; removing one would leave the journal pointing at nothing.
    const relativePath = memoryFileRelativePath(input.rootDir, resolved);
    if (relativePath === undefined || isDreamJournalRelativePath(relativePath)) return false;
    pathCount += 1;
  }
  return pathCount > 0;
}

function resolveContainedPath(
  filePath: string,
  input: Pick<MemoryAgentToolPolicyInput, "rootDir" | "workingDirectory" | "workspaceRoot">,
): string | undefined {
  try {
    return resolveContainedMemoryFilePath({
      filePath,
      rootDir: input.rootDir,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    return undefined;
  }
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

// Rejection results enter the next provider request; follow the baseline by using different fixed messages for Bash and other tools.
function denyMemoryAgentBash(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `Only read-only shell commands and rm with all paths inside ${rootDir} are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)`,
  };
}

function denyMemoryAgentTool(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `only Read, Grep, Glob, read-only Bash, and Edit/Write within ${rootDir} are allowed`,
  };
}

function denyUnavailableMemoryAgentTool(toolName: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
  };
}
