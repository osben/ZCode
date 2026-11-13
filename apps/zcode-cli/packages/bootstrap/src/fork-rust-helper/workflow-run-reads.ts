import type { ToolArtifactStorePort } from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import {
  WORKFLOW_ARTIFACT_LIMITS,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  WORKFLOW_WORKSPACE_LIMITS,
  V4_METHODS,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunEventsParamsSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunsParamsSchema,
  v4ConversationWorkflowRunsResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { artifactsOf } from "../app/dynamic-workflow-run-artifact-projection.js";
import { listArtifactItemsFrom } from "../app/dynamic-workflow-run-artifact-queries.js";
import { readWorkflowArtifactBytes } from "../app/dynamic-workflow-run-artifact-read.js";
import {
  pageByCountOnly,
  supportsEventPages,
  supportsRunEnumeration,
} from "../app/dynamic-workflow-run-journal.js";
import { toSessionSummary } from "../app/dynamic-workflow-run-observation.js";
import { toProtocolEvent } from "../app/dynamic-workflow-run-progress-payload.js";
import {
  listWorkspaceNodesFrom,
  readWorkspaceNodeResultFrom,
} from "../app/dynamic-workflow-run-workspace.js";

/** Same bounds as the run service's `listRunsForSession`. */
const DEFAULT_LIST_RUNS_LIMIT = 16;
const MAX_LIST_RUNS_LIMIT = 64;
/** Whole artifact versions kept for chunked reads (the gateway's binary read cache, smaller). */
const ARTIFACT_CACHE_ENTRIES = 4;
const ARTIFACT_CACHE_TTL_MS = 60_000;

export interface WorkflowRunReadDeps {
  /** Opens the journal on first use; `undefined` when the session store has no dwf journal. */
  journal(): Promise<JournalStorePort | undefined>;
  artifactStore: ToolArtifactStorePort | undefined;
  now?: () => number;
}

interface CachedArtifact {
  at: number;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}

/**
 * The seven `v4/conversation/workflowRun*` reads, answered from the journal and the artifact store
 * directly (specs/fork-rust-node-helper.md, F2).
 *
 * Node answers them through the run service of a cold-resumed session. Both are off limits here:
 * the session belongs to the Rust agent (rule 2), and the run service's constructor reconciles orphan
 * runs, which writes to the journal. The pure query functions below are the ones the run service
 * uses, so results match Node's. Every read checks that the run belongs to `sessionId`; a run of
 * another conversation reads as an unknown run.
 */
export function createWorkflowRunReads(deps: WorkflowRunReadDeps) {
  const now = deps.now ?? Date.now;
  const artifactCache = new Map<string, CachedArtifact>();

  async function ownedJournal(sessionId: string, runId: string) {
    const journal = await deps.journal();
    if (!journal || journal.getRun(runId)?.parentSessionId !== sessionId) return undefined;
    return journal;
  }

  function readArtifactPayload(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }) {
    const at = now();
    for (const [key, entry] of artifactCache)
      if (at - entry.at > ARTIFACT_CACHE_TTL_MS) artifactCache.delete(key);
    const key = [params.sessionId, params.runId, params.artifactId, params.version].join("\u0000");
    const cached = artifactCache.get(key);
    if (cached) {
      cached.at = at;
      return cached.payload;
    }
    const payload = (async () => {
      const journal = await deps.journal();
      const artifact = journal
        ? await readWorkflowArtifactBytes(
            {
              journal,
              parentSessionId: params.sessionId,
              ...(deps.artifactStore === undefined ? {} : { artifactStore: deps.artifactStore }),
            },
            params.runId,
            params.artifactId,
            params.version,
          )
        : undefined;
      if (artifact === undefined) {
        throw new Error(
          `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
        );
      }
      return { bytes: artifact.bytes, mediaType: artifact.contentType };
    })();
    payload.catch(() => artifactCache.delete(key));
    artifactCache.set(key, { at, payload });
    while (artifactCache.size > ARTIFACT_CACHE_ENTRIES)
      artifactCache.delete(artifactCache.keys().next().value!);
    return payload;
  }

  return {
    async [V4_METHODS.conversationWorkflowRuns](rawParams: unknown) {
      const params = v4ConversationWorkflowRunsParamsSchema.parse(rawParams);
      const journal = await deps.journal();
      if (!journal || !supportsRunEnumeration(journal))
        return v4ConversationWorkflowRunsResultSchema.parse({ runs: [] });
      const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIST_RUNS_LIMIT, MAX_LIST_RUNS_LIMIT));
      // No live registry entry: the helper runs no workflow, so the journal row is the whole truth.
      const runs = journal
        .listRunsByParentSession(params.sessionId, limit)
        .map((row) => toSessionSummary(row, undefined));
      return v4ConversationWorkflowRunsResultSchema.parse({ runs });
    },

    async [V4_METHODS.conversationWorkflowRunEvents](rawParams: unknown) {
      const params = v4ConversationWorkflowRunEventsParamsSchema.parse(rawParams);
      const journal = await ownedJournal(params.sessionId, params.runId);
      if (!journal) return v4ConversationWorkflowRunEventsResultSchema.parse({ events: [], hasMore: false });
      const page = {
        ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
        limit: params.limit ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
        maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
      };
      const { events, hasMore } = supportsEventPages(journal)
        ? journal.listEventPage(params.runId, page)
        : pageByCountOnly(journal, params.runId, page);
      return v4ConversationWorkflowRunEventsResultSchema.parse({
        events: events.map((stored) => toProtocolEvent(stored.sequence, stored.event)),
        hasMore,
      });
    },

    async [V4_METHODS.conversationWorkflowRunArtifacts](rawParams: unknown) {
      const params = v4ConversationWorkflowRunArtifactsParamsSchema.parse(rawParams);
      const journal = await ownedJournal(params.sessionId, params.runId);
      const artifacts = journal ? artifactsOf(params.runId, journal).artifacts : undefined;
      return v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: artifacts ?? [] });
    },

    async [V4_METHODS.conversationWorkflowRunArtifactData](rawParams: unknown) {
      const params = v4ConversationWorkflowRunArtifactDataParamsSchema.parse(rawParams);
      const journal = await ownedJournal(params.sessionId, params.runId);
      if (!journal)
        return v4ConversationWorkflowRunArtifactDataResultSchema.parse({ items: [], hasMore: false });
      const limit = Math.max(
        1,
        Math.min(
          params.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
          WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage,
        ),
      );
      return v4ConversationWorkflowRunArtifactDataResultSchema.parse(
        listArtifactItemsFrom(journal, params.runId, params.artifactId, {
          ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
          limit,
          maxBytes: WORKFLOW_ARTIFACT_LIMITS.maxPageBytes,
          ...(params.fields === undefined ? {} : { fields: params.fields }),
        }),
      );
    },

    async [V4_METHODS.conversationWorkflowRunArtifactRead](rawParams: unknown) {
      const params = v4ConversationWorkflowRunArtifactReadParamsSchema.parse(rawParams);
      const artifact = await readArtifactPayload(params);
      const totalBytes = artifact.bytes.byteLength;
      const start = Math.min(params.offset, totalBytes);
      const end = Math.min(start + params.limit, totalBytes);
      return v4ConversationWorkflowRunArtifactReadResultSchema.parse({
        dataBase64: Buffer.from(artifact.bytes.subarray(start, end)).toString("base64"),
        mediaType: artifact.mediaType,
        totalBytes,
        nextOffset: end < totalBytes ? end : null,
      });
    },

    async [V4_METHODS.conversationWorkflowRunWorkspace](rawParams: unknown) {
      const params = v4ConversationWorkflowRunWorkspaceParamsSchema.parse(rawParams);
      const journal = await deps.journal();
      const nodes =
        (journal
          ? await listWorkspaceNodesFrom({ journal, parentSessionId: params.sessionId }, params.runId)
          : undefined) ?? [];
      const truncated = nodes.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes;
      return v4ConversationWorkflowRunWorkspaceResultSchema.parse({
        nodes: truncated ? nodes.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes) : nodes,
        ...(truncated ? { truncated: true } : {}),
      });
    },

    async [V4_METHODS.conversationWorkflowRunNodeResult](rawParams: unknown) {
      const params = v4ConversationWorkflowRunNodeResultParamsSchema.parse(rawParams);
      const journal = await deps.journal();
      const maxBytes = Math.max(
        1,
        Math.min(
          params.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
          WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
        ),
      );
      const result = journal
        ? await readWorkspaceNodeResultFrom(
            { journal, parentSessionId: params.sessionId },
            params.runId,
            params.siteId,
            params.ordinal,
            { maxBytes },
          )
        : undefined;
      if (result === undefined) {
        throw new Error(
          `fault.workflowRunNodeResult.notFound: ${params.runId}/${params.siteId}@${params.ordinal}`,
        );
      }
      return v4ConversationWorkflowRunNodeResultResultSchema.parse(result);
    },
  };
}
