/**
 * Scenario table of the resume, amend and world-row goldens (scripts/rust-cli/workflow-import-goldens.ts).
 * Data only: the generator runs these scenarios on the real Node engine and builder.
 */

import type {
  RunStopReason,
  WorldReadOp,
} from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts";

export type Ref = { site: string; ordinal: number };

export type Step =
  | { op: "createActor"; site: string; name?: string; persona?: string }
  | { op: "ask"; tag: string; site: string; actor: string; instructions: string }
  | { op: "worldRead"; tag: string; site: string; worldOp: WorldReadOp; args: unknown[] }
  | { op: "worldDone"; tag: string; ok: boolean; value?: unknown; message?: string }
  | { op: "askMutating"; at: Ref }
  | { op: "setBoundary"; at: Ref; boundary: number }
  | { op: "submit"; at: Ref; payload: unknown }
  | {
      op: "stats";
      at: Ref;
      stats: { tokens: number; toolCalls: number; turns: number; worldToolCalls?: number };
    }
  | { op: "complete"; artifact: unknown }
  | { op: "stop"; reason: RunStopReason };

export interface Lifetime {
  caps: number;
  steps: Step[];
}

export interface Run {
  runId: string;
  /** Build the amend import cache from this predecessor run's journal (the run service's submission path). */
  importFrom?: string;
  lifetimes: Lifetime[];
}

export interface Scenario {
  name: string;
  /** Message count of each session id (the driver's count, injected into the builder). */
  transcriptCounts?: Record<string, number>;
  runs: Run[];
}

// Personas. The same name and system text match; a different system text is a persona mismatch.
export const ALPHA = "You review code.";
export const ALPHA_EDITED = "You review code, strictly.";
export const BETA = "You write tests.";

// Ordinals are 1-based per site (Node `nextOrdinal`), so the first actor of site `actor#1` is `actor#1@1`.
export const scenarios: Scenario[] = [
  {
    name: "resume-world-rows-settle-in-recorded-order",
    runs: [
      {
        runId: "run-world-order",
        lifetimes: [
          {
            caps: 2,
            steps: [
              { op: "worldRead", tag: "w0", site: "w#1", worldOp: "git.log", args: ["a"] },
              { op: "worldRead", tag: "w1", site: "w#2", worldOp: "git.log", args: ["b"] },
              { op: "worldDone", tag: "w1", ok: true, value: "second" },
              { op: "worldDone", tag: "w0", ok: true, value: "first" },
            ],
          },
          {
            caps: 2,
            steps: [
              { op: "worldRead", tag: "w0", site: "w#1", worldOp: "git.log", args: ["a"] },
              { op: "worldRead", tag: "w1", site: "w#2", worldOp: "git.log", args: ["b"] },
              { op: "complete", artifact: { done: true } },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "world-read-failure-replays-as-failed",
    runs: [
      {
        runId: "run-world-failed",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "worldRead", tag: "w0", site: "w#1", worldOp: "git.log", args: ["x"] },
              { op: "worldDone", tag: "w0", ok: false, message: "disk gone" },
              { op: "stop", reason: "interrupted" },
            ],
          },
          {
            caps: 1,
            steps: [
              { op: "worldRead", tag: "w0", site: "w#1", worldOp: "git.log", args: ["x"] },
              { op: "complete", artifact: null },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "world-row-hash-mismatch-on-resume",
    runs: [
      {
        runId: "run-world-mismatch",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "worldRead", tag: "w0", site: "w#1", worldOp: "git.log", args: ["x"] },
              { op: "worldDone", tag: "w0", ok: true, value: 1 },
              { op: "stop", reason: "user" },
            ],
          },
          {
            caps: 1,
            steps: [{ op: "worldRead", tag: "w0", site: "w#1", worldOp: "git.log", args: ["y"] }],
          },
        ],
      },
    ],
  },
  {
    name: "world-run-without-cache-emits-no-closure",
    runs: [
      {
        runId: "run-world-plain",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "worldRead", tag: "r", site: "w#1", worldOp: "run", args: ["deploy"] },
              { op: "worldDone", tag: "r", ok: true, value: "ok" },
              { op: "complete", artifact: "done" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "amend-prefix-hit-then-miss-seeds-the-divergence",
    transcriptCounts: { "sess:pred-prefix/actor#1@1": 4 },
    runs: [
      {
        runId: "pred-prefix",
        lifetimes: [
          {
            caps: 2,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              {
                op: "ask",
                tag: "p0",
                site: "ask#1",
                actor: "actor#1@1",
                instructions: "list files",
              },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "a" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 1 }, boundary: 2 },
              {
                op: "ask",
                tag: "p1",
                site: "ask#1",
                actor: "actor#1@1",
                instructions: "read main",
              },
              { op: "submit", at: { site: "ask#1", ordinal: 2 }, payload: "b" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 2 }, boundary: 4 },
              { op: "stop", reason: "user" },
            ],
          },
        ],
      },
      {
        runId: "succ-prefix",
        importFrom: "pred-prefix",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              {
                op: "ask",
                tag: "s0",
                site: "ask#1",
                actor: "actor#1@1",
                instructions: "list files",
              },
              {
                op: "ask",
                tag: "s1",
                site: "ask#1",
                actor: "actor#1@1",
                instructions: "read main",
              },
              { op: "ask", tag: "s2", site: "ask#1", actor: "actor#1@1", instructions: "changed" },
              { op: "submit", at: { site: "ask#1", ordinal: 3 }, payload: "c" },
              { op: "complete", artifact: "ok" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "amend-in-flight-ask-is-continued",
    transcriptCounts: { "sess:pred-inflight/actor#1@1": 5 },
    runs: [
      {
        runId: "pred-inflight",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "beta", persona: BETA },
              { op: "ask", tag: "p0", site: "ask#1", actor: "actor#1@1", instructions: "plan" },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "plan" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 1 }, boundary: 2 },
              { op: "ask", tag: "p1", site: "ask#1", actor: "actor#1@1", instructions: "do step" },
              { op: "stop", reason: "user" },
            ],
          },
        ],
      },
      {
        runId: "succ-inflight",
        importFrom: "pred-inflight",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "beta", persona: BETA },
              { op: "ask", tag: "s0", site: "ask#1", actor: "actor#1@1", instructions: "plan" },
              { op: "ask", tag: "s1", site: "ask#1", actor: "actor#1@1", instructions: "do step" },
              { op: "submit", at: { site: "ask#1", ordinal: 2 }, payload: "done" },
              { op: "complete", artifact: "ok" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "amend-persona-and-anonymous-actors-run-live",
    transcriptCounts: { "sess:pred-persona/actor#1@1": 2 },
    runs: [
      {
        runId: "pred-persona",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              {
                op: "ask",
                tag: "p0",
                site: "ask#1",
                actor: "actor#1@1",
                instructions: "list files",
              },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "a" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 1 }, boundary: 2 },
              { op: "stop", reason: "user" },
            ],
          },
        ],
      },
      {
        runId: "succ-persona",
        importFrom: "pred-persona",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA_EDITED },
              { op: "createActor", site: "actor#1" },
              {
                op: "ask",
                tag: "s0",
                site: "ask#1",
                actor: "actor#1@1",
                instructions: "list files",
              },
              {
                op: "ask",
                tag: "s1",
                site: "ask#1",
                actor: "actor#1@2",
                instructions: "list files",
              },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "x" },
              { op: "submit", at: { site: "ask#1", ordinal: 2 }, payload: "y" },
              { op: "complete", artifact: null },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "amend-world-reads-consume-the-queue-then-run-live",
    runs: [
      {
        runId: "pred-world",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "worldRead", tag: "p0", site: "w#1", worldOp: "git.log", args: ["x"] },
              { op: "worldDone", tag: "p0", ok: true, value: 1 },
              { op: "worldRead", tag: "p1", site: "w#1", worldOp: "git.log", args: ["x"] },
              { op: "worldDone", tag: "p1", ok: true, value: 2 },
              { op: "stop", reason: "user" },
            ],
          },
        ],
      },
      {
        runId: "succ-world",
        importFrom: "pred-world",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "worldRead", tag: "s0", site: "w#1", worldOp: "git.log", args: ["x"] },
              { op: "worldRead", tag: "s1", site: "w#1", worldOp: "git.log", args: ["x"] },
              { op: "worldRead", tag: "s2", site: "w#1", worldOp: "git.log", args: ["x"] },
              { op: "worldDone", tag: "s2", ok: true, value: 3 },
              { op: "complete", artifact: 3 },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "amend-world-run-closes-the-cache-before-the-effect",
    transcriptCounts: { "sess:pred-close/actor#1@1": 6 },
    runs: [
      {
        runId: "pred-close",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "p0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              {
                op: "stats",
                at: { site: "ask#1", ordinal: 1 },
                stats: { tokens: 1, toolCalls: 0, turns: 1, worldToolCalls: 0 },
              },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "a" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 1 }, boundary: 2 },
              { op: "ask", tag: "p1", site: "ask#1", actor: "actor#1@1", instructions: "edit" },
              {
                op: "stats",
                at: { site: "ask#1", ordinal: 2 },
                stats: { tokens: 1, toolCalls: 1, turns: 1, worldToolCalls: 1 },
              },
              { op: "submit", at: { site: "ask#1", ordinal: 2 }, payload: "b" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 2 }, boundary: 4 },
              { op: "stop", reason: "user" },
            ],
          },
        ],
      },
      {
        runId: "succ-close",
        importFrom: "pred-close",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "s0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              { op: "worldRead", tag: "r", site: "w#1", worldOp: "run", args: ["deploy"] },
              { op: "worldDone", tag: "r", ok: true, value: "deployed" },
              { op: "ask", tag: "s1", site: "ask#1", actor: "actor#1@1", instructions: "edit" },
              { op: "submit", at: { site: "ask#1", ordinal: 2 }, payload: "b" },
              { op: "complete", artifact: "ok" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "amend-mutating-observation-closes-the-cache-for-a-pure-entry",
    transcriptCounts: { "sess:pred-mut/actor#1@1": 6 },
    runs: [
      {
        runId: "pred-mut",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "createActor", site: "actor#1", name: "beta", persona: BETA },
              { op: "ask", tag: "p0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              {
                op: "stats",
                at: { site: "ask#1", ordinal: 1 },
                stats: { tokens: 1, toolCalls: 0, turns: 1, worldToolCalls: 0 },
              },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "a" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 1 }, boundary: 2 },
              { op: "ask", tag: "p1", site: "ask#1", actor: "actor#1@1", instructions: "edit" },
              {
                op: "stats",
                at: { site: "ask#1", ordinal: 2 },
                stats: { tokens: 1, toolCalls: 0, turns: 1, worldToolCalls: 0 },
              },
              { op: "submit", at: { site: "ask#1", ordinal: 2 }, payload: "b" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 2 }, boundary: 4 },
              { op: "ask", tag: "p2", site: "ask#1", actor: "actor#1@2", instructions: "b-old" },
              { op: "submit", at: { site: "ask#1", ordinal: 3 }, payload: "c" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 3 }, boundary: 6 },
              { op: "stop", reason: "user" },
            ],
          },
        ],
      },
      {
        runId: "succ-mut",
        importFrom: "pred-mut",
        lifetimes: [
          {
            caps: 2,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "createActor", site: "actor#1", name: "beta", persona: BETA },
              { op: "ask", tag: "s0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              { op: "ask", tag: "live", site: "ask#1", actor: "actor#1@2", instructions: "b-new" },
              { op: "askMutating", at: { site: "ask#1", ordinal: 2 } },
              { op: "ask", tag: "s1", site: "ask#1", actor: "actor#1@1", instructions: "edit" },
              { op: "ask", tag: "s2", site: "ask#1", actor: "actor#1@1", instructions: "other" },
              { op: "submit", at: { site: "ask#1", ordinal: 2 }, payload: "x" },
              { op: "submit", at: { site: "ask#1", ordinal: 4 }, payload: "z" },
              { op: "complete", artifact: null },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "amend-resume-replays-the-recorded-in-flight-ask",
    transcriptCounts: { "sess:pred-resume/actor#1@1": 5 },
    runs: [
      {
        runId: "pred-resume",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "p0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "a" },
              { op: "setBoundary", at: { site: "ask#1", ordinal: 1 }, boundary: 2 },
              { op: "ask", tag: "p1", site: "ask#1", actor: "actor#1@1", instructions: "edit" },
              { op: "stop", reason: "user" },
            ],
          },
        ],
      },
      {
        runId: "succ-resume",
        importFrom: "pred-resume",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "s0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              { op: "ask", tag: "s1", site: "ask#1", actor: "actor#1@1", instructions: "edit" },
              { op: "stop", reason: "interrupted" },
            ],
          },
          {
            caps: 1,
            importFrom: "pred-resume",
            steps: [
              // The script runs again: the same asks, in the same order, before the in-flight one is answered.
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "s0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              { op: "ask", tag: "s1", site: "ask#1", actor: "actor#1@1", instructions: "edit" },
              { op: "submit", at: { site: "ask#1", ordinal: 2 }, payload: "b" },
              { op: "complete", artifact: "ok" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "amend-refusals-leave-the-successor-without-a-cache",
    runs: [
      {
        runId: "pred-running",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "p0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
            ],
          },
        ],
      },
      {
        runId: "pred-no-boundary",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "p0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "a" },
              { op: "stop", reason: "user" },
            ],
          },
        ],
      },
      {
        runId: "succ-running",
        importFrom: "pred-running",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "s0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "a" },
              { op: "complete", artifact: null },
            ],
          },
        ],
      },
      {
        runId: "succ-no-boundary",
        importFrom: "pred-no-boundary",
        lifetimes: [
          {
            caps: 1,
            steps: [
              { op: "createActor", site: "actor#1", name: "alpha", persona: ALPHA },
              { op: "ask", tag: "s0", site: "ask#1", actor: "actor#1@1", instructions: "list" },
              { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "a" },
              { op: "complete", artifact: null },
            ],
          },
        ],
      },
      {
        runId: "succ-missing",
        importFrom: "pred-absent",
        lifetimes: [{ caps: 1, steps: [{ op: "complete", artifact: null }] }],
      },
    ],
  },
];
