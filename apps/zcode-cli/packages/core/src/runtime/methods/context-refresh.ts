import { formatLocalIsoDate, type TraceContext } from "@zcode/contracts";
import { buildCurrentDateSection } from "../../context/sections/current-date.js";
import {
  instructionFileRecord,
  parseLegacyInstructionFiles,
  renderInstructionDelta,
} from "../../context/sections/instruction-files.js";
import type {
  ContextBuildResult,
  ContextMetaUserAttachment,
  InstructionAnnouncement,
  InstructionRefreshReason,
} from "../../context/types.js";
import {
  buildEnvironmentAnnouncement,
  buildGitSystemContextSection,
  buildModelSection,
  environmentSnapshot,
  isEnvInfoGitRepository,
  type EnvironmentSnapshot,
} from "../../context/sections/env-info.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  buildDateChangeReminderBody,
  buildOutputStyleInstructionsBody,
  OUTPUT_STYLE_RESET_REMINDER,
} from "../helpers/runtime-reminders.js";
import { querySourceForTask } from "./turn-model-step-usage.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import { countContextPrefixMessages } from "../deps.js";
import type { Model, OutputStylePromptConfig } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { throwIfTurnAborted } from "../helpers/turn-errors.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import { supersedeContextComposition } from "../context-composition/state.js";
import { promptSnapshotFor } from "../helpers/prompt-snapshot.js";
import { resolveGenUiOutputDirectory } from "../helpers/gen-ui-output.js";

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  // 通知在 microtask 之后才发出（bootstrap tracker 合并），届时下面的同步重建已经完成。
  supersedeContextComposition(runtime, "context_prefix");
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // Before the first context initialization, model/outputStyle/language changes may refresh only the synchronous preview;
    // do not write config-only fallback envInfo into config.envInfo. Otherwise the real context source would treat envInfo as externally supplied
    // and skip platform and git detection.
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryRoot,
        {
          memoryIndexContent: runtime.memoryIndexContent,
          model: options.model,
          persistEnvInfo: false,
        },
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model: options.model },
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  // 主会话的 prompt 快照适用于这个模型时，system 用快照记录的字节，不用当前代码的渲染结果。
  // 修复原因：system 原来每次按当前代码重建，升级或冷恢复后已发送的前缀字节改变，prompt cache 失效。
  const snapshot = promptSnapshotFor(runtime, options.model);
  const contextEntries: RuntimeMessageEntry[] = snapshot
    ? snapshot.system.map((message) => ({ message: structuredClone(message) }))
    : buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}

// Environment, model and output style instructions as input attachments (environment -> model ->
// output_style_instructions). turn-loop appends the ToolSearch announcement, agent listing and skills right after.
export async function appendRuntimeContextAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  model: Model,
  outputStyle: OutputStylePromptConfig | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const contextResult = runtime.latestContextBuildResult;
  const environment = announcesEnvironment(contextResult)
    ? await resolveCurrentEnvironment(
        runtime,
        latestAnnouncedEnvironment(state.entries),
        traceContext,
        signal,
      )
    : undefined;
  const attachments = buildRuntimeContextAnnouncements(runtime, state.entries, {
    contextResult,
    environment,
    model,
    outputStyle,
  });
  throwIfTurnAborted(signal);
  await persistAnnouncements(runtime, state, attachments, traceContext);
}

function announcesEnvironment(contextResult: ContextBuildResult | undefined): boolean {
  return contextResult?.sections.some((section) => section.source === "env_info") === true;
}

/**
 * 环境、模型与 output style 指令公告的纯计算部分；当前环境由调用方先读好传入。
 * 输入附件收集（读当前环境）与 context 组成预演（只用历史或启动快照）共用，二者产出同一组公告。
 */
export function buildRuntimeContextAnnouncements(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  input: {
    contextResult: ContextBuildResult | undefined;
    environment: EnvironmentSnapshot | undefined;
    model: Model;
    outputStyle: OutputStylePromptConfig | undefined;
  },
): RuntimeAttachmentEntry[] {
  const last = lastAnnouncedAttachments(entries);
  const attachments: RuntimeAttachmentEntry[] = [];
  if (announcesEnvironment(input.contextResult)) {
    const previous = environmentOf(last.get("environment"))?.snapshot;
    const hasFullBlock = entries.some((entry) => environmentOf(entry)?.full);
    // The environment announcement carries the Desktop section and the session's Gen UI output
    // directory (withDesktopContext, pure computation, no directory is created): the real request
    // and the context composition preview follow the same rule, so the previewed announcement
    // matches the real first request.
    const environment = input.environment && withDesktopContext(runtime, input.environment);
    const announcement = environment
      ? buildEnvironmentAnnouncement(environment, previous, hasFullBlock)
      : null;
    if (announcement) attachments.push(environmentAttachment(announcement));
    const identity = buildModelSection(input.model)!;
    if (last.get("model")?.content !== identity.content) {
      attachments.push(systemReminderAttachmentEntry("model", identity.content));
    }
  }
  // Output style is announced to the main thread only, and again only when it differs from the last
  // announcement; clearing a style announces one reset if the last announcement was a style. It sits
  // outside the env_info gate because the fork's incognito toggles can drop the environment section.
  if (querySourceForTask(runtime.config.taskType) === "main_turn") {
    const previousStyle = last.get("output_style_instructions")?.content;
    const instructions =
      buildOutputStyleInstructionsBody(input.outputStyle) ??
      (previousStyle === undefined ? undefined : OUTPUT_STYLE_RESET_REMINDER);
    if (instructions !== undefined && instructions !== previousStyle) {
      attachments.push(systemReminderAttachmentEntry("output_style_instructions", instructions));
    }
  }
  return attachments;
}

/**
 * 不做 IO 的当前环境：沿用历史里最近一次公告（没有时用启动快照），只换上当前 cwd 与 shell。
 * 输入附件收集在目录未变时用它；context 组成预演一律用它（不重新探测仓库属性）。
 */
export function baselineCurrentEnvironment(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot | undefined,
): EnvironmentSnapshot | undefined {
  const initial = runtime.contextSourceSnapshot?.envInfo ?? runtime.config.envInfo;
  const additionalWorkingDirectories = runtime.config.additionalDirectories ?? [];
  const baseline =
    previous ?? (initial ? environmentSnapshot(initial, additionalWorkingDirectories) : undefined);
  if (!baseline) return undefined;
  return {
    ...baseline,
    cwd: runtime.workingDirectory,
    shell: runtime.config.bashShellSelection?.display.name ?? baseline.shell,
    additionalWorkingDirectories: [...additionalWorkingDirectories],
  };
}

async function resolveCurrentEnvironment(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot | undefined,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<EnvironmentSnapshot | undefined> {
  const initial = runtime.contextSourceSnapshot?.envInfo ?? runtime.config.envInfo;
  const additionalWorkingDirectories = runtime.config.additionalDirectories ?? [];
  const baseline =
    previous ?? (initial ? environmentSnapshot(initial, additionalWorkingDirectories) : undefined);
  if (!baseline) return undefined;
  const cwd = runtime.workingDirectory;
  const shell = runtime.config.bashShellSelection?.display.name;
  const port = runtime.contextSourcePort;
  if (cwd === baseline.cwd || !port) {
    const current = baselineCurrentEnvironment(runtime, previous)!;
    if (!runtime.repositoryRecheckPending || !port) return current;
    // Fix reason: reusing history when the directory is unchanged meant a new runtime after cold
    // recovery kept reporting the stored "is repository" forever; after a mid-session git init and
    // cold recovery the environment announcement still said false. A new runtime re-reads once on
    // its first announcement, taking only the repository flag — platform, shell, and OS version
    // still come from history.
    const facts = await port.resolveEnvironment(
      { workingDirectory: cwd, effectiveShellDisplayName: shell, trace },
      { signal },
    );
    throwIfTurnAborted(signal);
    runtime.repositoryRecheckPending = false;
    return { ...current, isGitRepository: isEnvInfoGitRepository(facts) };
  }
  // A new directory's repository status must be re-probed; do not reuse the envInfo frozen at the start directory.
  const facts = await port.resolveEnvironment(
    { workingDirectory: cwd, effectiveShellDisplayName: shell, trace },
    { signal },
  );
  throwIfTurnAborted(signal);
  runtime.repositoryRecheckPending = false;
  // cwd/shell and the facts come from one read, so the announcement is self-consistent. Changes
  // during the IO are not retried: history is the only baseline, and the next request announces
  // when comparing the latest announcement with the current state.
  return environmentSnapshot(
    { ...facts, cwd, shell: shell ?? facts.shell },
    additionalWorkingDirectories,
  );
}

/**
 * context builder 加了 Desktop 段（zcode_desktop，且不是 custom system prompt、workflow 子代理、subagent）时，
 * 环境公告带 Desktop 段与会话的 Gen UI 输出目录；否则都不带。
 * 目录按 sessionId 取（默认当前会话）；fork 时传子会话 id，给子会话写入环境更新（buildChildEnvironmentUpdate）。
 * fork 到另一个 cwd 时再传子会话的 workspace 路径（即它的 cwd），目录与子会话自己的公告用同一个键。
 */
function withDesktopContext(
  runtime: AgentRuntimeInternal,
  snapshot: EnvironmentSnapshot,
  sessionId: string = runtime.sessionId,
  workspacePath?: string,
): EnvironmentSnapshot {
  const { visualizationDirectory: _directory, desktopContext: _desktop, ...current } = snapshot;
  if (
    !runtime.latestContextBuildResult?.sections.some(
      (section) => section.source === "desktop_context",
    )
  )
    return current;
  const directory = resolveGenUiOutputDirectory(runtime, sessionId, workspacePath);
  return {
    ...current,
    desktopContext: true,
    ...(directory ? { visualizationDirectory: directory } : {}),
  };
}

/**
 * fork 给子会话写的环境更新：其余事实沿用 previous（子会话恢复后的模型视图里最近一次公告），Desktop 段与
 * Gen UI 目录按 runtime 当前状态重新取，目录用子会话 id；没有变化时返回 undefined。
 * 修复原因：原来整份沿用父会话的事实、只换目录，"是否在 Desktop"也照抄父会话。在终端里分叉来自 Desktop
 * 的会话时，更新仍带整段 Desktop 说明，与子会话实际的运行面不符。现在与普通环境公告共用 withDesktopContext。
 * 修复原因：fork 到受管 worktree 时子会话换了 cwd，原来 cwd 沿用父会话、目录按父会话的 workspace 路径计算。
 * 子会话第一个请求若是新轮通知，模型看到的工作目录是父会话的，可能用绝对路径改动父会话目录里的文件，
 * 而不是 worktree 里的；生成的文件也写进按父会话路径算出的目录，不是子会话自己的目录。
 * 现在传入 childCwd 时 cwd 取它，目录也按它计算。
 */
export function buildChildEnvironmentUpdate(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot,
  childSessionId: string,
  hasFullBlock: boolean,
  childCwd?: string,
): RuntimeAttachmentEntry | undefined {
  const child = childCwd ? { ...previous, cwd: childCwd } : previous;
  const announcement = buildEnvironmentAnnouncement(
    withDesktopContext(runtime, child, childSessionId, childCwd),
    previous,
    hasFullBlock,
  );
  return announcement ? environmentAttachment(announcement) : undefined;
}

/**
 * 给定历史里没有 skill 列表、且当前目录不为空时返回完整列表。
 * 输入附件收集对比整段历史，compaction 对比保留段（否则 compact 后第一次请求没有 skill 名单）。
 * 目录变化不在这里宣告，由 refreshRestoredAnnouncements 在加载历史时原位更新。
 */
export function collectSkillsListing(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  contextResult: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry | undefined {
  const content = currentSkillsListing(contextResult);
  if (!content || lastAnnouncedAttachments(entries).has("skills_listing")) return undefined;
  return systemReminderAttachmentEntry("skills_listing", content);
}

/**
 * After loading history from the store (cold recovery, rewind), restored skills listings and
 * instruction announcements (including the Memory index) are updated in place against the
 * runtime's current content: differing content is rewritten in place, empty content is deleted.
 * Announcements in history come back with the load; when current content is empty there is
 * nothing new to announce, and inserting new announcements alone cannot retract old content.
 * Memory only — the stored records only determine position, and every load reapplies. Both are
 * read only at runtime startup and do not change while running; a content change changes the
 * bytes of prior requests once, invalidating the prompt cache once.
 * Fix reason: instruction announcements used to be kept as-is after restore; the model saw the
 * old MEMORY.md while file-read state recorded the current on-disk content; Write's freshness
 * check passed and the model wrote based on stale content, overwriting newer content it had
 * never seen.
 */
export function refreshRestoredAnnouncements(runtime: AgentRuntimeInternal): void {
  if (!runtime.latestContextBuildResult) return;
  const current = currentSkillsListing(runtime.latestContextBuildResult);
  const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const isStale = (entry: RuntimeMessageEntry) =>
    entry.kind === "attachment" &&
    entry.metadata.source === "skills_listing" &&
    entry.content !== current;
  if (!entries.some(isStale)) return;
  runtime.messageHistory.replaceMessages(
    entries.flatMap((entry) => {
      if (entry.kind !== "attachment" || !isStale(entry)) return [entry];
      return current ? [{ ...entry, content: current }] : [];
    }),
  );
}

function currentSkillsListing(contextResult: ContextBuildResult | undefined): string | undefined {
  return contextResult?.metaUserAttachments.find((item) => item.source === "skills_listing")
    ?.content;
}

export async function appendRuntimeSkillsAnnouncement(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
): Promise<void> {
  const entry = collectSkillsListing(runtime, state.entries);
  await persistAnnouncements(runtime, state, entry ? [entry] : [], traceContext);
}

/**
 * Pre-request announcements: instructions → session_context → date.
 * Runs before every model request, unaffected by input-attachment skip rules.
 */
export async function appendRequestAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const sessionContext = await resolveSessionContextAnnouncement(
    runtime,
    state.entries,
    "request",
    traceContext,
    signal,
  );
  await persistAnnouncements(
    runtime,
    state,
    buildRequestAnnouncements(runtime, state.entries, sessionContext),
    traceContext,
  );
}

/**
 * Pre-request announcements still needed after deduping against the given history; compaction
 * also uses it to place announcements before the summary. Instruction files (including the
 * Memory index) do not change while the runtime runs: announce only when absent from history,
 * no content comparison; refreshRestoredAnnouncements updates in place after loading history
 * from the store. After compact removes old announcements, re-announce once against the
 * remaining history. The Git session context is pre-read by the caller under the same rules.
 */
export function buildRequestAnnouncements(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
  contextResult: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry[] {
  const instructions = buildInstructionAnnouncement(
    currentInstructions(contextResult),
    entries,
    runtime.instructionRefreshReason ?? "session_start",
    runtime.unreadableInstructionPaths,
  );
  return [
    ...(instructions ? [instructions] : []),
    ...buildSessionContextAndDate(runtime, entries, sessionContext),
  ];
}

function buildSessionContextAndDate(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
): RuntimeAttachmentEntry[] {
  const attachments = sessionContext ? [sessionContext] : [];
  const previousDate = lastAnnouncedAttachments(entries).get("date");
  // 日期一律取运行时时钟：context snapshot 的日期在会话起点冻结，跨天 compact 后
  // 剩余历史没有日期公告时，回退到它会先宣告一次过期日期。
  const date = formatLocalIsoDate(runtime.now());
  const initialDate = buildCurrentDateSection(date)!.content;
  const changedDate = buildDateChangeReminderBody(date);
  if (previousDate?.content !== initialDate && previousDate?.content !== changedDate) {
    attachments.push(
      systemReminderAttachmentEntry("date", previousDate ? changedDate : initialDate),
    );
  }
  return attachments;
}

/**
 * Pre-request announcements compaction places before the summary: sources already in the
 * preserved segment are not repeated, date included by source. Date is not content-compared:
 * with a stale date in the preserved segment, adding a date change before the summary would
 * make the next request append another one based on the old preserved date — twice in one request.
 */
export function buildCompactLeadingAnnouncements(
  runtime: AgentRuntimeInternal,
  keptEntries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
  instructionSource: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry[] {
  const kept = lastAnnouncedAttachments(keptEntries);
  const current = announcedInstructionFiles(keptEntries)
    ? undefined
    : currentInstructions(instructionSource);
  return [
    ...(current ? [fullInstructionAttachment(current)] : []),
    ...buildSessionContextAndDate(runtime, keptEntries, sessionContext).filter(
      (entry) => !kept.has(entry.metadata.source),
    ),
  ];
}

function currentInstructions(
  result: ContextBuildResult | undefined,
): ContextMetaUserAttachment | undefined {
  return result?.metaUserAttachments.find((item) => item.source === "context_prefix");
}

/**
 * 指令公告（指令文件与 Memory 索引）发出后不改写，变化在末尾追加增量。
 * 已公告的文件只从历史推出：最后一条完整公告，再按顺序套用之后的增量（files 覆盖同路径，removed 删除）。
 * 当前文件来自 runtime 最近一次构建（启动时与 compaction 提交后读取）。历史里没有完整公告时发完整公告；
 * 有变化或新增的文件、或已公告的文件不再存在时，追加一条增量；全部相同时不发。
 * 修复原因：原来冷恢复与 rewind 时把历史里的指令公告原位改成当前内容，已发送的前缀字节改变，
 * prompt cache 失效，也会让 provider 对已绑定前缀的 thinking 签名校验失败。
 */
function buildInstructionAnnouncement(
  current: ContextMetaUserAttachment | undefined,
  entries: readonly RuntimeMessageEntry[],
  reason: InstructionRefreshReason,
  unreadable: ReadonlySet<string> = new Set(),
): RuntimeAttachmentEntry | undefined {
  const announced = announcedInstructionFiles(entries);
  if (!announced) return current ? fullInstructionAttachment(current) : undefined;
  const currentFiles = current?.files ?? [];
  const changed = currentFiles.filter((file) => {
    const previous = announced.get(file.path);
    const record = instructionFileRecord(file);
    return !previous || previous.hash !== record.hash || previous.type !== record.type;
  });
  // 读不出来的文件不算删除，模型保留已宣告的副本。
  const removed = [...announced.keys()].filter(
    (path) => !unreadable.has(path) && !currentFiles.some((file) => file.path === path),
  );
  if (changed.length === 0 && removed.length === 0) return undefined;
  return instructionAttachment(renderInstructionDelta(changed, removed, reason), {
    files: changed.map(instructionFileRecord),
    ...(removed.length > 0 ? { removed } : {}),
    reason,
  });
}

function fullInstructionAttachment(current: ContextMetaUserAttachment): RuntimeAttachmentEntry {
  return instructionAttachment(current.content, {
    files: (current.files ?? []).map(instructionFileRecord),
  });
}

function announcedInstructionFiles(
  entries: readonly RuntimeMessageEntry[],
): Map<string, InstructionAnnouncement["files"][number]> | undefined {
  const records = entries.filter(
    (entry): entry is RuntimeAttachmentEntry =>
      entry.kind === "attachment" && entry.metadata.source === "context_prefix",
  );
  const fullIndex = records.findLastIndex((record) => !record.metadata.instructions?.reason);
  if (fullIndex === -1) return undefined;
  const files = new Map<string, InstructionAnnouncement["files"][number]>();
  for (const record of records.slice(fullIndex)) {
    // 旧记录没有 metadata，只可能是完整公告；按标题行拆出文件。
    const announcement = record.metadata.instructions ?? {
      files: parseLegacyInstructionFiles(record.content),
    };
    for (const file of announcement.files) files.set(file.path, file);
    for (const path of announcement.removed ?? []) files.delete(path);
  }
  return files;
}

function instructionAttachment(
  content: string,
  instructions: InstructionAnnouncement,
): RuntimeAttachmentEntry {
  return {
    ...systemReminderAttachmentEntry("context_prefix", content),
    metadata: { source: "context_prefix", instructions },
  };
}

/**
 * Compaction restates the environment, model, and output-style instructions: not repeated when
 * the preserved segment already has a full environment block or a same-source announcement;
 * otherwise the most recent pre-compact announcement is used. Not restated when absent from
 * history — the next request's input-attachment collection fills it in. Not restated when the
 * latest output-style announcement is a reset.
 */
export function restateContextAfterCompact(
  runtime: AgentRuntimeInternal,
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  return [
    ...(runtime.latestContextBuildResult?.sections.some((section) => section.source === "env_info")
      ? restateEnvironmentAndModel(preCompactEntries, keptEntries)
      : []),
    ...restateOutputStyle(preCompactEntries, keptEntries),
  ];
}

function restateEnvironmentAndModel(
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  const attachments: RuntimeAttachmentEntry[] = [];
  if (!keptEntries.some((entry) => environmentOf(entry)?.full)) {
    const snapshot = preCompactEntries
      .map(environmentOf)
      .findLast((value) => value !== undefined)?.snapshot;
    const announcement = snapshot ? buildEnvironmentAnnouncement(snapshot, undefined, false) : null;
    if (announcement) attachments.push(environmentAttachment(announcement));
  }
  const latestModel = lastAnnouncedAttachments(preCompactEntries).get("model");
  if (latestModel && !lastAnnouncedAttachments(keptEntries).has("model")) {
    attachments.push(systemReminderAttachmentEntry("model", latestModel.content));
  }
  return attachments;
}

// Restored and cloned entries had their environment metadata validated at hydrate / clone time; read directly here.
function environmentOf(entry: RuntimeMessageEntry | undefined) {
  return entry?.kind === "attachment" && entry.metadata.source === "environment"
    ? entry.metadata.environment
    : undefined;
}

/** Snapshot of the most recent environment announcement in history. */
export function latestAnnouncedEnvironment(entries: readonly RuntimeMessageEntry[]) {
  return environmentOf(lastAnnouncedAttachments(entries).get("environment"))?.snapshot;
}

function environmentAttachment(
  announcement: NonNullable<ReturnType<typeof buildEnvironmentAnnouncement>>,
): RuntimeAttachmentEntry {
  return {
    ...systemReminderAttachmentEntry("environment", announcement.content),
    metadata: { source: "environment", environment: announcement.environment },
  };
}

function restateOutputStyle(
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  if (lastAnnouncedAttachments(keptEntries).has("output_style_instructions")) return [];
  const latest = lastAnnouncedAttachments(preCompactEntries).get("output_style_instructions");
  return latest && latest.content !== OUTPUT_STYLE_RESET_REMINDER
    ? [systemReminderAttachmentEntry("output_style_instructions", latest.content)]
    : [];
}

/**
 * Git session context is decided once per window (the history since session start or the last
 * compaction), looking at history only: with a Git announcement already present, reuse it and
 * read nothing (not even after a directory switch). If a date announcement already exists
 * before the request, the window's first request already decided (date is written in the same
 * batch after deciding), so read nothing either: no Git at that time, entering a repository
 * later, or resuming after cold recovery are all the same. Otherwise read Git for the current
 * directory and announce only if it is a repository; if not, do not announce and remember the
 * directory (repository-ness is decided by a filesystem .git lookup and is always definitive).
 * Compaction decides for the compacted history: reuse if the preserved segment has a Git
 * announcement, otherwise read. At new-session initialization Git was just read; that serves
 * only the first decision (when the directory is unchanged); a restored snapshot comes from
 * storage and does not count. The Git read goes into the announcement only and does not modify
 * the runtime's context snapshot.
 * Fix reason: whether to read used to be decided by "does the last build result have a Git
 * section"; a session starting in a non-repository directory, or compacting once there, never
 * announced Git again after entering a repository. Now, after entering a repository, the next
 * window announces it.
 * Fix reason (date check): a non-repository window has no Git announcement, and "decided" used
 * to live only in runtime memory; a new runtime after cold recovery read Git again and
 * announced, contradicting "Is a git repository: false" in the environment announcement. Now
 * restored windows reuse history and skip the Git read just like live ones; a new runtime only
 * reports its own repository finding in the environment announcement.
 */
export async function resolveSessionContextAnnouncement(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  occasion: "request" | "compaction",
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<RuntimeAttachmentEntry | undefined> {
  // Subagents and custom system prompts carry no Git (same branch as the context builder).
  if (runtime.config.subagentContext || runtime.config.systemPrompt?.trim()) return undefined;
  // The prefetch serves only the first decision, whether or not this history has Git; otherwise a much later compaction would use a stale snapshot.
  const prefetched = runtime.sessionStartGitPrefetch === true;
  runtime.sessionStartGitPrefetch = false;
  const last = lastAnnouncedAttachments(entries);
  if (last.has("session_context")) return undefined;
  if (occasion === "request" && last.has("date")) return undefined;
  const directory = runtime.workingDirectory;
  // Directories this runtime already confirmed as non-repositories are not checked again in
  // later windows. Fix reason: outside a repository every decision used to run a git check,
  // which on slow filesystems could wait out the git command timeout.
  if (runtime.nonGitDirectories?.has(directory)) return undefined;
  const snapshot = runtime.contextSourceSnapshot;
  const port = runtime.contextSourcePort;
  if (!snapshot || !port) {
    // Without a context port, the session-start snapshot is the only Git source.
    return startSnapshotSessionContext(runtime);
  }
  if (prefetched && directory === snapshot.workingDirectory) {
    // Fix reason: the start snapshot could not tell "definitely not a repository" from "not
    // read"; empty was not remembered and the second request checked again. It now comes from a
    // filesystem lookup, so "not a repository" is a definitive conclusion — remember the
    // directory the same way.
    if (snapshot.envInfo.isGitRepository === false) rememberNonGitDirectory(runtime, directory);
    return startSnapshotSessionContext(runtime);
  }
  const git = await port.resolveGitContext({ workingDirectory: directory, trace }, { signal });
  throwIfTurnAborted(signal);
  const content = buildGitSystemContextSection({ ...snapshot.envInfo, ...git })?.content;
  if (content) return systemReminderAttachmentEntry("session_context", content);
  if (git.isGitRepository === false) rememberNonGitDirectory(runtime, directory);
  return undefined;
}

/**
 * context 组成预演用的 Git 会话上下文：判断规则同 resolveSessionContextAnnouncement，但不做 IO、
 * 不消费 sessionStartGitPrefetch、不记住非仓库目录；需要读 Git 时一律取启动快照。
 */
export function previewSessionContextAnnouncement(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  contextResult: ContextBuildResult | undefined,
): RuntimeAttachmentEntry | undefined {
  if (runtime.config.subagentContext || runtime.config.systemPrompt?.trim()) return undefined;
  const last = lastAnnouncedAttachments(entries);
  if (last.has("session_context") || last.has("date")) return undefined;
  if (runtime.nonGitDirectories?.has(runtime.workingDirectory)) return undefined;
  const content = contextResult?.metaUserAttachments.find(
    (item) => item.source === "session_context",
  )?.content;
  return content ? systemReminderAttachmentEntry("session_context", content) : undefined;
}

function rememberNonGitDirectory(runtime: AgentRuntimeInternal, directory: string): void {
  (runtime.nonGitDirectories ??= new Set()).add(directory);
}

function startSnapshotSessionContext(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const content = runtime.latestContextBuildResult?.metaUserAttachments.find(
    (item) => item.source === "session_context",
  )?.content;
  return content ? systemReminderAttachmentEntry("session_context", content) : undefined;
}

function lastAnnouncedAttachments(
  entries: readonly RuntimeMessageEntry[],
): Map<string, RuntimeAttachmentEntry> {
  const last = new Map<string, RuntimeAttachmentEntry>();
  for (const entry of entries) {
    if (entry.kind === "attachment") last.set(entry.metadata.source, entry);
  }
  return last;
}

export async function persistAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  attachments: readonly RuntimeAttachmentEntry[],
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  for (const entry of attachments) {
    // Announced only once persistence succeeds; the same history serves recovery, dedup, and
    // provider projection at once. The same hidden-reminder record as ToolSearch announcements
    // and compaction attachments: no top-level source is written, because older Apps validate
    // that field against a closed list and a new value would make them reject the whole session.
    // A hidden reminder is not a conversation message and does not move the conversation pointer
    // (compaction override boundaries and timeline anchors read it).
    await persistRuntimeReminderMessage.call(runtime, entry, traceContext, {
      model,
      anchor: buildProjectionAnchor(traceContext, "synthetic"),
    });
    commitTurnRequestEntries(runtime, state, [entry]);
  }
}
