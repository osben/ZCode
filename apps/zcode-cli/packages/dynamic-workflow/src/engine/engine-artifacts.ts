/**
 * engine.ts reached oxlint's max-lines limit (400 lines), so **user-facing artifact**
 * (`artifact.*`) publication/declaration/admission/settlement/resume recovery moved here; public
 * exports still come from engine.ts.
 *
 * Terminology: artifact below always means a **user-facing artifact** published by a script, not
 * RunSettlement.artifact. Free functions read/write engine state through the {@link EngineState}
 * seam; same-named WorkflowEngine methods are thin delegates.
 */

import { canonicalJson, inputHash } from "./hash.js";
import { ARTIFACT_CAPS } from "../facade/artifact-caps.js";
import {
  isArtifactPresetOp,
  type ArtifactContentOp,
  type ArtifactPresetOp,
} from "../facade/registry.js";
import { heldResolution } from "./replay-order.js";
import {
  primaryArtifactId,
  primaryConflict,
  primaryConflictMessage,
} from "./engine-artifacts-primary.js";
import { validateArtifactSpec } from "./artifact-spec.js";
import { hashMismatch } from "./scheduler.js";
import type { EngineState } from "./engine-state.js";
import type {
  ArtifactPublishRequest,
  ArtifactRef,
  ArtifactVersionRecord,
  InstanceRef,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * Publish a **content artifact** (`artifact.file` / `artifact.markdown`). This is an effect family:
 * the driver copies bytes into the store, success returns {@link ArtifactRef}, and failure rejects
 * in a **catchable** way—the script's gate pattern is `try { await artifact.file(...) } catch {
 * ...ask a subagent to fill it in... }`.
 *
 * Order:
 * 1. `nextOrdinal` -> journal hit? On a hit, short-circuit after checking inputHash. A successful
 *    record returns its ArtifactRef; **a recorded failure rejects again** (resume recovers from a
 *    crash, not revalidates: a failed publication remains failed after recovery, and rerunning it
 *    could make the script's catch branch take a different path). Never re-emit events on a hit
 *    (same as report).
 * 2. On a miss: kind ownership -> ID limit -> version limit; all three reject at node level (the
 *    promise can reject).
 * 3. Compute the version **before** dispatch and pass it to the driver (the store's toolCallId must
 *    include it, with one copy of bytes per version).
 * 4. `putNode(running)` -> driver -> on success `putNode(completed)` + `artifact-published`; on
 *    failure `putNode(failed)` + `artifact-failed` -> reject.
 *
 * Neither path emits **node lifecycle events** (node-queued/dispatched/settled): artifact sites are
 * not nodes in either graph. A node-settled event at such a site would be reduced into `nodes[]`,
 * appearing as an unexplained unknown node in the run panel.
 */
export function publishContentArtifact(
  state: EngineState,
  siteId: string,
  op: ArtifactContentOp,
  args: unknown[],
): Promise<ArtifactRef> {
  if (state.isRunSettled()) return Promise.reject(state.runError());
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const id = args[0];
  const payload = args[1];
  // Runtime guard for argument shape (compile-time literal-ID diagnostics and facade types are the
  // primary gate): a non-string reaching here means something bypassed compilation. Use
  // DriverError rather than an Artifact* code, so those codes remain specific to their own cases
  // (same reasoning as probeReportItem for "item is not JSON").
  //
  // These two cases **write no journal row and emit no event**, unlike all failure paths below.
  // They are **deterministic**: the result depends only on args, there is no driver round trip, and
  // replaying the same call on resume necessarily produces the same rejection. No row is needed to
  // pin it (the "persist settled failures" rule applies to failures after driver execution, which
  // might not recur next time). There is also no ID to write to `artifact_id` or an event; inventing
  // one would mislead readers into thinking an artifact existed.
  if (typeof id !== "string" || id === "") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: id must be a non-empty string (at ${refToString(instance)}).`,
      ),
    );
  }
  if (typeof payload !== "string") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        op === "file"
          ? `artifact.file: path must be a string (at ${refToString(instance)}).`
          : `artifact.markdown: content must be a string (at ${refToString(instance)}).`,
      ),
    );
  }
  // The **engine** reads `opts.primary`: the driver allows unknown opts keys, while "at most one
  // primary per run" is a run-level fact known only to the engine. A non-boolean value is another
  // deterministic guard like the two above: no row and no event.
  const primaryOption = (args[2] as { primary?: unknown } | undefined)?.primary;
  if (primaryOption !== undefined && typeof primaryOption !== "boolean") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: opts.primary must be a boolean (at ${refToString(instance)}).`,
      ),
    );
  }
  const hash = inputHash({ args, id, op });

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      const err = hashMismatch(instance, recorded.inputHash, hash);
      state.failRun(err);
      return Promise.reject(err);
    }
    // Follow ask/world hit behavior: pass the release point through the replay ordering gate.
    // Publication is an effect and the script awaits it, so it can determine the order of later
    // continuations. Predeclared artifacts are synchronous void and never use or occupy this gate.
    if (recorded.status === "completed") {
      const record = recorded.result as ArtifactVersionRecord;
      return heldResolution(state.holdForReplay, instance, () => ({
        id: record.id,
        version: record.version,
      }));
    }
    if (recorded.status === "failed") {
      return heldResolution(state.holdForReplay, instance, () => {
        throw WorkflowError.fromJSON(recorded.error!);
      });
    }
    // status === "running": interrupted during execution, so fall through to live execution below
    // (byte copying is idempotent, and versions derive from the number of **completed rows**, so a
    // retry does not skip a version).
  }

  // Sticky: if this ID is already primary, this version is too, whether or not `primary` is set again.
  const idState = state.artifacts.get(id);
  const primary = primaryOption === true || idState?.primary === true;
  const admission = admitArtifact(state, id, op, primary);
  if (admission !== undefined) {
    return Promise.reject(settleArtifactFailure(state, instance, hash, { id, op }, admission));
  }

  const version = (idState?.versions ?? 0) + 1;
  const publish = state.driver.executeArtifactPublish;
  if (publish === undefined) {
    // The assembled driver has no publication capability (pure replay/a fake without a store).
    // **Fail loudly with a named error** rather than silently degrading to "published an empty
    // artifact"; the script sees the error and the node is persisted as failed.
    return Promise.reject(
      settleArtifactFailure(
        state,
        instance,
        hash,
        { id, op },
        new WorkflowError(
          "ArtifactStoreUnavailable",
          `Cannot publish "${id}": this host has no artifact store (at ${refToString(instance)}).`,
        ),
      ),
    );
  }

  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "running",
    artifactId: id,
  });

  const request: ArtifactPublishRequest = {
    runId: state.runId,
    siteId,
    ordinal,
    op,
    id,
    version,
    ...(op === "file" ? { path: payload } : { content: payload }),
    ...(args[2] === undefined ? {} : { opts: args[2] }),
  };
  return publish.call(state.driver, request).then(
    (record) => settleArtifactPublish(state, instance, hash, { id, op, version, primary }, record),
    (cause: unknown) => {
      const err =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError("DriverError", `Artifact publish failed: ${op} "${id}".`, {
              cause,
            });
      throw settleArtifactFailure(state, instance, hash, { id, op }, err);
    },
  );
}

/**
 * Declare a **predeclared artifact** (`artifact.chart` / `table` / `metrics` / `board`). This family
 * is synchronous, returns no value, and **does not use the driver**; a declaration has nothing to wait for.
 *
 * Order: `nextOrdinal` -> return on hit -> validate spec shape -> existing declaration with same
 * ID? Same canonical form => idempotent no-op (no new row/event); different => failRun -> limits
 * -> `putNode(completed)` + `artifact-published`.
 *
 * All three failures (invalid spec/same ID with different spec/limit exceeded) call failRun rather
 * than reject: void return has no rejection channel, using the same reasoning as report's two limits.
 */
export function declarePresetArtifact(
  state: EngineState,
  siteId: string,
  op: ArtifactPresetOp,
  args: unknown[],
): void {
  if (state.isRunSettled()) return; // Same behavior as report/log.
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const id = args[0];
  if (typeof id !== "string" || id === "") {
    state.failRun(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: id must be a non-empty string (at ${refToString(instance)}).`,
      ),
    );
    return;
  }
  const spec = args[1];
  const hash = inputHash({ args, id, op });

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      state.failRun(hashMismatch(instance, recorded.inputHash, hash));
      return;
    }
    return; // Replay deduplication: skip silently (same as report).
  }

  const problem = validateArtifactSpec(op, spec);
  if (problem !== undefined) {
    state.failRun(
      new WorkflowError(
        "ArtifactSpecInvalid",
        `Artifact "${id}" has an invalid spec (at ${refToString(instance)}): ${problem}`,
      ),
    );
    return;
  }

  const canonical = canonicalJson(spec);
  const idState = state.artifacts.get(id);
  if (idState !== undefined) {
    if (idState.kind !== op) {
      state.failRun(
        new WorkflowError(
          "ArtifactKindMismatch",
          `Artifact id "${id}" is already a ${idState.kind} and cannot be declared as a ${op} ` +
            `(at ${refToString(instance)}). An id belongs to one artifact kind for the whole run; ` +
            `use a different id.`,
        ),
      );
      return;
    }
    if (idState.spec === canonical) return; // Idempotent no-op: no new row and no event.
    state.failRun(
      new WorkflowError(
        "ArtifactRedeclared",
        `Artifact "${id}" was already declared with a different spec (at ${refToString(instance)}). ` +
          `The spec for one id must stay identical (an identical re-declaration is a no-op); ` +
          `declare it once at the top of the script.`,
      ),
    );
    return;
  }
  // `primary` is part of the canonical spec, so changing the flag for the same ID is
  // ArtifactRedeclared (already rejected above). The only case left is a **new** ID trying to be
  // primary while another ID already is; the predeclared family has no rejection channel, so call failRun.
  const wantsPrimary = (spec as { primary?: unknown }).primary === true;
  const holder = wantsPrimary ? primaryArtifactId(state) : undefined;
  if (holder !== undefined && holder !== id) {
    state.failRun(
      new WorkflowError(
        "ArtifactPrimaryConflict",
        primaryConflictMessage(id, holder, `declare "${id}" without primary`, instance),
      ),
    );
    return;
  }
  if (state.artifacts.size >= ARTIFACT_CAPS.maxArtifactsPerRun) {
    state.failRun(
      new WorkflowError(
        "ArtifactCapExceeded",
        `Cannot declare "${id}": this run already has ${ARTIFACT_CAPS.maxArtifactsPerRun} artifact ` +
          `ids, the maximum. Reuse an existing id or publish fewer artifacts.`,
      ),
    );
    return;
  }

  // Declaration is **one write** (same as report): there is no driver call between admission and settlement, so nothing can fail in between.
  const record = presetRecord(id, op, spec);
  state.artifacts.set(id, {
    kind: op,
    spec: canonical,
    versions: 1,
    ...(wantsPrimary ? { primary: true as const } : {}),
  });
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "completed",
    result: record,
    artifactId: id,
  });
  state.record({ type: "artifact-published", instance, artifact: record });
}

/**
 * Admission for content artifacts: kind ownership -> ID limit -> version limit. Return a rejection reason; `undefined` means allow.
 *
 * All three are **node-level** rejections (content members have a promise to reject), contrasting
 * with the same three cases in the predeclared family, which can only call failRun. Same facts,
 * different channels because of return type, not severity.
 */
function admitArtifact(
  state: EngineState,
  id: string,
  op: ArtifactContentOp,
  primary: boolean,
): WorkflowError | undefined {
  const idState = state.artifacts.get(id);
  if (idState !== undefined && idState.kind !== op) {
    return new WorkflowError(
      "ArtifactKindMismatch",
      `Artifact id "${id}" is already a ${idState.kind} and cannot be published as a ${op}. An id ` +
        `belongs to one artifact kind for the whole run (publishing the same id again creates a ` +
        `new version, and a version cannot change what it is); use a different id.`,
    );
  }
  // Check primary conflicts before limits: reject an ID intended as the deliverable because "a deliverable already exists," not "the limit is full."
  const holder = primaryConflict(state, id, primary);
  if (holder !== undefined) {
    return new WorkflowError(
      "ArtifactPrimaryConflict",
      primaryConflictMessage(id, holder, `publish "${id}" without primary`, undefined),
    );
  }
  if (idState === undefined && state.artifacts.size >= ARTIFACT_CAPS.maxArtifactsPerRun) {
    return new WorkflowError(
      "ArtifactCapExceeded",
      `Cannot publish "${id}": this run already has ${ARTIFACT_CAPS.maxArtifactsPerRun} artifact ` +
        `ids, the maximum. Publish a new version of an existing id instead.`,
    );
  }
  if (idState !== undefined && idState.versions >= ARTIFACT_CAPS.maxVersionsPerArtifact) {
    return new WorkflowError(
      "ArtifactVersionCapExceeded",
      `Artifact "${id}" already has ${idState.versions} versions, the maximum of ` +
        `${ARTIFACT_CAPS.maxVersionsPerArtifact}. Publish the final content in fewer versions.`,
    );
  }
  return undefined;
}

/**
 * Content artifact published successfully: persist completed row, update bookkeeping, emit `artifact-published`, and return the ref requested by the script.
 *
 * Always use the identity fields (ID/kind/version) **computed by the engine** (`issued`), not
 * same-named fields in the driver's record. The engine derives the version from the journal and
 * passes it down; round-tripping it through the driver would add another chance for mismatch. The
 * driver record owns uri/bytes/contentType/sourcePath; persist those fields unchanged.
 */
function settleArtifactPublish(
  state: EngineState,
  instance: InstanceRef,
  hash: string,
  issued: { id: string; op: ArtifactContentOp; version: number; primary: boolean },
  record: ArtifactVersionRecord,
): ArtifactRef {
  if (state.isRunSettled()) throw state.runError();
  // A driver round trip separates admission from settlement, so two concurrent primary
  // publications can both pass admission. Check again at settlement; the loser follows the failure
  // path. Failed rows do not claim the flag, so the journal can never contain two completed primary artifacts.
  const holder = primaryConflict(state, issued.id, issued.primary);
  if (holder !== undefined) {
    throw settleArtifactFailure(
      state,
      instance,
      hash,
      issued,
      new WorkflowError(
        "ArtifactPrimaryConflict",
        primaryConflictMessage(
          issued.id,
          holder,
          `publish "${issued.id}" without primary`,
          instance,
        ),
      ),
    );
  }
  // The engine stamps the flag; the driver's record owns only uri/bytes/contentType/sourcePath.
  const stored: ArtifactVersionRecord = issued.primary ? { ...record, primary: true } : record;
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "completed",
    result: stored,
    artifactId: issued.id,
  });
  state.artifacts.set(issued.id, {
    kind: issued.op,
    versions: issued.version,
    ...(issued.primary ? { primary: true as const } : {}),
  });
  state.record({ type: "artifact-published", instance, artifact: stored });
  return { id: issued.id, version: issued.version };
}

/**
 * Content artifact publication failed: persist a failed row, emit `artifact-failed`, and return the error to throw.
 *
 * Persisting the failure is an existing replay-correctness requirement (settled failures must be
 * in the journal); otherwise resume would rerun a failure the script had already caught, exactly
 * what "resume is crash recovery, not revalidation" is meant to prevent.
 *
 * A node-settled event would be reduced into `nodes[]` by readers, which look up the matching node
 * by site ID; artifact sites are absent from every graph, so this would appear as an unexplained
 * unknown node in the run panel. `artifact-failed` carries what a failure card needs (ID/kind/
 * structured error) without pretending this was a work step. Success likewise emits only `artifact-published`.
 */
function settleArtifactFailure(
  state: EngineState,
  instance: InstanceRef,
  hash: string,
  issued: { id: string; op: ArtifactContentOp },
  error: WorkflowError,
): WorkflowError {
  const json = error.toJSON();
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "failed",
    error: json,
    artifactId: issued.id,
  });
  state.record({
    type: "artifact-failed",
    instance,
    id: issued.id,
    op: issued.op,
    error: json,
  });
  return error;
}

/**
 * Resume recovery: merge one **completed** artifact row from the journal into in-memory state.
 *
 * **Only completed rows claim IDs**: failed publications occupy no ID, kind, or version. This is
 * not merely graph cleanup: failed rows have no `result` from which to recover the kind. If live
 * execution claimed an ID but resume did not, the same script would get different limit accounting
 * before and after a crash. Kind conflicts are also guarded by compile-time diagnostics; this
 * runtime check (`ArtifactKindMismatch`) handles IDs that were actually published successfully.
 */
export function rememberArtifactRow(
  state: EngineState,
  id: string | undefined,
  result: unknown,
): void {
  if (id === undefined || id === "") return;
  const record = (result ?? undefined) as ArtifactVersionRecord | undefined;
  if (record?.kind === undefined) return;
  const existing = state.artifacts.get(id);
  const spec = record.spec === undefined ? existing?.spec : canonicalJson(record.spec);
  const primary = record.primary === true || existing?.primary === true;
  state.artifacts.set(id, {
    kind: record.kind,
    ...(spec === undefined ? {} : { spec }),
    versions: (existing?.versions ?? 0) + 1,
    ...(primary ? { primary: true as const } : {}),
  });
}

/** Whether this ID has been declared as a **predeclared** artifact (a valid target for a `report` label). */
export function isDeclaredPreset(state: EngineState, id: string): boolean {
  const idState = state.artifacts.get(id);
  return idState !== undefined && isArtifactPresetOp(idState.kind);
}

/** Declared predeclared IDs (lexicographic order), used only to make `ArtifactUndeclared` messages actionable. */
export function declaredPresetIds(state: EngineState): string[] {
  return [...state.artifacts.entries()]
    .filter(([, idState]) => isArtifactPresetOp(idState.kind))
    .map(([id]) => id)
    .sort();
}

/**
 * Persisted record for a predeclared artifact. Lift `title`/`description` **out of the spec**:
 * card readers (run sidebar, notifications, hub) receive only this record and should not decode the
 * spec just to show a title. Keep the full spec unchanged for renderers. Version is always 1; a
 * declaration has no versions because it happens once.
 */
function presetRecord(id: string, op: ArtifactPresetOp, spec: unknown): ArtifactVersionRecord {
  const options = (spec ?? {}) as { title?: unknown; description?: unknown; primary?: unknown };
  return {
    id,
    kind: op,
    version: 1,
    ...(typeof options.title === "string" ? { title: options.title } : {}),
    ...(typeof options.description === "string" ? { description: options.description } : {}),
    spec,
    ...(options.primary === true ? { primary: true as const } : {}),
  };
}
