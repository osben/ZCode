// GetWorkflowRun's summary assembly and the "how long ago" ruler (docs/dynamic-workflow/launch.md "`GetWorkflowRun`").
//
// These two are pinned separately because every sentence on the model surface is built on them: the summary is
// deterministic (the same snapshot always yields the same sentence), and age is computed against `generatedAt` (one
// ruler per output). If either drifts, the whole situation report starts saying things it does not know.

import { describe, expect, it } from "vitest";
import type { GetWorkflowRunOutput } from "@zcode/contracts";
import { buildWorkflowRunSummary } from "../src/tool/handlers/get-workflow-run-summary.js";
import {
  formatRelativeAge,
  formatWorkflowRunCount,
  formatWorkflowRunDuration,
  formatWorkflowRunInstant,
} from "../src/tool/handlers/workflow-run-introspection.js";

const NOW = Date.UTC(2026, 7, 21, 9, 5, 40);

/** A minimal but complete output: the five required fields are present, the rest are overridden per case as needed. */
const BASE: Omit<GetWorkflowRunOutput, "summary"> = {
  runId: "dwfrun-1",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  generatedAt: NOW,
  usage: { spentTokens: 0, nodesObserved: 0, nodesRunning: 0, nodesCompleted: 0, nodesFailed: 0 },
  actors: [],
  logTail: [],
  subagents: [],
  health: { consecutiveFailures: 0, cachedSteps: 0, pendingQuestionsKnown: true },
};

function summaryOf(patch: Partial<Omit<GetWorkflowRunOutput, "summary">>): string {
  return buildWorkflowRunSummary({ ...BASE, ...patch });
}

describe("workflow run duration and age", () => {
  // A four-step ladder: seconds, minutes+seconds, hours+minutes, days+hours. The 60-base units are zero-padded
  // (`1m 5s` and `1m 50s` are hard to tell apart at a glance).
  it("writes two units at most, padding the 60-base ones", () => {
    expect(formatWorkflowRunDuration(40_000)).toBe("40s");
    expect(formatWorkflowRunDuration(310_000)).toBe("5m 10s");
    expect(formatWorkflowRunDuration(65_000)).toBe("1m 05s");
    expect(formatWorkflowRunDuration(8_100_000)).toBe("2h 15m");
    expect(formatWorkflowRunDuration(266_400_000)).toBe("3d 2h");
  });

  // A clock rollback or a bad value must not let one timestamp turn the whole tool result into NaN.
  it("folds a negative or non-finite span to zero", () => {
    expect(formatWorkflowRunDuration(-5_000)).toBe("0s");
    expect(formatWorkflowRunDuration(Number.NaN)).toBe("0s");
  });

  // Absent reads as "unknown": old journals have no time column, so such a row has no age rather than "0s ago".
  it("returns nothing when the instant is unknown", () => {
    expect(formatRelativeAge(NOW, undefined)).toBeUndefined();
    expect(formatRelativeAge(NOW, Number.NaN)).toBeUndefined();
    expect(formatRelativeAge(NOW, NOW - 40_000)).toBe("40s ago");
  });

  it("writes an instant as ISO plus its age", () => {
    expect(formatWorkflowRunInstant(NOW, NOW - 40_000)).toBe("2026-08-21T09:05:00.000Z (40s ago)");
  });

  // Thousands separators are inserted by hand: `toLocaleString` depends on the host's ICU, while the model surface
  // must be pin-able verbatim.
  it("groups thousands without leaning on the host locale", () => {
    expect(formatWorkflowRunCount(6_210)).toBe("6,210");
    expect(formatWorkflowRunCount(41_200)).toBe("41,200");
    expect(formatWorkflowRunCount(999)).toBe("999");
    expect(formatWorkflowRunCount(1_000_000)).toBe("1,000,000");
  });
});

describe("workflow run summary — the live shapes", () => {
  it("says how long it has been running and how far the steps got", () => {
    expect(
      summaryOf({
        // Counts align with the roster: each live-phase subagent holds one still-running ask line, and observed is the
        // sum of the three states.
        usage: {
          spentTokens: 10,
          nodesObserved: 7,
          nodesRunning: 2,
          nodesCompleted: 5,
          nodesFailed: 0,
        },
        subagents: [
          {
            siteId: "a",
            ordinal: 1,
            state: "executing",
            stepsSettled: 0,
            stepsFailed: 0,
            tokens: 0,
          },
          { siteId: "b", ordinal: 1, state: "waiting", stepsSettled: 0, stepsFailed: 0, tokens: 0 },
        ],
      }),
    ).toBe(
      "Running for 5m 40s. 5 of 7 dispatched steps settled, 2 running (1 executing, 1 waiting).",
    );
  });

  // When the roster is unreadable (counts only, no actor lines), better to give no parentheses than to invent a
  // breakdown from counts.
  it("omits the breakdown instead of inventing one when the roster is empty", () => {
    const summary = summaryOf({
      usage: {
        spentTokens: 10,
        nodesObserved: 7,
        nodesRunning: 2,
        nodesCompleted: 5,
        nodesFailed: 0,
      },
    });
    expect(summary).toContain("2 running.");
    expect(summary).not.toContain("(");
  });

  // What the in-flight steps are each doing is counted from the roster's phases — "2 running" by itself does not
  // answer "is it stuck".
  it("breaks the running steps down by what the roster says they are doing", () => {
    const summary = summaryOf({
      usage: {
        spentTokens: 10,
        nodesObserved: 7,
        nodesRunning: 3,
        nodesCompleted: 4,
        nodesFailed: 0,
      },
      subagents: [
        { siteId: "a", ordinal: 1, state: "executing", stepsSettled: 0, stepsFailed: 0, tokens: 0 },
        { siteId: "b", ordinal: 1, state: "waiting", stepsSettled: 0, stepsFailed: 0, tokens: 0 },
        { siteId: "c", ordinal: 1, state: "parked", stepsSettled: 0, stepsFailed: 0, tokens: 0 },
      ],
    });
    expect(summary).toContain("3 running (1 executing, 1 waiting, 1 parked)");
  });

  it("points at the current phase while one is current", () => {
    expect(
      summaryOf({
        phases: [
          { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0 },
          { name: "judge", state: "current", rounds: 1, nodesSettled: 0, nodesRunning: 1 },
          { name: "verify", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
        ],
      }),
    ).toContain("in phase 2 of 3 (judge)");
  });

  // If the script has no phases, say nothing about phases: "across 0 phases" answers a question nobody asked.
  it("says nothing about phases when the run has none", () => {
    expect(summaryOf({})).not.toContain("phase");
  });

  it("counts the questions that are waiting, and stays silent when none are", () => {
    expect(
      summaryOf({
        pendingQuestions: [
          { qid: "q1", actor: "a@1", question: "?", askedAt: NOW },
          { qid: "q2", actor: "b@1", question: "?", askedAt: NOW },
        ],
      }),
    ).toContain("2 questions awaiting your answer.");
    expect(summaryOf({})).not.toContain("awaiting your answer");
  });

  // "Nobody is waiting" and "cannot be determined" are two different facts, and silence makes the latter read as the
  // former.
  it("says outright that pending questions are unknown when they are", () => {
    expect(summaryOf({ health: { ...BASE.health, pendingQuestionsKnown: false } })).toContain(
      "Pending questions are unknown from this session.",
    );
  });

  it("reports the last progress and names a stall", () => {
    expect(summaryOf({ health: { ...BASE.health, lastProgressAt: NOW - 40_000 } })).toContain(
      "Last progress 40s ago.",
    );
    expect(
      summaryOf({
        health: { ...BASE.health, lastProgressAt: NOW - 40_000, stalledSince: NOW - 30_000 },
      }),
    ).toContain("Stalled, last progress 40s ago.");
  });

  it("marks a run this session does not own", () => {
    expect(summaryOf({ ownedByThisSession: false })).toContain("Owned by another session.");
    expect(summaryOf({})).not.toContain("Owned by another session.");
  });
});

describe("workflow run summary — the terminal shapes", () => {
  it("totals the settled steps and tokens for a completed run", () => {
    expect(
      summaryOf({
        status: "completed",
        usage: {
          spentTokens: 41_200,
          nodesObserved: 12,
          nodesRunning: 0,
          nodesCompleted: 12,
          nodesFailed: 0,
        },
      }),
    ).toBe("Completed in 5m 00s. 12 steps settled, 41,200 tokens.");
  });

  it("names the failure code so the model can tell a dead process from a bad script", () => {
    expect(
      summaryOf({ status: "errored", error: { code: "DriverError", message: "the script threw" } }),
    ).toContain("Failure: DriverError.");
    // A plain user cancellation has no failure to report.
    expect(summaryOf({ status: "stopped", stopReason: "user" })).not.toContain("Failure:");
  });

  // Lines still marked running in a terminal run are leftovers from the process dying under them; resume re-dispatches
  // them.
  it("explains the leftovers of an exited process instead of counting them as running", () => {
    expect(
      summaryOf({
        status: "stopped",
        stopReason: "interrupted",
        usage: {
          spentTokens: 10,
          nodesObserved: 7,
          nodesRunning: 2,
          nodesCompleted: 5,
          nodesFailed: 0,
        },
        health: { ...BASE.health, leftoverRunning: 2 },
      }),
    ).toContain(
      "2 were still running when the owning process exited and will be re-dispatched on resume",
    );
  });

  it("counts the phases instead of pointing at one once they are all behind it", () => {
    expect(
      summaryOf({
        status: "completed",
        phases: [
          { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0 },
          { name: "judge", state: "done", rounds: 1, nodesSettled: 6, nodesRunning: 0 },
        ],
      }),
    ).toContain("across 2 phases");
  });

  it("points the reader at the deliverable of a completed run", () => {
    expect(
      summaryOf({
        status: "completed",
        artifacts: [
          { id: "notes", kind: "markdown", version: 1, itemCount: 0 },
          {
            id: "report",
            kind: "markdown",
            title: "Nightly triage report",
            version: 1,
            itemCount: 0,
            primary: true,
          },
        ],
      }),
    ).toContain("Deliverable: Nightly triage report (markdown, primary).");
    // A run without a primary artifact does not promote one to fill the slot.
    expect(
      summaryOf({
        status: "completed",
        artifacts: [{ id: "notes", kind: "markdown", version: 1, itemCount: 0 }],
      }),
    ).not.toContain("Deliverable");
  });
});

describe("workflow run summary — the budget", () => {
  // The cap drops whole trailing sentences rather than cutting one mid-way; the first two sentences (situation + step
  // count) survive under any budget.
  it("drops whole trailing sentences to stay inside 400 characters", () => {
    const longTitle = "R".repeat(360);
    const summary = summaryOf({
      status: "completed",
      ownedByThisSession: false,
      usage: {
        spentTokens: 41_200,
        nodesObserved: 12,
        nodesRunning: 0,
        nodesCompleted: 12,
        nodesFailed: 0,
      },
      artifacts: [
        {
          id: "report",
          kind: "markdown",
          title: longTitle,
          version: 1,
          itemCount: 0,
          primary: true,
        },
      ],
    });
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary).toContain("Completed in 5m 00s.");
    expect(summary).toContain("12 steps settled");
    expect(summary).not.toContain(longTitle);
  });
});
