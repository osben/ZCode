// ============================================================
// Parking registry for Workflow escalation questions (the sole connection between the driver and run service).
// ============================================================
// An actor's `escalate` parks in the driver (which owns ask-turn context), while the `resolveQuestion` answer entry point is on the run service (the port owner).
// They need a table keyed by qid to communicate. This file is exactly that table: no I/O, persistence, or engine knowledge.
//
// Why not pass the driver instance to the service: `makeDriver(sink)` constructs it **inside** `runWorkflowScript`, so the service never sees it.
// Passing in a table avoids adding a capture hook to launch just to obtain the instance, and avoids another timing concern (the table exists before launch, so registration and lookup naturally share a lifecycle).
//
// **In-memory only, with the same lifetime as the parked deferred.** Deliberately not persisted: after process death the deferred is gone, so a persisted
// pending table would lie by asking the main agent to answer a question nobody is waiting for. Resume recovers by rerunning the ask live; the actor asks again and gets a new qid, while the stale id receives a structured rejection.
//
// Scope is **one table per run service instance** (approximately one per app session), not a module-level singleton: sharing a table across sessions would create a cross-session answer channel, violating the repository rule that enumeration surfaces show only the current session. One table spans **all active runs** owned by this service, which is why qids must be globally unique.

import type {
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPendingQuestion,
} from "@zcode/contracts";

/**
 * Number of retired qids to remember. **Bounded:** a long-running session can ask and answer any number of questions, so unbounded history would silently consume memory.
 * After eviction, `resolveQuestion` classifies the id as `unknown_question`—an honest degradation ("I don't know this id"), not a wrong answer.
 */
const RETIRED_HISTORY_LIMIT = 256;

/** Facts required to register a parked question (provided by the driver; the driver has already minted the qid). */
export interface ParkedQuestionInput {
  qid: string;
  runId: string;
  /** The actor asking the question, in `refToString` form (for example, `actor#1@1`). */
  actor: string;
  /** The actor's effective name (`"poet"` from `agent("poet")`); absent for anonymous actors, with no fallback label synthesized. */
  actorName?: string;
  question: string;
  context?: string;
  askedAt: number;
}

/** Why a qid was retired; determines which structured rejection a later resolve receives. */
type RetiredReason = "resolved" | "withdrawn";

export interface WorkflowEscalationRegistry {
  /**
   * Register a parked question. The driver provides `settle`, which resolves the deferred when an answer arrives.
   *
   * The caller must first use {@link isTaken} to ensure the qid is unused (the driver's minting loop does this).
   * Duplicate registration silently replaces the earlier parked entry, which is exactly how answers can be mismatched.
   */
  park(entry: ParkedQuestionInput, settle: (answer: string) => void): void;
  /** Whether the qid is in use (parked or retired). The driver uses this to guarantee global uniqueness when minting qids. */
  isTaken(qid: string): boolean;
  /**
   * Remove a parked entry **without answering**: the driver calls this when the ask is canceled or the turn fails (the driver rejects the deferred itself).
   * Later resolves for this qid receive `run_not_in_flight`.
   */
  withdraw(qid: string): void;
  /** Settle a parked entry. Each of the three structured rejections states the current situation and next step. */
  resolve(qid: string, answer: string): DynamicWorkflowResolveQuestionResult;
  /** Questions currently parked on a run, in ask order. Source for the snapshot's `pendingQuestions` projection. */
  pendingFor(runId: string): DynamicWorkflowRunPendingQuestion[];
}

interface ParkedQuestion extends ParkedQuestionInput {
  settle: (answer: string) => void;
}

export function createWorkflowEscalationRegistry(): WorkflowEscalationRegistry {
  // Map insertion order is ask order (`pendingFor` relies on it directly, so no separate sequence number is stored).
  const parked = new Map<string, ParkedQuestion>();
  const retired = new Map<string, RetiredReason>();

  const retire = (qid: string, reason: RetiredReason): void => {
    parked.delete(qid);
    retired.set(qid, reason);
    while (retired.size > RETIRED_HISTORY_LIMIT) {
      // Map iteration follows insertion order, so the first key is the oldest entry.
      const oldest = retired.keys().next();
      if (oldest.done === true) break;
      retired.delete(oldest.value);
    }
  };

  return {
    park(entry, settle) {
      parked.set(entry.qid, { ...entry, settle });
    },

    isTaken(qid) {
      return parked.has(qid) || retired.has(qid);
    },

    withdraw(qid) {
      // This applies only to parked entries: a resolved qid must not be downgraded to `run_not_in_flight`
      // (that would rewrite "answer delivered" as "nobody is waiting", which are different facts for the main agent).
      if (!parked.has(qid)) return;
      retire(qid, "withdrawn");
    },

    resolve(qid, answer) {
      const entry = parked.get(qid);
      if (entry === undefined) {
        const reason = retired.get(qid);
        if (reason === "resolved") {
          return {
            ok: false,
            reason: "already_resolved",
            message:
              `Question ${qid} was already answered and the subagent has moved on with that ` +
              `answer. No need to answer again; if you have more to add, wait for its next ` +
              `escalation.`,
          };
        }
        if (reason === "withdrawn") {
          return {
            ok: false,
            reason: "run_not_in_flight",
            message:
              `The ask that raised question ${qid} is no longer in flight (the run was ` +
              `cancelled, or that ask already failed), so nobody is waiting for this answer. ` +
              `Use GetWorkflowRun to see the run's current state before deciding what to do next.`,
          };
        }
        return {
          ok: false,
          reason: "unknown_question",
          message:
            `Unknown question id ${qid}. It may be misspelled, or it may come from a process ` +
            `that is gone: parked questions are not persisted, so they vanish on restart (a ` +
            `resume makes the subagent ask again under a new id). Use GetWorkflowRun to read ` +
            `the run's pendingQuestions for the ids that are actually awaiting an answer.`,
        };
      }
      retire(qid, "resolved");
      // Call settle after retirement: it synchronously resolves the actor-side deferred, and any reentry on that chain
      // (for example, another escalate in the same turn) must see a table that no longer contains this qid.
      entry.settle(answer);
      return { ok: true, qid };
    },

    pendingFor(runId) {
      const out: DynamicWorkflowRunPendingQuestion[] = [];
      for (const entry of parked.values()) {
        if (entry.runId !== runId) continue;
        out.push({
          qid: entry.qid,
          actor: entry.actor,
          ...(entry.actorName === undefined ? {} : { actorName: entry.actorName }),
          question: entry.question,
          ...(entry.context === undefined ? {} : { context: entry.context }),
          askedAt: entry.askedAt,
        });
      }
      return out;
    },
  };
}
