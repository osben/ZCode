// ============================================================
// Read back the bytes of a user-facing artifact (implementation of DynamicWorkflowRunPort.readArtifact).
// ============================================================
//
// ⚠ Terminology: artifact here means an output published for the **user** by a script through `artifact.*` (a journal
// row with `kind = "artifact"`), **not** the engine-internal `RunSettlement.artifact` (the script's top-level return value,
// called `output` / `result` at the port).
//
// Split from dynamic-workflow-run-service.ts (already over its max-lines limit) for the same reason the driver's publish path was split into workflow-artifact-publish.ts:
// reading bytes requires three steps—authorize, locate, and read from the store—and each has an invariant that must be documented.
//
// **Authorization chain** (same invariant as attachmentRead):
//
//   Caller-provided (runId, artifactId, version)
//        │
//        ├─① Does a dwf_run row exist for runId?                     No ⇒ undefined
//        ├─② Does its parent_session_id match this service's parent session? No ⇒ undefined
//        ├─③ Is there a completed artifact row for (artifactId, version) in the journal? No ⇒ undefined
//        ├─④ Does that row's record contain a uri? (prebuilt dashboards do not) No ⇒ undefined
//        └─⑤ Read from the store using the uri **from the row**
//
// Step ⑤ is the key: IDs from the renderer are used only to **look up a journal row** and never become paths directly.
// Any failed step returns undefined rather than throwing. "No such version," "not your run," and "this is a dashboard" are the same business fact to the caller (the gateway normalizes them to not found); distinguishing them would tell an unauthorized caller which half it guessed correctly.

import type {
  DynamicWorkflowRunArtifactBytes,
  ToolArtifactStorePort,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";

import {
  artifactRowId,
  supportsArtifactReads,
} from "./dynamic-workflow-run-artifact-queries.js";

interface WorkflowArtifactReadDeps {
  journal: JournalStorePort;
  /** This service's parent session (= this app's session), used for the step ② authorization check. */
  parentSessionId: string;
  /**
   * Store containing the bytes. **Optional:** pure replay / no-store configurations cannot access bytes, so readback is unavailable
   * (the same configuration fact represented on the driver side by `ArtifactStoreUnavailable`).
   */
  artifactStore?: ToolArtifactStorePort;
}

/**
 * Read all bytes for an artifact version. The gateway handles chunking (≤ 512 KiB per chunk); this returns the full file at once, with the same 20 MiB limit as attachments.
 * Since authorization is checked once per read, splitting this chain into a chunk loop would require querying the journal again for every chunk.
 */
export async function readWorkflowArtifactBytes(
  deps: WorkflowArtifactReadDeps,
  runId: string,
  artifactId: string,
  version: number,
): Promise<DynamicWorkflowRunArtifactBytes | undefined> {
  const store = deps.artifactStore;
  // Binary readback is an **optional member**: if the store lacks it, do not fall back to reading text and decoding it—the bug recorded in ToolBinaryArtifactReadResult
  // was exactly this (office files were corrupted by decoding them as UTF-8).
  if (store?.readToolResultBinaryArtifact === undefined) return undefined;

  // ①②: the run exists and belongs to this session. getRun is on the engine port, so no capability introspection is needed.
  const run = deps.journal.getRun(runId);
  if (run === undefined) return undefined;
  // **Do not allow** legacy rows with a NULL parent_session_id: the design requires sessionId to equal the run's
  // parentSessionId, and NULL means there is nothing to compare against—"cannot determine" does not mean "authorized."
  if (run.parentSessionId === undefined || run.parentSessionId !== deps.parentSessionId) {
    return undefined;
  }

  // ③④: locate the row in the journal and use its uri.
  const located = locateArtifactVersion(deps.journal, runId, artifactId, version);
  if (located === undefined) return undefined;

  // ⑤: only now access the store, using the uri **from the row**.
  const result = await store.readToolResultBinaryArtifact({ uri: located.uri });
  return {
    bytes: result.bytes,
    // Use the value from the **journal record** for contentType, not the store's filename-based guess: the record contains the value the driver derived from its extension table
    // (overridable by `opts.contentType`), which is the exact contract used by UI renderer dispatch. The store's inference table recognizes only 8 extensions and would classify `.csv` as application/json.
    contentType: located.contentType ?? result.contentType,
  };
}

/**
 * Find the **completed** artifact row for `(artifactId, version)` in the journal and return its
 * `uri` and `contentType`.
 *
 * Only completed rows qualify: failed publishes do not claim an id / kind / version and have an empty `result`; allowing one through would attempt to read an undefined uri.
 * Prebuilt dashboard records also lack a `uri` (they have no bytes; their data is a labeled report row in the journal), so they are rejected here too and the caller receives undefined.
 */
function locateArtifactVersion(
  journal: JournalStorePort,
  runId: string,
  artifactId: string,
  version: number,
): { uri: string; contentType?: string } | undefined {
  if (!supportsArtifactReads(journal)) return undefined;
  for (const row of journal.listArtifactRows(runId)) {
    if (row.status !== "completed") continue;
    if (artifactRowId(row) !== artifactId) continue;
    const record = row.result;
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    const fields = record as Record<string, unknown>;
    if (fields.version !== version) continue;
    const uri = typeof fields.uri === "string" && fields.uri.length > 0 ? fields.uri : undefined;
    if (uri === undefined) return undefined;
    const contentType =
      typeof fields.contentType === "string" && fields.contentType.length > 0
        ? fields.contentType
        : undefined;
    return { uri, ...(contentType === undefined ? {} : { contentType }) };
  }
  return undefined;
}
