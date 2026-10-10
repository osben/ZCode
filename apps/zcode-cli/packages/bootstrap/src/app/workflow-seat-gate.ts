// ============================================================
// Run-level seat gate: apply this run's concurrency limit at the **next model request**.
// ============================================================
// The scheduler is the first enforcement point, but it checks the limit only when dispatching. An ask is a full subagent turn and can take minutes; telling a run with eight active asks to allow at most two would require waiting for six asks to finish if we relied on the scheduler alone. This gate is the second enforcement point: after completing its current request, an over-limit subagent **parks before its next turn step**, preserving its session, transcript, and place in the run.
//
// Three rules:
//   1. **Pure:** no clock reads, I/O, or subscriptions. The driver supplies both facts (which asks are active and which subagents have running tools) through its existing observation surfaces (`startAsk` / `emit` in workflow-driver.ts and in-flight counts in workflow-driver-tool-activity.ts). The gate keeps no duplicate state.
//   2. **No shared state with the scheduler**, and neither calls the other. They agree through the equation `activeAsks = working + parked`: a parked subagent's ask remains active and counts against the scheduler's limit. Once anyone is parked, `activeAsks ≥ limit`, so the scheduler cannot dispatch a new ask ahead of a parked one.
//   3. **A limit ≥ 1 cannot deadlock:** parking requires the number working to exceed the limit, so someone is always working; when the FIFO queue is nonempty, its final seat cannot be empty.
//
// Requests made by tools **never** park: that subagent is already working and occupies a seat, so making its WebSearch wait behind itself would be pointless. The admission call only receives `{model}`, which cannot distinguish request types, so the gate reads the fact the driver already tracks for this subagent: whether a tool is currently running.

import type { ModelRequestAdmission } from "@zcode/contracts";
import { refToString, type InstanceRef } from "@zcode/dynamic-workflow";

/** The only subagent fact the gate requests from the driver (implemented in workflow-driver-tool-activity.ts). */
export interface SeatGateSubagent {
  /** Number of tool calls currently running; > 0 means this is a tool-side request and should pass through. */
  toolsInFlight(): number;
}

/** The gate's current counts (the observation surface reads these to assert `activeAsks = working + parked`). */
export interface SeatGateStats {
  limit: number;
  working: number;
  parked: number;
}

export interface WorkflowRunSeatGate {
  /**
   * Change the limit. Raising it immediately unparks FIFO entries up to the new limit; lowering it recalls nobody—the excess subagents finish their current request and park at the next turn step.
   */
  setLimit(limit: number): void;
  /** An ask was dispatched to this subagent (at the same time as driver.startAsk). */
  askStarted(key: string, instance: InstanceRef): void;
  /** The engine recorded `node-settled` for this instance (the ask's **only** terminal event; see emit in workflow-driver.ts). */
  askSettled(instance: InstanceRef): void;
  /**
   * Wrap a subagent's admission port so it passes the seat gate before the governor. If `inner` is absent, this runtime has no admission port and is not subject to either gate; do not create one here. Both gates are present together or absent together.
   */
  wrap(
    key: string,
    subagent: SeatGateSubagent,
    inner: ModelRequestAdmission | undefined,
  ): ModelRequestAdmission | undefined;
  stats(): SeatGateStats;
}

/** One FIFO entry: its key, the two callbacks that release it, and the function that removes its abort listener. */
interface ParkedSeat {
  key: string;
  grant: () => void;
  refuse: (reason: unknown) => void;
}

export function createWorkflowRunSeatGate(input: { limit: number }): WorkflowRunSeatGate {
  let limit = Math.max(1, Math.floor(input.limit));
  /** Subagents with active asks that are **not parked**. Remove an entry when it parks and add it back when released. */
  const working = new Set<string>();
  /** Subagents waiting for a seat, in arrival order. */
  const parked: ParkedSeat[] = [];
  /** `refToString(instance)` → subagent key: ask terminal events carry only the instance, so this mapping is needed to find the subagent and free its seat. */
  const instances = new Map<string, string>();

  const parkedIndexOf = (key: string): number => parked.findIndex((seat) => seat.key === key);

  /** Release FIFO entries while seats are available. Releasing means moving into `working`, not issuing a token; seats are the slots in `working`. */
  const unpark = (): void => {
    while (working.size < limit && parked.length > 0) {
      const seat = parked.shift()!;
      working.add(seat.key);
      seat.grant();
    }
  };

  /** Whether this request must pass through the seat gate: only a subagent with an active ask and no running tools is at a turn step. */
  const needsSeat = (key: string, subagent: SeatGateSubagent): boolean =>
    working.has(key) && subagent.toolsInFlight() === 0;

  const acquireSeat = async (key: string, signal: AbortSignal | undefined): Promise<void> => {
    // Within the limit: pass through without changing state. Runs whose limit was never lowered always take this branch; the fast path is unchanged.
    if (working.size <= limit) return;
    if (signal?.aborted === true) throw signal.reason;
    working.delete(key);
    return await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = parkedIndexOf(key);
        if (index >= 0) {
          parked.splice(index, 1);
          // **Leaving the queue returns to `working`:** in this gate, not being parked means working. The abort applies to **this request**, not necessarily the ask; transient driver retries, stream recovery, and other per-request signals can reach here while the ask is still active. Leaving it out of both sets would let every later turn request pass because `needsSeat` is false, while no longer counting it in `working`; the limit would silently drift upward.
          //
          // Adding it back may temporarily put `working` over the limit, which is valid and matches the instant the limit is lowered: the next turn request parks as usual and the count converges. When the aborted ask eventually settles, `askSettled` successfully deletes it from `working` and calls unpark; unpark's `working.size < limit` guard prevents freeing a seat it never occupied. At parking, `working ≥ limit`; adding it back makes it ≥ limit+1, and deleting it still leaves it ≥ limit, so nobody is released.
          working.add(key);
        }
        reject(signal?.reason);
      };
      const seat: ParkedSeat = {
        key,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        refuse: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      parked.push(seat);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return {
    setLimit: (next) => {
      limit = Math.max(1, Math.floor(next));
      unpark();
    },

    askStarted: (key, instance) => {
      instances.set(refToString(instance), key);
      // A parked subagent cannot receive a new ask (its turn is blocked in acquire and the engine still has actor.current),
      // but adding the same key to both sets would count it twice, so guard against that here.
      if (parkedIndexOf(key) >= 0) return;
      working.add(key);
    },

    askSettled: (instance) => {
      const ref = refToString(instance);
      const key = instances.get(ref);
      if (key === undefined) return;
      instances.delete(ref);
      const parkedIndex = parkedIndexOf(key);
      if (parkedIndex >= 0) {
        // A parked ask ending does **not free a seat** (it had none); otherwise this entry would be counted twice.
        // This can only happen through engine cancellation (a parked turn is blocked in acquire and cannot report a turn terminal event). That path calls driver.cancelAsk first (abort rejects the wait above), then records node-settled, so the entry is normally already gone here. If events arrive out of order, reject the wait too so an abandoned ask is not released later.
        const [seat] = parked.splice(parkedIndex, 1);
        seat?.refuse(new Error("workflow ask settled while waiting for a concurrency seat"));
        return;
      }
      if (!working.delete(key)) return;
      unpark();
    },

    wrap: (key, subagent, inner) => {
      if (inner === undefined) return undefined;
      return {
        // Fast path: this request needs a seat and all seats are occupied, so it missed. The runner emits `model_request_queued`,
        // and the driver reports `askWaiting(slot)`, exactly as it does for a shared cap; no new terminology is needed.
        tryAcquire: (request) => {
          if (needsSeat(key, subagent) && working.size > limit) return undefined;
          return inner.tryAcquire?.(request);
        },
        // Ordering affects capacity: **wait for a seat first**, then pass through the governor. Reversing the order would let a subagent that should park occupy a governor token while sleeping at this gate—a token nobody can use.
        acquire: async (request) => {
          if (needsSeat(key, subagent)) await acquireSeat(key, request.signal);
          return await inner.acquire(request);
        },
      };
    },

    stats: () => ({ limit, working: working.size, parked: parked.length }),
  };
}
