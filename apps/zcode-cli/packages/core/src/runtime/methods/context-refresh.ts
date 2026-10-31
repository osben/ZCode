import { formatLocalIsoDate, type TraceContext } from "@zcode/contracts";
import { buildCurrentDateSection } from "../../context/sections/current-date.js";
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

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
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
  const contextEntries = buildContextHistoryEntries(effectiveContextResult);
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
  const last = lastAnnouncedAttachments(state.entries);
  const result = runtime.latestContextBuildResult;
  const attachments: RuntimeAttachmentEntry[] = [];
  if (result?.sections.some((section) => section.source === "env_info")) {
    const previous = environmentOf(last.get("environment"))?.snapshot;
    const snapshot = await resolveCurrentEnvironment(runtime, previous, traceContext, signal);
    const hasFullBlock = state.entries.some((entry) => environmentOf(entry)?.full);
    const announcement = snapshot
      ? buildEnvironmentAnnouncement(snapshot, previous, hasFullBlock)
      : null;
    if (announcement) attachments.push(environmentAttachment(announcement));
    const identity = buildModelSection(model)!;
    if (last.get("model")?.content !== identity.content) {
      attachments.push(systemReminderAttachmentEntry("model", identity.content));
    }
  }
  // Output style is announced to the main thread only, and again only when it differs from the last
  // announcement; clearing a style announces one reset if the last announcement was a style. It sits outside
  // the env_info gate because the fork's incognito toggles can drop the environment section.
  if (querySourceForTask(runtime.config.taskType) === "main_turn") {
    const previousStyle = last.get("output_style_instructions")?.content;
    const instructions =
      buildOutputStyleInstructionsBody(outputStyle) ??
      (previousStyle === undefined ? undefined : OUTPUT_STYLE_RESET_REMINDER);
    if (instructions !== undefined && instructions !== previousStyle) {
      attachments.push(systemReminderAttachmentEntry("output_style_instructions", instructions));
    }
  }
  throwIfTurnAborted(signal);
  await persistAnnouncements(runtime, state, attachments, traceContext);
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
    const current = {
      ...baseline,
      cwd,
      shell: shell ?? baseline.shell,
      additionalWorkingDirectories: [...additionalWorkingDirectories],
    };
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
 * Returns the full listing when the given history has no skills listing and the current directory
 * is not empty. Input-attachment collection compares against the whole history; compaction
 * compares against the preserved segment (otherwise the first request after a compact has no
 * skill roster). Directory changes are not announced here; refreshRestoredAnnouncements updates
 * them in place when loading history.
 */
export function collectSkillsListing(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry | undefined {
  const content = currentSkillsListing(runtime);
  if (!content || lastAnnouncedAttachments(entries).has("skills_listing")) return undefined;
  return systemReminderAttachmentEntry("skills_listing", content);
}

// Announcement sources read only at runtime startup and updated in place against current content after loading history.
const REFRESHED_ON_LOAD_SOURCES: ReadonlySet<string> = new Set([
  "skills_listing",
  "context_prefix",
]);

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
  const attachments = runtime.latestContextBuildResult?.metaUserAttachments;
  if (!attachments) return;
  const currentContent = (source: string) =>
    attachments.find((item) => item.source === source)?.content;
  const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const isStale = (entry: RuntimeMessageEntry) =>
    entry.kind === "attachment" &&
    REFRESHED_ON_LOAD_SOURCES.has(entry.metadata.source) &&
    entry.content !== currentContent(entry.metadata.source);
  if (!entries.some(isStale)) return;
  runtime.messageHistory.replaceMessages(
    entries.flatMap((entry) => {
      if (entry.kind !== "attachment" || !isStale(entry)) return [entry];
      const content = currentContent(entry.metadata.source);
      return content ? [{ ...entry, content }] : [];
    }),
  );
}

function currentSkillsListing(runtime: AgentRuntimeInternal): string | undefined {
  return runtime.latestContextBuildResult?.metaUserAttachments.find(
    (item) => item.source === "skills_listing",
  )?.content;
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
): RuntimeAttachmentEntry[] {
  const last = lastAnnouncedAttachments(entries);
  const instructions = runtime.latestContextBuildResult?.metaUserAttachments.find(
    (item) => item.source === "context_prefix",
  );
  const attachments =
    instructions && !last.has("context_prefix")
      ? [systemReminderAttachmentEntry("context_prefix", instructions.content)]
      : [];
  if (sessionContext) attachments.push(sessionContext);
  const previousDate = last.get("date");
  // The date always comes from the runtime clock: the context snapshot's date is frozen at the
  // session start, and after a cross-day compact with no date announcement left in the remaining
  // history, falling back to it would first announce a stale date.
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
): RuntimeAttachmentEntry[] {
  const kept = lastAnnouncedAttachments(keptEntries);
  return buildRequestAnnouncements(runtime, keptEntries, sessionContext).filter(
    (entry) => !kept.has(entry.metadata.source),
  );
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
