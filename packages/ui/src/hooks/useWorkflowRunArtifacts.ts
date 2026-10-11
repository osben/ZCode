import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkflowRunArtifact,
  WorkflowRunArtifactKind,
  WorkflowRunArtifactSummary,
  WorkflowRunArtifactVersion,
} from "@zcode/shared/zcode-protocol-v4";
import { orderArtifactsPrimaryFirst } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/** Terminology: artifact in this module means output published for users through script `artifact.*`, not the engine-internal value returned by the script’s top level. */

/** Merged view of one artifact: fresh metadata from the live projection + complete metadata from the journal (version history and spec). Both sources are required, so this type is their union, not an either/or. The live projection (`workflowRuns[].artifacts`) deliberately includes only latest-version metadata: it is a high-frequency status key, and including the spec and all versions would resend unchanged data on every frame. Journal queries provide `versions` and `spec`; prebuilt boards cannot render without a spec, so query the journal even when the run is still in the live projection. */
export interface WorkflowRunArtifactView {
  id: string;
  kind: WorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  /** Size in bytes of the latest version (content artifacts only). */
  bytes?: number;
  /** Workspace-relative original path (`file` only), used by “Show in workspace” to locate it. */
  sourcePath?: string;
  /** Latest version number. */
  version: number;
  /** Versions in ascending order. If the journal query is absent (older CLI/read failure), omit the whole field so the version stepper falls back to latest only. */
  versions?: readonly WorkflowRunArtifactVersion[];
  /** Spec for a prebuilt board; also absent when the journal query is unavailable, so the board card falls back to “details unavailable.” */
  spec?: unknown;
  /** Number of reports tagged with this ID; refresh signal for the board-data hook. */
  itemCount: number;
  /** Deliverables for the run; present if either source includes them. */
  primary?: true;
}

interface WorkflowRunArtifactsViewState {
  artifacts: readonly WorkflowRunArtifactView[];
  /** Primary metadata source. `live` means the run remains in the live projection (journal only fills spec/versions); `journal` means cold recovery or eviction by the eight-run limit, so the full list comes from the journal. This does not indicate whether the journal was queried—both cases query it. It is an observable signal for consumers/tests describing whether the list grew with the live run or was read back from logs later. */
  source: "live" | "journal";
  loading: boolean;
  /** Session does not support artifact queries (older CLI): content artifacts can still be listed, but prebuilt boards cannot be rendered. */
  unavailable: boolean;
  error: string | null;
  /** This list is complete: either the live projection is present (its 32-item bound matches the engine’s per-run maximum, so it is never truncated) or the journal has returned. Completed cards use this to decide whether to show a numeric +N or an ellipsis. Notification payload truncation at 8 items is a fact about the payload, not the list rendered here. When the capability is absent (older CLI), the list may truly be incomplete and remains false. */
  complete: boolean;
}

/** Distinguish a missing capability (CLI lacks the host-side `listArtifacts` query) from a run with no artifacts: the former should make prebuilt cards say “details unavailable,” while the latter omits the whole section. Uses the same error-reading pattern as `useWorkflowRunJournalSummaries`: after crossing JSON-RPC, only message is reliable, so accept both reasonCode and capability-name patterns. */
function isWorkflowRunArtifactsCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("ArtifactRows");
}

/** Shape signature for the summaries in the live projection: concatenate `id:kind:version` for each item. Use this instead of the whole-array reference to decide when to re-query the journal. Every report projection creates a new array (itemCount changed), but a count change does not change artifact versions/spec; depending on the reference would make a board query the journal after every report. A new artifact or a new version for the same ID does change this signature, and both require another query (spec for a new artifact, versions for an update). */
function summariesSignature(summaries: readonly WorkflowRunArtifactSummary[] | undefined): string {
  if (summaries === undefined) return "";
  return summaries.map((summary) => `${summary.id}:${summary.kind}:${summary.version}`).join("|");
}

function viewFromJournal(record: WorkflowRunArtifact): WorkflowRunArtifactView {
  return {
    id: record.id,
    kind: record.kind,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
    ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
    ...(record.spec === undefined ? {} : { spec: record.spec }),
    // Journal entries do not contain bytes (they are stored on versions), so read them from the latest version.
    ...(() => {
      const latest = record.versions.at(-1);
      return latest?.bytes === undefined ? {} : { bytes: latest.bytes };
    })(),
    version: record.version,
    versions: record.versions,
    itemCount: record.itemCount,
    ...(record.primary === true ? { primary: true as const } : {}),
  };
}

function viewFromSummary(summary: WorkflowRunArtifactSummary): WorkflowRunArtifactView {
  return {
    id: summary.id,
    kind: summary.kind,
    ...(summary.title === undefined ? {} : { title: summary.title }),
    ...(summary.contentType === undefined ? {} : { contentType: summary.contentType }),
    ...(summary.bytes === undefined ? {} : { bytes: summary.bytes }),
    version: summary.version,
    itemCount: summary.itemCount ?? 0,
    ...(summary.primary === true ? { primary: true as const } : {}),
  };
}

/**
 * Merge the two sources. **The live projection determines order and identity** because it reflects the run
 * as it grows; the journal fills only fields intentionally omitted by the live projection. IDs present in the
 * journal but absent from the live projection are appended at the end. These are real artifacts beyond the
 * projection's 32-item cap; dropping them would make artifacts disappear from a full run.
 *
 * The primary deliverable comes first, with the rest in first-publication order: the live projection upserts
 * in publication order, and the journal path is already sorted by the server. They converge here to one order.
 */
function mergeArtifacts(
  live: readonly WorkflowRunArtifactSummary[] | undefined,
  journal: readonly WorkflowRunArtifact[] | undefined,
): readonly WorkflowRunArtifactView[] {
  return orderArtifactsPrimaryFirst(mergeArtifactSources(live, journal));
}

function mergeArtifactSources(
  live: readonly WorkflowRunArtifactSummary[] | undefined,
  journal: readonly WorkflowRunArtifact[] | undefined,
): readonly WorkflowRunArtifactView[] {
  if (live === undefined) {
    return journal === undefined ? [] : journal.map(viewFromJournal);
  }
  const byId = new Map((journal ?? []).map((record) => [record.id, record] as const));
  const merged = live.map((summary) => {
    const record = byId.get(summary.id);
    if (record === undefined) return viewFromSummary(summary);
    byId.delete(summary.id);
    // The live projection has the newer version (the journal query may lag one publication); only the journal has spec/versions.
    // Take `itemCount` from the live projection too: it signals refreshes, and a stale value can omit an item.
    return {
      ...viewFromJournal(record),
      ...viewFromSummary(summary),
      ...(record.versions.length === 0 ? {} : { versions: record.versions }),
      ...(record.spec === undefined ? {} : { spec: record.spec }),
      ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
      ...(record.description === undefined ? {} : { description: record.description }),
    } satisfies WorkflowRunArtifactView;
  });
  return [...merged, ...[...byId.values()].map(viewFromJournal)];
}

/**
 * Artifact list for a workflow run.
 *
 * ```
 * Live projection workflowRuns[].artifacts ─┐
 *   (fresh, no spec, capped at 32)           ├─▶ merge ─▶ artifacts[]
 * journal workflowRunArtifacts ───┘
 *   (complete, with versions + spec)
 * ```
 *
 * Query the journal in **both cases**: when the live projection exists, it fills in spec/versions (the board
 * cannot render without a spec); when the live projection is absent, it is the only source (cold recovery or
 * eviction by the 8-run limit). Refetch when the summaries' **shape signature** changes, not the array reference;
 * see `summariesSignature`.
 */
export function useWorkflowRunArtifacts(options: {
  sessionId: string;
  runId: string;
  /**
   * Artifact summaries for this run in the live projection. `undefined` means the run is absent from the live
   * projection (so `source` is journal); an empty array means the run is present with no artifacts. These differ
   * semantically, so callers must not collapse the former into the latter.
   */
  live?: readonly WorkflowRunArtifactSummary[];
  enabled?: boolean;
}): WorkflowRunArtifactsViewState {
  const { workflowRunArtifacts } = useV4Conversation();
  const [journal, setJournal] = useState<readonly WorkflowRunArtifact[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Request version: discard responses that arrive late after switching runs or sessions so they cannot pollute the new run's list.
  const requestVersionRef = useRef(0);

  const enabled =
    options.enabled !== false && options.sessionId.length > 0 && options.runId.length > 0;
  const signature = summariesSignature(options.live);
  const { sessionId, runId } = options;

  const fetchArtifacts = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await workflowRunArtifacts({ sessionId, runId });
      if (requestVersion !== requestVersionRef.current) return;
      setJournal(result.artifacts);
      setUnavailable(false);
      setLoading(false);
    } catch (caught) {
      if (requestVersion !== requestVersionRef.current) return;
      setLoading(false);
      if (isWorkflowRunArtifactsCapabilityMissing(caught)) {
        // Missing capability is not an error: content artifact cards can still render from the live projection; only the board is unavailable.
        setJournal(undefined);
        setUnavailable(true);
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.warn("[workflow-artifacts] 读取产物清单失败", { error: message, runId, sessionId });
      setError(message);
    }
  }, [runId, sessionId, workflowRunArtifacts]);

  useEffect(() => {
    // On a run/session switch, clear the old run's list before refetching. Stale artifacts on screen are more dangerous than a blank state.
    requestVersionRef.current += 1;
    setJournal(undefined);
    setUnavailable(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void fetchArtifacts();
    // The signature is an intentional dependency: refetch when an artifact appears or the same ID gets a new version, but not when `itemCount` changes.
  }, [enabled, fetchArtifacts, signature]);

  return useMemo(
    () => ({
      artifacts: mergeArtifacts(options.live, journal),
      source: options.live === undefined ? "journal" : "live",
      loading,
      unavailable,
      error,
      complete: options.live !== undefined || journal !== undefined,
    }),
    [error, journal, loading, options.live, unavailable],
  );
}
