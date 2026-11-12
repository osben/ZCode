import { join } from "node:path";
import { incognitoExcludes } from "@zcode/shared";

import { CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED } from "@zcode/contracts";
import {
  isFileSystemPortError,
  traceContextToLogContext,
  createContextBuilder,
  createSubagentContextBuilder,
} from "../deps.js";
import type {
  Model,
  ModelToolCall,
  SkillLoadOutcome,
  TraceContext,
  ContextSourceSnapshot,
  ContextBuilder,
  ContextBuilderConfig,
  ContextBuildResult,
} from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { ensureMemoryDirectoryExists } from "../../memory/directory.js";
import {
  formatProjectMemoryIndexContent,
  MEMORY_INDEX_FILE_NAME,
} from "../../memory/index-content.js";
import {
  ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  type ProjectMemoryRetrievalBranch,
} from "../../memory/project-memory-retrieval-branch.js";
import {
  normalizeReadFileStateMtimeMs,
  setReadFileStateEntry,
} from "../../tool/read-file-state.js";
import type { ReadFileStateEntry } from "../../tool/types.js";
import type { ResolvedUserInstructions } from "../../context/types.js";
import { resolveEnabledProjectMemoryRoot } from "../helpers/project-memory.js";
import { shouldUseMidConversationSystem } from "../helpers/runtime-provider-request-messages.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "./embedded-search-branch.js";
import { getContextSourceShellDisplayName } from "./session-shell-environment.js";
import {
  ensureGenUiOutputDirectory,
  resolveGenUiOutputDirectory,
} from "../helpers/gen-ui-output.js";

export { buildContextHistoryEntries };

export async function ensureContextInitialized(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  if (this.contextInitialized) return;

  const shellDisplayName = getContextSourceShellDisplayName(this);
  // A child's snapshot consists only of configuration passed down by the parent (envInfo, date, instruction snapshot);
  // the port is kept only for environment probing after cd. Fix reason: holding the parent's port, the child ran a full
  // resolution here, looking up the project root and probing Project Context again, while the child's context builder
  // uses none of it, so every start wasted a disk read.
  const contextSourcePort = this.config.subagentContext ? undefined : this.contextSourcePort;
  const snapshot = contextSourcePort
    ? await contextSourcePort.resolveContextSources(
        {
          workingDirectory: this.workingDirectory,
          currentDate: this.config.currentDate,
          effectiveShellDisplayName: shellDisplayName,
          envInfo: this.config.envInfo,
          // Incognito without project instructions resolves no user or project AGENTS.md.
          userInstructions:
            this.config.userInstructions &&
            !incognitoExcludes(this.config.incognito, "projectInstructions")
              ? {
                  ...this.config.userInstructions,
                  workingDirectory:
                    this.config.userInstructions.workingDirectory ?? this.workingDirectory,
                }
              : undefined,
          projectContext: this.config.projectContext,
          trace: traceContext,
        },
        { signal: undefined },
      )
    : this.createConfigOnlyContextSnapshot(this.workingDirectory);

  this.workingDirectory = snapshot.workingDirectory;
  // workingDirectory changes after Bash cd, but workspaceRoot continues to represent the session's initial workspace boundary.
  this.workspaceRoot = snapshot.workingDirectory;
  this.contextSourceSnapshot = snapshot;
  this.sessionStartGitPrefetch = true;
  this.startMcpStartup(traceContext);
  this.skillLoadOutcome = await this.discoverSkillsForContext(traceContext);
  this.memoryRoot = await this.loadProjectMemoryRoot(traceContext);
  const memoryIndex = await loadProjectMemoryIndex(
    this,
    this.memoryRoot,
    ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  );
  this.memoryIndexContent = memoryIndex.index?.content;
  // 读不出来的文件不算删除：这一轮的比较不把它们列进 removed，模型保留已宣告的副本。
  this.unreadableInstructionPaths = new Set(
    unreadableInstructionPaths(this, snapshot, memoryIndex, traceContext),
  );
  await ensureGenUiOutputDirectory(this);
  this.contextBuilder = this.createContextBuilderFromSnapshot(snapshot, this.memoryRoot, {
    memoryIndexContent: this.memoryIndexContent,
    model,
  });
  // Bug 根因：模型创建失败轮会在 Context 首次可初始化前接纳并持久化用户输入。
  // init 会替换全部内存历史，因此先保留这些权威运行条目，再接到新建的 Context 前缀之后。
  const preContextEntries = [...this.messageHistory.borrowReadOnlyRuntimeEntries()];
  this.initializeMessageHistoryFromContext(this.contextBuilder, traceContext);
  this.messageHistory.addEntries(preContextEntries);
  this.contextInitialized = true;
}

export async function getSkillCatalog(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome> {
  // Composer previously scanned disk independently, so a running Session could see new Skills not yet loaded by AgentRuntime.
  // Pass through the runtime's sole context-initialization gate first, then return a defensive copy,
  // keeping the UI's Skills in the same snapshot as those actually available to this Session; a new runtime naturally rediscovers them.
  await this.ensureContextInitialized(traceContext);
  const outcome = this.skillLoadOutcome ?? {
    skills: [],
    diagnostics: [],
    totalDiscovered: 0,
  };
  return {
    skills: outcome.skills.map((skill) => ({ ...skill })),
    diagnostics: outcome.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    totalDiscovered: outcome.totalDiscovered,
  };
}

/**
 * Main-agent-only boundary for system-prompt overrides: workflow and subagent child runtimes
 * (legacy script-workflow children spread the parent AgentRuntimeConfig without setting
 * workflowActor, so the builder's workflow-actor gate never sees them) must keep the code
 * defaults for the shared prompt fragments regardless of what the parent carries.
 */
export function resolveMainAgentSystemPromptOverrides(
  config: Pick<AgentRuntimeConfig, "taskType" | "systemPromptOverrides">,
): AgentRuntimeConfig["systemPromptOverrides"] {
  const taskType = config.taskType;
  if (
    taskType === "workflow_child" ||
    taskType === "nested_workflow_child" ||
    taskType === "subagent_child"
  ) {
    return undefined;
  }
  return config.systemPromptOverrides;
}

export function createContextBuilderFromSnapshot(
  this: AgentRuntimeInternal,
  snapshot: ContextSourceSnapshot,
  memoryRoot?: string,
  options: { memoryIndexContent?: string; model?: Model; persistEnvInfo?: boolean } = {},
): ContextBuilder {
  const envInfo = snapshot.envInfo;
  // Synchronous preview/config-only fallback constructs unknown envInfo.
  // Do not write this temporary value back to config, or the first real context source will treat it as explicit envInfo
  // and skip Node environment/git detection.
  if (options.persistEnvInfo !== false) {
    // The execution model belongs to the model step; do not write it back to the reusable Context Source.
    this.config.envInfo = envInfo;
  }
  // Incognito without skills drops only the listing; discovery, the catalog and the Skill tool stay.
  const skillListing = incognitoExcludes(this.config.incognito, "skills")
    ? undefined
    : this.skillLoadOutcome;
  if (this.config.subagentContext) {
    return createSubagentContextBuilder({
      agentPrompt: this.config.subagentContext.agentPrompt,
      currentDate: snapshot.currentDate,
      envInfo,
      model: options.model,
      // Subagents run in the same (worktree) cwd and must carry the same isolation notice.
      executionWorktree: this.config.executionWorktree,
      skillMetadataBudget: this.config.skillMetadataBudget,
      skills: skillListing,
      userInstructions: this.config.subagentContext.userInstructions,
      incognito: this.config.incognito,
    });
  }

  const contextConfig: ContextBuilderConfig = {
    workingDirectory: snapshot.workingDirectory,
    additionalDirectories: this.config.additionalDirectories,
    envInfo,
    model: options.model,
    executionWorktree: this.config.executionWorktree,
    ...(options.model
      ? { midConversationSystem: shouldUseMidConversationSystem(this.config, options.model) }
      : {}),
    presentationSurface: this.config.presentationSurface,
    genUiOutputDirectory: resolveGenUiOutputDirectory(this),
    currentDate: snapshot.currentDate,
    userInstructions: snapshot.userInstructions,
    projectContext: snapshot.projectContext,
    memoryIndexContent: options.memoryIndexContent,
    memoryRoot,
    memoryIndexAsContext: this.config.memory?.indexAsContext === true,
    skills: skillListing,
    agentProfiles: this.config.subagents?.profiles,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(this),
    skillMetadataBudget: this.config.skillMetadataBudget,
    customSystemPrompt: this.config.systemPrompt,
    workflowActor: this.config.workflowActor,
    language: this.config.language,
    outputStyle: this.config.outputStyle,
    systemPromptOverrides: resolveMainAgentSystemPromptOverrides(this.config),
    compact: this.config.compact,
    guidanceToolNames: this.getTools(options.model).map((tool) => tool.name),
    incognito: this.config.incognito,
  };

  return createContextBuilder(contextConfig).setToolRegistry(this.registry);
}

export async function loadProjectMemoryRoot(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<string | undefined> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot);
  if (!memoryRoot) {
    this.logMemorySkipped(traceContext, "disabled_or_excluded", {
      taskType: this.config.taskType,
    });
    return undefined;
  }
  if (!this.fileSystemPort) {
    this.logMemorySkipped(traceContext, "missing_file_system_port", {
      memoryRoot,
    });
    return undefined;
  }
  await ensureMemoryDirectoryExists(this.fileSystemPort, memoryRoot, traceContext, this.logger);
  return memoryRoot;
}

/** 读取 Memory 索引并写入读取状态；读不出来的路径交给调用方。 */
export async function loadProjectMemoryIndex(
  runtime: AgentRuntimeInternal,
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): Promise<ProjectMemoryIndexRead> {
  const read = await readProjectMemoryIndex(runtime, memoryRoot, retrievalBranch);
  if (read.index) setReadFileStateEntry(runtime.readFileState, read.index.readFileStateEntry);
  return read;
}

export interface ProjectMemoryIndexRead {
  index?: { content: string; readFileStateEntry: ReadFileStateEntry };
  /** 索引文件在但读不出来时的路径；不存在或为空时没有。 */
  unreadablePath?: string;
}

// Memory 索引"不存在"的错误码；其他错误是读不出来，不算删除。
const MISSING_MEMORY_INDEX_ERROR_CODES = new Set(["not_found", "is_directory", "not_file"]);

/** 读取 Memory 索引；读取状态记录由调用方在合适的时机写入。 */
async function readProjectMemoryIndex(
  runtime: AgentRuntimeInternal,
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): Promise<ProjectMemoryIndexRead> {
  if (retrievalBranch !== "default-index") return {};
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort || !memoryRoot) return {};
  const indexPath = join(memoryRoot, MEMORY_INDEX_FILE_NAME);
  try {
    const read = await fileSystemPort.readTextFile({ path: indexPath });
    const formattedContent = formatProjectMemoryIndexContent(read.content);
    if (!formattedContent) return {};
    return {
      index: {
        content: read.content,
        readFileStateEntry: {
          content: read.content,
          isPartialView: formattedContent !== read.content,
          limit: undefined,
          mtimeMs: normalizeReadFileStateMtimeMs(read.revision?.mtimeMs),
          offset: undefined,
          path: indexPath,
          readAt: runtime.now(),
          revisionId: read.revision?.id,
          seededFromContext: true,
          sizeBytes: read.sizeBytes,
        },
      },
    };
  } catch (error) {
    // 修复原因：读取出错原来一律当成没有索引，权限、占用等错误被宣告成 MEMORY.md 已删除。
    // 只有确实不存在才算没有；其他错误报给调用方，沿用已宣告的内容。
    if (isFileSystemPortError(error) && MISSING_MEMORY_INDEX_ERROR_CODES.has(error.code)) return {};
    return { unreadablePath: indexPath };
  }
}

/** 本次读取中读不出来的指令文件与 Memory 索引路径，每个路径记一条 warn。 */
function unreadableInstructionPaths(
  runtime: AgentRuntimeInternal,
  sources: Pick<ContextSourceSnapshot, "diagnostics">,
  memoryIndex: ProjectMemoryIndexRead,
  traceContext: TraceContext,
): string[] {
  const paths = [
    ...sources.diagnostics.flatMap((diagnostic) =>
      diagnostic.code === CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED && diagnostic.path
        ? [diagnostic.path]
        : [],
    ),
    ...(memoryIndex.unreadablePath ? [memoryIndex.unreadablePath] : []),
  ];
  for (const path of paths) {
    runtime.logger?.warn("Instruction file read failed", {
      ...traceContextToLogContext(traceContext),
      event: "context.instructions.read_failed",
      path,
    });
  }
  return paths;
}

export interface InstructionSourcesReread {
  userInstructions: ResolvedUserInstructions | undefined;
  memoryIndex: { content: string; readFileStateEntry: ReadFileStateEntry } | undefined;
  /** 读不出来、但 runtime 没有持有的路径；采用重读后这些路径仍不算删除。 */
  unreadablePaths: string[];
}

/**
 * compaction 收尾时重读指令文件与 Memory 索引，只读不改 runtime。
 * 修复原因：原来 compaction 沿用 runtime 启动时读到的内容；会话中途改过的 AGENTS.md / MEMORY.md
 * 在 compact 之后仍以旧内容宣告，模型一直看不到新内容。
 * 没有 context port（子 agent）时不重读；读取失败、或 runtime 持有的文件读不出来时返回 undefined，
 * 沿用原内容；取消时抛出。
 */
export async function rereadInstructionSources(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<InstructionSourcesReread | undefined> {
  const port = runtime.config.subagentContext ? undefined : runtime.contextSourcePort;
  const snapshot = runtime.contextSourceSnapshot;
  if (!port || !snapshot) return undefined;
  const userInstructions = runtime.config.userInstructions;
  try {
    // 传入快照里的 envInfo 与 projectContext，端口不再探测环境与 Git。
    const [sources, memoryIndex] = await Promise.all([
      port.resolveContextSources(
        {
          workingDirectory: snapshot.workingDirectory,
          currentDate: snapshot.currentDate,
          envInfo: snapshot.envInfo,
          projectContext: snapshot.projectContext,
          userInstructions: userInstructions
            ? {
                ...userInstructions,
                workingDirectory: userInstructions.workingDirectory ?? snapshot.workingDirectory,
              }
            : undefined,
          trace: traceContext,
        },
        { signal },
      ),
      readProjectMemoryIndex(runtime, runtime.memoryRoot, ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH),
    ]);
    const unreadablePaths = unreadableInstructionPaths(runtime, sources, memoryIndex, traceContext);
    // runtime 持有的文件读不出来：整次重读作废，沿用原内容，下一次读取再试。
    const held = runtime.latestContextBuildResult?.metaUserAttachments.find(
      (item) => item.source === "context_prefix",
    )?.files;
    if (held?.some((file) => unreadablePaths.includes(file.path))) return undefined;
    return {
      userInstructions: sources.userInstructions,
      memoryIndex: memoryIndex.index,
      unreadablePaths,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    runtime.logger?.warn("Instruction re-read after compaction failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "context.instructions.reread_failed",
    });
    return undefined;
  }
}

/**
 * 按重读的内容构建一次公告来源，只给 summary 之前的指令公告用；不改 runtime。
 */
export function buildRereadInstructionContext(
  runtime: AgentRuntimeInternal,
  reread: InstructionSourcesReread,
  model: Model | undefined,
): ContextBuildResult | undefined {
  const snapshot = runtime.contextSourceSnapshot;
  if (!snapshot) return undefined;
  return runtime
    .createContextBuilderFromSnapshot(
      { ...snapshot, userInstructions: reread.userInstructions },
      runtime.memoryRoot,
      { memoryIndexContent: reread.memoryIndex?.content, model, persistEnvInfo: false },
    )
    .build();
}

/**
 * compaction 提交后采用重读的内容：更新 context 快照与 Memory 索引，按它重建公告来源，
 * 指令增量的 reason 改为 compaction。不改历史里的 system 前缀，也不改工作目录、环境与 Git 预取标记。
 * 修复原因：原来重读结果在 compact 落库之前就交给 runtime；compact 失败或取消时 runtime 已持有新内容，
 * 历史里却还是旧公告，下一次请求以 session_start 为原因宣告这次变化。
 */
export function applyRereadInstructionSources(
  runtime: AgentRuntimeInternal,
  reread: InstructionSourcesReread,
  model: Model | undefined,
): void {
  const snapshot = runtime.contextSourceSnapshot;
  if (!snapshot) return;
  runtime.contextSourceSnapshot = { ...snapshot, userInstructions: reread.userInstructions };
  runtime.memoryIndexContent = reread.memoryIndex?.content;
  runtime.unreadableInstructionPaths = new Set(reread.unreadablePaths);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    runtime.contextSourceSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model },
  );
  runtime.latestContextBuildResult = runtime.contextBuilder.build();
  runtime.instructionRefreshReason = "compaction";
}

export function logMemorySkipped(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: string,
  context: Record<string, unknown> = {},
): void {
  this.logger?.debug("Memory read skipped", {
    ...traceContextToLogContext(traceContext),
    event: "memory.read.skipped",
    module: "core.runtime",
    reason,
    status: "completed",
    ...context,
  });
}

export async function discoverSkillsForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome | undefined> {
  if (!this.skillPort) {
    return undefined;
  }

  try {
    const outcome = await this.skillPort.discoverSkills({
      workingDirectory: this.workingDirectory,
      trace: traceContext,
    });
    this.logger?.debug("Skills discovered", {
      ...traceContextToLogContext(traceContext),
      diagnosticCount: outcome.diagnostics.length,
      module: "core.runtime",
      skillCount: outcome.skills.length,
      totalDiscovered: outcome.totalDiscovered,
    });
    return outcome;
  } catch (error) {
    this.logger?.warn("Skill discovery failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      module: "core.runtime",
    });
    return {
      skills: [],
      diagnostics: [
        {
          code: "skill_scan_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      totalDiscovered: 0,
    };
  }
}

export function createConfigOnlyContextSnapshot(
  this: AgentRuntimeInternal,
  workingDirectory: string,
): ContextSourceSnapshot {
  return {
    workingDirectory,
    envInfo: this.config.envInfo ?? {
      cwd: workingDirectory,
      platform: "unknown",
      shell: "unknown",
      osVersion: "unknown",
      nodeVersion: "unknown",
    },
    currentDate: this.config.currentDate,
    projectContext: this.config.projectContext,
    diagnostics: [],
  };
}

export function initializeMessageHistoryFromContext(
  this: AgentRuntimeInternal,
  contextBuilder: ContextBuilder,
  traceContext: TraceContext,
): void {
  const contextResult = contextBuilder.build();
  this.latestContextBuildResult = contextResult;
  this.messageHistory.init(buildContextHistoryEntries(contextResult));

  this.logger?.debug("Context built", {
    ...traceContextToLogContext(traceContext),
    event: "context.built",
    module: "core.runtime",
    sectionCount: contextResult.sections.length,
    status: "completed",
    tokenMethod: "estimated",
    tokenizer: "zcode.estimateTokens.v1",
    totalChars: contextResult.totalChars,
    totalTokens: contextResult.totalTokens,
    sections: contextResult.sections.map((s) => ({
      name: s.name,
      source: s.source,
      chars: s.chars,
      tokens: s.tokens,
      tokenMethod: "estimated",
      confidence: "medium",
      tokenizer: "zcode.estimateTokens.v1",
      preview: s.preview,
      content: s.content,
    })),
  });
}

export function extractToolCallsFromResult(
  this: AgentRuntimeInternal,
  result: any,
): ModelToolCall[] {
  const toolCalls: ModelToolCall[] = [];

  // Try different result formats
  const responses = result.responses ?? result.finishReasons ?? [];

  for (const response of responses) {
    if (response.toolCalls && Array.isArray(response.toolCalls)) {
      for (const tc of response.toolCalls) {
        toolCalls.push({
          id: tc.id,
          name: tc.name ?? tc.toolName,
          input: tc.input,
          providerExecuted: tc.providerExecuted,
          blockIndex: tc.blockIndex,
        });
      }
    }
  }

  // Also check for flat tool_calls array
  if (result.toolCalls && Array.isArray(result.toolCalls)) {
    for (const tc of result.toolCalls) {
      if (!toolCalls.find((c) => c.id === tc.id)) {
        toolCalls.push({
          id: tc.id,
          name: tc.name ?? tc.toolName,
          input: tc.input,
          providerExecuted: tc.providerExecuted,
          blockIndex: tc.blockIndex,
        });
      }
    }
  }

  return toolCalls;
}

export function shouldStreamModelText(this: AgentRuntimeInternal): boolean {
  return this.config.modelStreaming === "on";
}
