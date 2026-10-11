/**
 * **Settlement-order gate** for replay (docs/execution-engine.md, “Replaying the settle order”).
 *
 * Site ordinals are counters assigned when calls arrive, so each journal call a branch makes **after** an await
 * is numbered by the order in which fan-out work completes, not by the order in which the script started it. That ordering depends on wall-clock timing, and node rows contain nothing
 * that can reproduce it: releasing cached settlements in admission order makes replayed `Promise.all` resume continuations in array order. The first `report`
 * after the join then receives the journal sequence for the branch that finished first, and the run fails its own defensive check
 * (`InputHashMismatch`), blaming a deterministic script for nondeterminism. Observed in production on 2026-09-17: five parallel research branches
 * completed in order 1, 4, 2, 5, 3, and resume failed at report#2@2.
 *
 * Therefore resume replays **scheduling**, not only answers: this gate holds the original
 * settlement order, parking cached settlements at their release point until all earlier entries
 * have been released. Instances outside the order table pass through—the gate constrains only
 * those with recorded evidence. Old journals (events from before this rule) keep their prior
 * behavior, and a run unknown to the gate can never deadlock.
 */

import { isArtifactPresetOp } from "../facade/registry.js";
import { NODE_KINDS, type RunEventType } from "./journal-read-types.js";
import type { InstanceRef, JournalStorePort, NodeKind, NodeRecord, RunEvent } from "./types.js";
import { refToString } from "./types.js";

/**
 * Node kinds that always resolve a promise during replay: every kind except `report` (void) and `artifact` (see member-specific rules in
 * {@link claimsOnReplay}). Derived from {@link NODE_KINDS}, so newly added kinds are included by default.
 */
export const REPLAY_WORK_KINDS: readonly NodeKind[] = NODE_KINDS.filter(
  (kind) => kind !== "report" && kind !== "artifact",
);

/** Settlement order depends only on these three event kinds ({@link settledInstanceKey}); other events need not be read. */
const SETTLE_EVENT_TYPES: readonly RunEventType[] = [
  "node-settled",
  "artifact-published",
  "artifact-failed",
];

/**
 * Node rows needed for settlement ordering: work rows **omit results** (only kind / status / coordinates are needed); artifact rows include results (member family is in
 * `result.kind`, and artifact rows are bounded: 32 IDs × 16 versions each). Report rows are never read—they do not claim
 * the gate, and a run can contain 65,536 of them (docs/execution-engine.md, “Reading the journal”).
 */
export function readReplayRows(
  journal: JournalStorePort,
  runId: string,
): { workRows: NodeRecord[]; artifactRows: NodeRecord[] } {
  return {
    workRows: journal.listNodes(runId, { kinds: REPLAY_WORK_KINDS, withResult: false }),
    artifactRows: journal.listNodes(runId, { kinds: ["artifact"], withResult: true }),
  };
}

export class ReplaySettleOrder {
  /** Instance key → its position in the original settlement order. */
  private readonly position: ReadonlyMap<string, number>;
  /** Position released so far (cursor in the order table). */
  private cursor = 0;
  /** Release actions that have arrived and are waiting for their turn. */
  private readonly parked = new Map<string, () => void>();
  /** Release actions whose turn has arrived, queued for delivery in a microtask (FIFO; see {@link enqueue}). */
  private queue: Array<() => void> = [];
  private flushing = false;
  /** Gate permanently opens after run settlement (see {@link open}). */
  private opened = false;

  constructor(private readonly order: readonly string[] = []) {
    const position = new Map<string, number>();
    order.forEach((key, index) => position.set(key, index));
    this.position = position;
  }

  static empty(): ReplaySettleOrder {
    return new ReplaySettleOrder([]);
  }

  /** First-observed settlement order (for diagnostics and tests). */
  recorded(): readonly string[] {
    return this.order;
  }

  /**
   * Release one replay hit subject to the order. Execute immediately if this instance is absent
   * from the table (a new call or old journal), the gate is open, or its position has passed;
   * otherwise park it until its turn.
   */
  hold(instance: InstanceRef, release: () => void): void {
    const key = refToString(instance);
    const at = this.position.get(key);
    if (this.opened || at === undefined || at < this.cursor) {
      release();
      return;
    }
    this.parked.set(key, release);
    this.pump();
  }

  /**
   * Delivery always happens after **the call that created the promise**: queue the release action
   * and execute it in a later microtask.
   *
   * Without this extra hop, the order reverses: every branch in `Promise.all` starts its call in
   * the same synchronous slice, and the head entry's release would run synchronously **inside its
   * own `ask()`** before its `await` is attached. Its continuation would then queue after an
   * earlier `await` already attached and just resolved by this pump. The microtask hop lets every
   * `await` attach first, so delivery order equals release order. This is not a clock: the hop is
   * deterministic and the queue is FIFO.
   */
  private enqueue(release: () => void): void {
    this.queue.push(release);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => this.flush());
  }

  /** Execute scheduled deliveries in FIFO order (a no-op on an empty queue, so safe to repeat). */
  private flush(): void {
    this.flushing = false;
    const batch = this.queue;
    this.queue = [];
    for (const release of batch) release();
  }

  /**
   * Run settlement: permanently open the gate and release parked actions in recorded order.
   *
   * If not released, the script-side promise never resolves—the harness immediately closes its sandbox, but in same-process
   * execution (engine tests, `EvalWorkflowSnippet`) this hangs forever. Releasing after settlement is safe:
   * the engine has called markSettled, and every host path starts with `isRunSettled()`.
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    // Release already queued actions in order first: settlement paths call this **before**
    // `run-settled` and synchronously drain this batch, so hit events do not appear after the
    // terminal event. Each parked item's await is already attached, so no extra hop is needed now.
    this.flush();
    for (let i = this.cursor; i < this.order.length; i++) {
      const key = this.order[i];
      if (key === undefined) continue;
      const release = this.parked.get(key);
      if (release === undefined) continue;
      this.parked.delete(key);
      release();
    }
    this.cursor = this.order.length;
    // Keys outside the order table never enter parked, so this should be empty; clear defensively
    // and never leave a promise without a release.
    const leftovers = [...this.parked.values()];
    this.parked.clear();
    for (const release of leftovers) release();
  }

  /** Advance as far as possible: release the head entry if it has arrived, then check the next one. */
  private pump(): void {
    while (this.cursor < this.order.length) {
      const key = this.order[this.cursor];
      if (key === undefined) break;
      const release = this.parked.get(key);
      if (release === undefined) break;
      this.parked.delete(key);
      this.cursor++;
      this.enqueue(release);
    }
  }
}

/**
 * Recover original settlement order from the run's own event log.
 *
 * Use events rather than a new column as the source of truth: settlement order is **already**
 * recorded event by event in `dwf_event`, persisted in the same write as journal rows. Reading it
 * requires no migration and makes journals from before this rule immediately resumable (54 of 258
 * runs in the local database had this shape). `recoverImportClosure` already follows the same
 * approach, recovering cache closure from event order without a schema change.
 *
 * Keep only the **first settlement for each instance**: replay emits cached events again in this
 * gate's order, so taking the first occurrence keeps the order stable across generations and the
 * third generation restores the same table again.
 *
 * Keep only terminal rows that “settle a promise during replay”: `report` returns void and preset
 * artifact declarations are synchronous, so neither claims an entry; including them would block
 * the cursor. Rows still `running` are re-executed live and do not claim an entry either.
 */
export function recoverSettleOrder(
  journal: JournalStorePort,
  runId: string,
  /** Node rows already read (the engine's resume path needs them anyway; pass them here to avoid a second read). */
  nodes: readonly NodeRecord[] = Object.values(readReplayRows(journal, runId)).flat(),
): ReplaySettleOrder {
  const claimable = new Set<string>();
  for (const node of nodes) {
    if (node.status !== "completed" && node.status !== "failed") continue;
    if (!claimsOnReplay(node)) continue;
    claimable.add(refToString(node));
  }
  if (claimable.size === 0) return ReplaySettleOrder.empty();

  const order: string[] = [];
  const seen = new Set<string>();
  for (const { event } of journal.listEvents(runId, {
    types: SETTLE_EVENT_TYPES,
    reportItems: { limit: 0 },
  })) {
    const key = settledInstanceKey(event);
    if (key === undefined || seen.has(key) || !claimable.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return new ReplaySettleOrder(order);
}

/** Map a settlement event to its instance key; undefined for non-settlement events. */
function settledInstanceKey(event: RunEvent): string | undefined {
  if (
    event.type === "node-settled" ||
    event.type === "artifact-published" ||
    event.type === "artifact-failed"
  ) {
    return refToString(event.instance);
  }
  return undefined;
}

/**
 * Whether replaying this row settles a promise the script can await.
 * ask / world nodes do; `report` does not (`void`). Artifact rows depend on member family: content
 * members are effects (async), while preset declarations are synchronous, so only the former claim
 * the gate. Failed artifact rows can only come from content members (declarations have no rejection channel).
 */
function claimsOnReplay(node: NodeRecord): boolean {
  if (node.kind === "report") return false;
  if (node.kind !== "artifact") return true;
  if (node.status === "failed") return true;
  const kind = (node.result as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && !isArtifactPresetOp(kind);
}

/**
 * Settle one replay hit under the order gate: execute `settle` only when its turn arrives and
 * resolve/reject according to its result.
 * Used by promise paths (world nodes and content artifacts); asks already release through a
 * callback, so use {@link ReplaySettleOrder.hold} directly.
 */
export function heldResolution<T>(
  hold: (instance: InstanceRef, release: () => void) => void,
  instance: InstanceRef,
  settle: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    hold(instance, () => {
      try {
        resolve(settle());
      } catch (cause) {
        reject(cause);
      }
    });
  });
}
