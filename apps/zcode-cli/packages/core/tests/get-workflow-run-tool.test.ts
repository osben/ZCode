import { describe, expect, it } from "vitest";
import {
  GET_WORKFLOW_RUN_TOOL_NAME,
  GetWorkflowRunOutputSchema,
  type DynamicWorkflowRunDetail,
  type DynamicWorkflowRunPort,
  type GetWorkflowRunOutput,
} from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import { getWorkflowRunToolEntry } from "../src/tool/handlers/get-workflow-run.js";
import { buildWorkflowRunSummary } from "../src/tool/handlers/get-workflow-run-summary.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { expectV2CommonContract } from "./tool-contract-assertions.js";
import type { ToolExecutionContext, ToolHandlerFailure } from "../src/tool/types.js";

/** Snapshot instant: 40s after the run's updatedAt, 5m 40s after createdAt. All ages are computed against it. */
const NOW = Date.UTC(2026, 7, 21, 9, 5, 40);

const RUNNING_DETAIL: DynamicWorkflowRunDetail = {
  runId: "dwfrun-running",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  usage: {
    spentTokens: 1_204,
    nodesObserved: 3,
    nodesRunning: 1,
    nodesCompleted: 2,
    nodesFailed: 0,
  },
  actors: [
    { siteId: "agent#1", ordinal: 1, name: "judge" },
    { siteId: "agent#2", ordinal: 1 },
  ],
  logTail: [
    { sequence: 11, message: "collected the failing specs", at: Date.UTC(2026, 7, 21, 9, 0, 50) },
    { sequence: 14, message: "asked the judge", at: Date.UTC(2026, 7, 21, 9, 4, 40) },
  ],
  subagents: [
    {
      siteId: "agent#1",
      ordinal: 1,
      name: "judge",
      state: "executing",
      phaseName: "judge",
      currentAsk: {
        siteId: "ask#4",
        ordinal: 1,
        actorSeq: 2,
        instructionsHead: "Judge specs 1-7 for flakiness; report real failures with evidence",
        startedAt: Date.UTC(2026, 7, 21, 9, 4, 28),
        turn: 4,
        toolCalls: 7,
        lastTool: {
          name: "Read",
          target: "packages/net/retry.spec.ts",
          at: Date.UTC(2026, 7, 21, 9, 5, 32),
        },
      },
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 5_100,
      lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 32),
    },
    {
      siteId: "agent#2",
      ordinal: 1,
      // On a live run the port never sends `done` (that is a terminal word): a resting subagent is `idle`.
      state: "idle",
      phaseName: "collect",
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 2_130,
    },
  ],
  health: {
    lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    consecutiveFailures: 0,
    cachedSteps: 0,
    pendingQuestionsKnown: true,
  },
};

/**
 * The model face's input is the **tool output**, not the port detail: `summary` and `generatedAt`
 * are cast by the handler, and the formatter is a pure function of them. Pinning a fixed
 * `generatedAt` means the whole text (including every "how long ago") can be asserted verbatim.
 */
const RUNNING_OUTPUT: GetWorkflowRunOutput = {
  ...(RUNNING_DETAIL as unknown as Omit<GetWorkflowRunOutput, "summary" | "generatedAt">),
  generatedAt: NOW,
  summary:
    "Running for 5m 40s. 2 of 3 dispatched steps settled, 1 running (1 executing). Last progress 40s ago.",
};

/** Stub port implementing only `getRunDetail`; touching any other member means the wiring went wrong. */
function stubDetailPort(
  details: Readonly<Record<string, DynamicWorkflowRunDetail>>,
): DynamicWorkflowRunPort {
  const unreachable = (name: string) => () => {
    throw new Error(`stubDetailPort.${name} 不应被 GetWorkflowRun handler 触及`);
  };
  return {
    submit: unreachable("submit"),
    getTask: unreachable("getTask"),
    waitForTask: unreachable("waitForTask"),
    cancel: unreachable("cancel"),
    listEvents: unreachable("listEvents"),
    listRuns: unreachable("listRuns"),
    async getRunDetail(runId: string) {
      return details[runId];
    },
  } as unknown as DynamicWorkflowRunPort;
}

function contextWith(port?: DynamicWorkflowRunPort): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "sess_get_run" as never,
    toolCallId: "toolu_get_run",
    traceId: "trace_get_run" as never,
    workingDirectory: "/workspace/project",
    workspaceRoot: "/workspace/project",
    ...(port === undefined ? {} : { dynamicWorkflowRunPort: port }),
  } as ToolExecutionContext;
}

async function call(runId: string, port?: DynamicWorkflowRunPort): Promise<Record<string, unknown>> {
  return (await getWorkflowRunToolEntry.handler({ run_id: runId }, contextWith(port))) as Record<
    string,
    unknown
  >;
}

function asFailure(output: unknown): ToolHandlerFailure {
  const failure = output as ToolHandlerFailure;
  expect(failure.result).toBe(false);
  return failure;
}

/**
 * Output = the port detail carried over field by field, plus two things the handler casts itself:
 * the summary sentence and the instant of this snapshot. The clock is a real `Date.now()`, so only
 * the shape is pinned here, not the values — the values' determinism is pinned by the formatter
 * and summary unit tests.
 */
function expectMirrorsDetail(output: Record<string, unknown>, detail: DynamicWorkflowRunDetail): void {
  expect(GetWorkflowRunOutputSchema.parse(output)).toEqual({
    ...detail,
    summary: expect.any(String),
    generatedAt: expect.any(Number),
  });
}

describe("GetWorkflowRun handler — capability and identity", () => {
  it("returns the same business failure for an absent port and an absent method", async () => {
    const portWithoutMethod = {
      async submit() {
        throw new Error("unreachable");
      },
    } as unknown as DynamicWorkflowRunPort;

    const withoutPort = asFailure(await call("dwfrun-x"));
    const withoutMethod = asFailure(await call("dwfrun-x", portWithoutMethod));

    expect(withoutPort.message).toContain("workflow_introspection_unavailable");
    expect(withoutMethod).toEqual(withoutPort);
  });

  // An unknown runId is a **structured failure**, not an empty object: the latter would make the
  // model think the run exists but has no content.
  it("fails with run_not_found for an unknown run id", async () => {
    const failure = asFailure(await call("dwfrun-nope", stubDetailPort({})));

    expect(failure.message).toContain("run_not_found");
    expect(failure.message).toContain("dwfrun-nope");
    // A missing capability and an unknown run must be distinguishable.
    expect(failure.errorCode).not.toBe(asFailure(await call("dwfrun-nope")).errorCode);
  });
});

describe("GetWorkflowRun handler — running snapshot", () => {
  it("gives progress, actors and the log tail, with neither result nor error", async () => {
    const output = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }),
    );

    expectMirrorsDetail(output, RUNNING_DETAIL);
    expect("result" in output).toBe(false);
    expect("error" in output).toBe(false);
  });

  // The run's own concurrency bound (docs/dynamic-workflow/concurrency.md "Two bounds on a run").
  // The port only sends this field when it differs from the default concurrency, so "absent means
  // default" holds by construction on the read side and is not re-checked here.
  it("carries the run's own concurrency bound when it has one", async () => {
    const detail: DynamicWorkflowRunDetail = { ...RUNNING_DETAIL, maxConcurrency: 3 };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.maxConcurrency).toBe(3);
    expectMirrorsDetail(output, detail);
  });

  it("omits the bound entirely for a run at the machine default", async () => {
    const output = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }),
    );

    expect("maxConcurrency" in output).toBe(false);
  });

  // The run's own subagent model (docs/dynamic-workflow/launch.md). Same rule as the concurrency
  // bound, "absent means default": a run inheriting the session model has nothing to say.
  it("carries the run's own subagent model when it chose one", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      subagentModel: "bigmodel/GLM-4.6$high",
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.subagentModel).toBe("bigmodel/GLM-4.6$high");
    expectMirrorsDetail(output, detail);
  });

  it("omits the model entirely for a run on the session model", async () => {
    const output = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }),
    );

    expect("subagentModel" in output).toBe(false);
  });

  // This run's script file (docs/dynamic-workflow/launch.md "Script files"). The port gives the
  // absolute path (part of the run identity); the model face rewrites it workspace-relative — the
  // model is about to Edit that file, and this is the kind of path it uses to read and write
  // files everywhere else.
  it("rewrites the run's script file as a workspace-relative path", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      scriptPath: "/workspace/project/.zcode/workflow-drafts/audit.dwf.ts",
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.scriptPath).toBe(".zcode/workflow-drafts/audit.dwf.ts");
  });

  it("keeps a script file outside the working directory absolute", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      scriptPath: "/elsewhere/shared/audit.dwf.ts",
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.scriptPath).toBe("/elsewhere/shared/audit.dwf.ts");
    expectMirrorsDetail(output, detail);
  });

  it("omits the script file entirely for a run that recorded none", async () => {
    const output = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }),
    );

    expect("scriptPath" in output).toBe(false);
  });

  it("carries the possiblyInterrupted annotation", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      ownedByThisSession: false,
      possiblyInterrupted: true,
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expectMirrorsDetail(output, detail);
  });
});

describe("GetWorkflowRun handler — the situation cross-section", () => {
  it("carries the phase table, the roster and health across the boundary unchanged", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      phases: [
        { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: 1, exitedAt: 2 },
        { name: "judge", state: "current", rounds: 1, nodesSettled: 1, nodesRunning: 1, enteredAt: 2 },
      ],
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expectMirrorsDetail(output, detail);
    expect(output.subagents).toHaveLength(2);
  });

  // A run with no actors at all is an empty array, not an absence: "how many subagents" always has
  // an answer, and 0 is that answer.
  it("keeps an empty roster as an empty array and an absent phase table absent", async () => {
    const detail: DynamicWorkflowRunDetail = { ...RUNNING_DETAIL, subagents: [] };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.subagents).toEqual([]);
    expect("phases" in output).toBe(false);
  });

  it("clamps the roster at 64 rows and says it clamped", async () => {
    const one = RUNNING_DETAIL.subagents[1]!;
    const many = Array.from({ length: 70 }, (_, index) => ({ ...one, ordinal: index + 1 }));
    const output = await call(
      "dwfrun-many",
      stubDetailPort({ "dwfrun-many": { ...RUNNING_DETAIL, subagents: many } }),
    );

    expect(output.subagents).toHaveLength(64);
    expect(output.subagentsTruncated).toBe(true);
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);

    const exact = await call(
      "dwfrun-exact",
      stubDetailPort({ "dwfrun-exact": { ...RUNNING_DETAIL, subagents: many.slice(0, 64) } }),
    );
    expect("subagentsTruncated" in exact).toBe(false);
  });

  // A terminal run having no leftover rows is the norm; `leftover_running=0` reads like an event
  // that happened.
  it("drops a zero leftover count instead of reporting it", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      status: "stopped",
      stopReason: "interrupted",
      health: { ...RUNNING_DETAIL.health, leftoverRunning: 0 },
    };
    const output = await call("dwfrun-left", stubDetailPort({ "dwfrun-left": detail }));

    expect((output.health as Record<string, unknown>).leftoverRunning).toBeUndefined();
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);
  });

  // Missing turn / toolCalls reads as "unknown": an old journal has no node-progress, and the
  // handler must not backfill 0.
  it("never fabricates progress readings a journal does not have", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      subagents: [
        {
          siteId: "agent#1",
          ordinal: 1,
          state: "executing",
          currentAsk: { siteId: "ask#1", ordinal: 0 },
          stepsSettled: 0,
          stepsFailed: 0,
          tokens: 0,
        },
      ],
    };
    const output = await call("dwfrun-old", stubDetailPort({ "dwfrun-old": detail }));
    const ask = (output.subagents as Record<string, unknown>[])[0]!.currentAsk as Record<string, unknown>;

    for (const key of ["turn", "toolCalls", "lastTool", "startedAt", "actorSeq", "instructionsHead"]) {
      expect(key in ask).toBe(false);
    }
  });

  // One call, one ruler: every age in the summary and the model face is computed against this
  // single reading.
  it("stamps the snapshot with one clock and assembles the summary from it", async () => {
    const before = Date.now();
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }));

    expect(output.generatedAt as number).toBeGreaterThanOrEqual(before);
    expect(output.generatedAt as number).toBeLessThanOrEqual(Date.now());
    expect(String(output.summary)).toContain("dispatched steps settled");
    expect(String(output.summary).length).toBeLessThanOrEqual(400);
  });
});

describe("GetWorkflowRun handler — terminal artifact", () => {
  function completedWith(result: unknown): DynamicWorkflowRunDetail {
    return { ...RUNNING_DETAIL, status: "completed", result };
  }

  it("passes a string artifact through verbatim", async () => {
    const output = await call(
      "dwfrun-done",
      stubDetailPort({ "dwfrun-done": completedWith("all specs green") }),
    );

    expect(output.result).toBe("all specs green");
  });

  // Serialization goes through core's single implementation (serializeWorkflowArtifact), the same
  // text as the completion notification and TaskOutput.
  it("pretty-prints a structured artifact exactly like the completion notification", async () => {
    const output = await call(
      "dwfrun-done",
      stubDetailPort({ "dwfrun-done": completedWith({ verdict: "ship", failures: [] }) }),
    );

    expect(output.result).toBe('{\n  "verdict": "ship",\n  "failures": []\n}');
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);
  });

  it("keeps null as a legal artifact and omits the field for undefined", async () => {
    const nullResult = await call(
      "dwfrun-null",
      stubDetailPort({ "dwfrun-null": completedWith(null) }),
    );
    const voidResult = await call(
      "dwfrun-void",
      stubDetailPort({ "dwfrun-void": { ...RUNNING_DETAIL, status: "completed" } }),
    );

    expect(nullResult.result).toBe("null");
    expect("result" in voidResult).toBe(false);
  });
});

// ⚠ Terminology: the previous describe's "artifact" is the script's **top-level return value**
// (goes into `result`); this one is output the script **published for the user** via `artifact.*`
// (goes into `artifacts`). The two sit side by side in the same output. See
// docs/dynamic-workflow/authoring.md "Artifacts: what the user keeps".
describe("GetWorkflowRun handler — published artifacts", () => {
  const AUDIT = {
    id: "audit",
    kind: "file" as const,
    title: "审计报告",
    contentType: "application/pdf",
    sourcePath: "out/audit.pdf",
    version: 2,
    itemCount: 0,
    versions: [
      { version: 1, publishedAt: 1, bytes: 10, uri: "zcode-artifact://one" },
      { version: 2, publishedAt: 2, bytes: 4_096, uri: "zcode-artifact://two" },
    ],
  };
  const PERF = {
    id: "perf",
    kind: "chart" as const,
    version: 1,
    itemCount: 12,
    spec: { x: { field: "round" }, y: { field: "ms" } },
    versions: [{ version: 1, publishedAt: 3 }],
  };

  it("hoists the latest version's bytes and drops uri / spec / versions from the model face", async () => {
    const output = await call(
      "dwfrun-art",
      stubDetailPort({
        "dwfrun-art": { ...RUNNING_DETAIL, status: "completed", artifacts: [AUDIT, PERF] },
      }),
    );

    expect(output.artifacts).toEqual([
      {
        id: "audit",
        kind: "file",
        title: "审计报告",
        version: 2,
        contentType: "application/pdf",
        // The latest version's byte count, not the first version's.
        bytes: 4_096,
        sourcePath: "out/audit.pdf",
        itemCount: 0,
      },
      { id: "perf", kind: "chart", version: 1, itemCount: 12 },
    ]);
    // `uri` is deliberately absent: the model cannot read the tool-artifact store. `spec` /
    // `versions` are the UI's business too.
    expect(JSON.stringify(output.artifacts)).not.toContain("zcode-artifact://");
    expect(JSON.stringify(output.artifacts)).not.toContain("round");
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);
  });

  // Attached in any status: a still-running run may already have delivered its first chart.
  it("carries artifacts on a running run too, and omits the field when there are none", async () => {
    const running = await call(
      "dwfrun-art-running",
      stubDetailPort({ "dwfrun-art-running": { ...RUNNING_DETAIL, artifacts: [PERF] } }),
    );
    expect(running.status).toBe("running");
    expect(running.artifacts).toHaveLength(1);

    // The component / port does not send this key ⇒ the whole field is absent (an empty array
    // would read as "ran but produced nothing").
    const none = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }));
    expect("artifacts" in none).toBe(false);
    const empty = await call(
      "dwfrun-art-empty",
      stubDetailPort({ "dwfrun-art-empty": { ...RUNNING_DETAIL, artifacts: [] } }),
    );
    expect("artifacts" in empty).toBe(false);
  });

  it("bounds the section at 32 (= ARTIFACT_CAPS.maxArtifactsPerRun)", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `a${index + 1}`,
      kind: "markdown" as const,
      version: 1,
      itemCount: 0,
      versions: [{ version: 1, publishedAt: 1, bytes: 8 }],
    }));
    const output = await call(
      "dwfrun-art-many",
      stubDetailPort({ "dwfrun-art-many": { ...RUNNING_OUTPUT, artifacts: many } }),
    );
    expect(output.artifacts).toHaveLength(32);
  });

  it("renders one line per artifact after <result> / <error>, in the notification's format", () => {
    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "completed",
        result: "shipped",
        artifacts: [
          {
            id: "audit",
            kind: "file",
            title: "审计报告",
            version: 2,
            contentType: "application/pdf",
            bytes: 4_096,
            sourcePath: "out/audit.pdf",
            itemCount: 0,
          },
          { id: "perf", kind: "chart", version: 1, itemCount: 12 },
        ],
      }),
    );

    expect(content).toContain('<artifacts count="2">');
    // Shares one formatter verbatim with the completion notification: both readers are the same
    // model.
    expect(content).toContain("- audit (file, v2, application/pdf, 4096 bytes): 审计报告");
    expect(content).toContain("- perf (chart, v1, 12 items)");
    // Placed after result: read the run's outcome first; the deliverable list is an index.
    expect(content.indexOf("<artifacts")).toBeGreaterThan(content.indexOf("<result>"));
  });

  it("keeps the primary flag on the model face and marks its line right after the kind", async () => {
    const REPORT = {
      id: "report",
      kind: "markdown" as const,
      title: "审计报告",
      description: "结论与修复建议",
      version: 1,
      itemCount: 0,
      primary: true as const,
      versions: [{ version: 1, publishedAt: 4, bytes: 2_048, primary: true as const }],
    };
    const output = await call(
      "dwfrun-art-primary",
      stubDetailPort({
        "dwfrun-art-primary": {
          ...RUNNING_OUTPUT,
          status: "completed",
          // The port already orders the deliverable first; the handler keeps that order.
          artifacts: [REPORT, PERF],
        },
      }),
    );
    expect(output.artifacts).toEqual([
      { id: "report", kind: "markdown", title: "审计报告", version: 1, bytes: 2_048, itemCount: 0, primary: true },
      { id: "perf", kind: "chart", version: 1, itemCount: 12 },
    ]);
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);

    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "completed",
        artifacts: output.artifacts!,
      }),
    );
    expect(content).toContain("- report (markdown, primary, v1, 2048 bytes): 审计报告");
    expect(content).toContain("- perf (chart, v1, 12 items)");
  });

  it("omits the block when there are no artifacts", () => {
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "<artifacts",
    );
  });

  // The sentence from the description copy: the artifacts are already in front of the user, so
  // refer to them by title instead of restating their contents.
  it("tells the model in the tool description not to paste artifact contents", () => {
    expect(getWorkflowRunToolEntry.metadata.description).toContain(
      "ALREADY shown to them as cards",
    );
    expect(getWorkflowRunToolEntry.metadata.description).toContain(
      "The one marked `primary` is the deliverable",
    );
  });
});

describe("GetWorkflowRun handler — terminal failure", () => {
  it("passes the Interrupted code and the stop reason through so the model can tell a dead process from a bad script", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      status: "stopped",
      stopReason: "interrupted",
      error: {
        code: "Interrupted",
        message: "dynamic workflow run dwfrun-dead was interrupted",
      },
    };
    const output = await call("dwfrun-dead", stubDetailPort({ "dwfrun-dead": detail }));

    expect(output.error).toEqual(detail.error);
    expect(output.stopReason).toBe("interrupted");
    expectMirrorsDetail(output, detail);
  });

  it("carries an errored run's failure", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      status: "errored",
      error: { code: "DriverError", message: "the script threw" },
    };
    const output = await call("dwfrun-errored", stubDetailPort({ "dwfrun-errored": detail }));

    expect(output.status).toBe("errored");
    expect("stopReason" in output).toBe(false);
    expect(output.error).toEqual(detail.error);
  });

  // Provider stop (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md): the
  // structured details cross the boundary as-is, and the model face picks its wording from them.
  it("carries a provider stop's structured details", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      status: "stopped",
      stopReason: "provider",
      error: {
        code: "ProviderStop",
        message: "Subagent turn failed: [1006] token expired",
        providerStop: {
          kind: "auth",
          reason: "auth_failed",
          providerId: "account:bigmodel-coding-plan",
          providerLabel: "BigModel",
          modelId: "GLM-5.3",
          providerCode: "1006",
          subagent: "verify@2",
          phase: "Verify",
          rawMessage: "[1006] token expired",
        },
      },
    };
    const output = await call("dwfrun-stop", stubDetailPort({ "dwfrun-stop": detail }));

    expect(output.stopReason).toBe("provider");
    expect(output.error).toEqual(detail.error);
    expectMirrorsDetail(output, detail);
  });
});

describe("GetWorkflowRun model content", () => {
  it("renders the common cross-section, usage, actors and log tail as blocks", () => {
    const content = String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT));

    expect(content).toContain("<run_id>dwfrun-running</run_id>");
    expect(content).toContain('<label source="name">nightly triage</label>');
    expect(content).toContain("<status>running</status>");
    expect(content).toContain("<owned_by_this_session>true</owned_by_this_session>");
    // Each instant written twice: a checkable ISO, plus the quantity the reader actually wants
    // (the age relative to generatedAt).
    expect(content).toContain("<updated_at>2026-08-21T09:05:00.000Z (40s ago)</updated_at>");
    expect(content).toContain("<created_at>2026-08-21T09:00:00.000Z (5m 40s ago)</created_at>");
    expect(content).toContain("<usage>spent_tokens=1204");
    expect(content).not.toContain("budget");
    expect(content).toContain("nodes_observed=3");
    expect(content).toContain("nodes_running=1");
    // The roster replaced the former identity-only actors table: names first, then address and
    // phase.
    expect(content).toContain("judge  agent#1@1  executing");
    expect(content).toContain("agent#2@1");
    expect(content).toContain("[11]  4m 50s ago  collected the failing specs");
    expect(content).not.toContain("possibly_interrupted");
    expect(content).not.toContain("<result>");
    expect(content).not.toContain("<error");
  });

  // An AmendWorkflow that omits `max_concurrency` carries over exactly this number, so it must be
  // visible on the model face — otherwise the model cannot know what a revision would inherit.
  it("gives the run's concurrency bound its own tag, and only when there is one", () => {
    const limited = String(
      getWorkflowRunToolEntry.formatModelContent?.({ ...RUNNING_OUTPUT, maxConcurrency: 3 }),
    );
    expect(limited).toContain("<max_concurrency>3</max_concurrency>");
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "max_concurrency",
    );
  });

  // Same reasoning: an AmendWorkflow that omits `subagent_model` carries over exactly this string.
  it("gives the run's subagent model its own tag, and only when there is one", () => {
    const chosen = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        subagentModel: "bigmodel/GLM-4.6$high",
      }),
    );
    expect(chosen).toContain("<subagent_model>bigmodel/GLM-4.6$high</subagent_model>");
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "subagent_model",
    );
  });

  // Models named by the script (docs/dynamic-workflow/launch.md "GetWorkflowRun"): a revision
  // reusing the same names inherits these bindings.
  it("lists the script's model bindings one per line, next to the subagent model, only when there are any", () => {
    const bound = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        subagentModel: "bigmodel/GLM-4.6$high",
        modelBindings: {
          "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash",
          "GLM-5.3$high": "zhipu/GLM-5.3$high",
        },
      }),
    );
    expect(bound).toContain(
      '<script_models>\n"GLM-5.3-Flash" = zhipu/GLM-5.3-Flash\n"GLM-5.3$high" = zhipu/GLM-5.3$high\n</script_models>',
    );
    expect(bound.indexOf("<subagent_model>")).toBeLessThan(bound.indexOf("<script_models>"));
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "script_models",
    );
  });

  // The script-file sentence goes into `<amendable>` (docs/dynamic-workflow/launch.md "Script
  // files"): this block is about "how to revise", and without the file the model is left to
  // re-paste a twenty-thousand-token script inline.
  it("names the script file inside <amendable>, in both the short and the full form", () => {
    const sentence =
      ' Its script is at .zcode/workflow-drafts/audit.dwf.ts: edit that file in place and pass `path: ".zcode/workflow-drafts/audit.dwf.ts"` to AmendWorkflow instead of a script.';

    // Healthy and running: the block is one sentence, and the script-file sentence still follows.
    const running = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        scriptPath: ".zcode/workflow-drafts/audit.dwf.ts",
      }),
    );
    expect(running).toContain(`cache.${sentence}</amendable>`);

    // Terminal (errored is this block's highest-value branch): the full argument, then the same
    // sentence.
    const errored = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "errored" as const,
        scriptPath: ".zcode/workflow-drafts/audit.dwf.ts",
      }),
    );
    expect(errored).toContain("Do NOT rewrite from scratch.");
    expect(errored).toContain(`${sentence}</amendable>`);
  });

  it("says nothing about a script file when the run recorded none", () => {
    for (const output of [RUNNING_OUTPUT, { ...RUNNING_OUTPUT, status: "errored" as const }]) {
      const content = String(getWorkflowRunToolEntry.formatModelContent?.(output));
      expect(content).toContain("<amendable>");
      expect(content).not.toContain("Its script is at");
    }
  });

  it("says so in words when a running run has produced no log yet", () => {
    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        actors: [],
        logTail: [],
      }),
    );

    expect(content).toMatch(/no log/i);
  });

  it("puts the artifact in its own block and the failure code in an attribute", () => {
    const completed = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "completed",
        result: '{\n  "verdict": "ship"\n}',
      }),
    );
    const interrupted = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "the owning process exited" },
      }),
    );

    expect(completed).toContain('<result>\n{\n  "verdict": "ship"\n}\n</result>');
    expect(interrupted).toContain("<stop_reason>interrupted</stop_reason>");
    expect(interrupted).toContain('<error code="Interrupted">the owning process exited</error>');
  });

  // The provider-stop `<error>` block shares one function with the terminal notification:
  // cause → action → facts line → raw line.
  it("renders a provider stop as the curated cause/fix block", () => {
    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "provider",
        error: {
          code: "ProviderStop",
          message: "Subagent turn failed: [1006] token expired",
          providerStop: {
            kind: "auth",
            reason: "auth_failed",
            providerId: "account:bigmodel-coding-plan",
            providerLabel: "BigModel",
            modelId: "GLM-5.3",
            providerCode: "1006",
            subagent: "verify@2",
            phase: "Verify",
            rawMessage: "[1006] token expired",
          },
        },
      }),
    );

    expect(content).toContain("<stop_reason>provider</stop_reason>");
    expect(content).toContain('<error code="ProviderStop">');
    expect(content).toContain("Sign-in to BigModel (account:bigmodel-coding-plan) expired");
    expect(content).toContain(`ResumeWorkflowRun with run_id="${RUNNING_OUTPUT.runId}"`);
    expect(content).toContain(
      "provider=account:bigmodel-coding-plan model=GLM-5.3 subagent=verify@2 phase=Verify code=1006",
    );
    expect(content).toContain("raw: [1006] token expired");
    // The resumable hint must first send the model to resolve the cause, not blindly resume.
    expect(content).toContain("<resumable>");
    expect(content).toMatch(/resolve the cause/i);
  });

  it("reports an invalid result instead of throwing", () => {
    expect(String(getWorkflowRunToolEntry.formatModelContent?.({ runId: 42 }))).toContain(
      "invalid result",
    );
  });

  // The predicate for the <resumable> hint block has the same semantics as the port.resume gate:
  // `stopped`, regardless of reason
  // (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md). Pin both positive and
  // negative cases so it cannot be loosened to errored (a run replay of ScriptError reproduces the
  // failure verbatim; the model must never be steered to resume it).
  it("adds the <resumable> hint exactly for stopped runs, with the reason-specific caveat", () => {
    const user = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "user",
      }),
    );
    const interrupted = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "the owning process exited" },
      }),
    );

    expect(user).toContain("<resumable>");
    expect(user).toContain("ResumeWorkflowRun");
    expect(interrupted).toContain("<resumable>");
    expect(interrupted).toContain("ResumeWorkflowRun");
    // The user hint block must say it was stopped by a person on purpose and resumes only when the
    // user asks; interrupted does not carry that sentence (cancel-resume follow-up 2026-09-09).
    expect(user).toMatch(/stopped on purpose/i);
    expect(user).toMatch(/only when the user asks/i);
    expect(interrupted).not.toMatch(/stopped on purpose/i);
    // "Resume as-is, wait for the user to speak" and "stopped for a fix, amend it now" are two
    // different things: the model-stopped hint block has both sentences, the user-stopped one only
    // the first (amend-resume follow-up 2026-09-14).
    const model = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "model",
      }),
    );
    expect(model).toMatch(/only if that is what the user wants/i);
    expect(model).toMatch(/amend it now/i);
    expect(user).not.toMatch(/amend it now/i);
    expect(getWorkflowRunToolEntry.metadata.description ?? "").toMatch(/only when the user asks/i);
  });

  it("keeps the <resumable> hint off every non-resumable state", () => {
    const nonResumable = [
      // completed: already finished; there is nothing to resume.
      { ...RUNNING_OUTPUT, status: "completed" as const, result: "done" },
      // running / pending: in flight or not yet started; resuming is a meaningless action.
      RUNNING_OUTPUT,
      { ...RUNNING_OUTPUT, status: "pending" as const },
      // errored: the script genuinely failed and a replay would reproduce the failure verbatim —
      // the predicate must never be loosened to include it.
      {
        ...RUNNING_OUTPUT,
        status: "errored" as const,
        error: { code: "DriverError", message: "the script itself failed" },
      },
    ];
    for (const detail of nonResumable) {
      expect(String(getWorkflowRunToolEntry.formatModelContent?.(detail))).not.toContain(
        "<resumable>",
      );
    }
  });

  // Amend-resume (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Terminal
  // states"): amend's eligible set is **any terminal state**, deliberately different from the plain
  // resume set. The two hint blocks each say their own thing and neither may pollute the other.
  it("adds the <amendable> hint for every terminal run, including completed and ScriptError", () => {
    const terminal = [
      { ...RUNNING_OUTPUT, status: "completed" as const, result: "done" },
      { ...RUNNING_OUTPUT, status: "stopped" as const, stopReason: "user" as const },
      {
        ...RUNNING_OUTPUT,
        status: "errored" as const,
        error: { code: "DriverError", message: "the script itself failed" },
      },
      {
        ...RUNNING_OUTPUT,
        status: "stopped" as const,
        stopReason: "interrupted" as const,
        error: { code: "Interrupted", message: "the owning process exited" },
      },
    ];
    for (const detail of terminal) {
      const content = String(getWorkflowRunToolEntry.formatModelContent?.(detail));
      expect(content).toContain("<amendable>");
      expect(content).toContain("AmendWorkflow");
      expect(content).toContain("run_id");
      // The run ID goes into the hint: the model can copy it directly without scrolling back to
      // <run_id>.
      expect(content).toContain(RUNNING_OUTPUT.runId);
      // Omit script when only settings change (docs/dynamic-workflow/launch.md "Keeping the
      // predecessor's script"): if this is not said, the model will copy the whole script again
      // just to change one number.
      expect(content).toContain(
        "To change only its settings (max_concurrency, subagent_model, name), omit both `script` and `path`: the new run keeps this run's script.",
      );
    }
  });

  // docs/dynamic-workflow/launch.md "The `AmendWorkflow` tool": an in-flight run can be amended
  // too (amend stops it first), so the hint block is also present for running / pending, and the
  // tail sentence says "amend now, do not TaskStop first".
  // But the **healthy running** variant collapses to one sentence: at that moment there is no
  // decision for the model to make, and the full argument only crowds out the attention it spends
  // reading the roster; not-yet-started (pending) and already stalled runs still get the full
  // argument.
  it("keeps the <amendable> hint on runs that have not finished, with the amend-now tail", () => {
    const stalled = {
      ...RUNNING_OUTPUT,
      health: { ...RUNNING_OUTPUT.health, stalledSince: Date.UTC(2026, 7, 21, 9, 3, 0) },
    };
    for (const detail of [{ ...RUNNING_OUTPUT, status: "pending" as const }, stalled]) {
      const content = String(getWorkflowRunToolEntry.formatModelContent?.(detail));
      expect(content).toContain("<amendable>");
      expect(content).toContain("It is still running");
      expect(content).toContain("Do not TaskStop it first");
    }
  });

  it("collapses <amendable> to one sentence while the run is running and healthy", () => {
    const content = String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT));

    expect(content).toContain(
      '<amendable>AmendWorkflow with run_id "dwfrun-running" supersedes this run with a revised script and imports its finished work as cache.</amendable>',
    );
    // The one-sentence form does not carry the "omit script" sentence: a healthy running run has
    // no decision for the model to make right now.
    expect(content).not.toContain("omit both `script` and `path`");
    expect(content).not.toContain("Do not TaskStop it first");
  });

  it("replaces <resumable> and <amendable> with <superseded> on a superseded run", () => {
    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped" as const,
        stopReason: "superseded" as const,
        supersededBy: "dwfrun-next",
      }),
    );
    expect(content).toContain("<superseded_by>dwfrun-next</superseded_by>");
    expect(content).toContain("<superseded>");
    expect(content).toContain("run dwfrun-next");
    expect(content).not.toContain("<resumable>");
    expect(content).not.toContain("<amendable>");
  });

  // A genuinely failed script is the highest-value amend scenario, and the model's default reflex
  // is to rewrite from scratch. The tail sentence must call that out.
  it("tells a script-failed run to fix the script instead of rewriting from scratch", () => {
    const scriptError = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "errored" as const,
        error: { code: "DriverError", message: "the script itself failed" },
      }),
    );

    expect(scriptError).toMatch(/rewrite/i);
    expect(scriptError).toMatch(/fix the script/i);
  });

  // When both hint blocks are present (a stopped run qualifies for plain resume and amend alike),
  // the difference must be spelled out in the hints: same run, same script vs new run, new script.
  // Otherwise the model only sees two equally clickable routes.
  it("distinguishes plain resume from amend when a run qualifies for both", () => {
    const cancelled = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped" as const,
        stopReason: "user" as const,
      }),
    );

    expect(cancelled).toContain("<resumable>");
    expect(cancelled).toContain("<amendable>");
    // The plain-resume side's semantics are not weakened: same run ID, byte-identical script.
    expect(cancelled).toContain("same run ID");
    expect(cancelled).toMatch(/byte-for-byte/i);
    // The amend side: new run, revised script.
    expect(cancelled).toMatch(/revised script/i);
  });
});

// ————————————————————————————————————————————————
// Escalated questions while parked (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md).
//
// This is the model side's **only** discovery surface: escalation notifications have two known drop
// paths (stale branch generation / shutdown), and `ResolveWorkflowQuestion` only accepts a qid. The
// spec wrote the "query fallback" as the safety net for those two paths, and both the server-side
// wording for `unknown_question` and the escalation notification explicitly point here — so what
// these assertions pin is not a display detail but whether those two promises are kept.
// ————————————————————————————————————————————————
const PARKED_QUESTIONS = [
  {
    qid: "dwfq-parked01-1",
    actor: "agent#1@1",
    actorName: "judge",
    question: "评分上限是 95，通过线是 96，这个门不可能过。",
    context: "已经试了 6 轮，最高 95。",
    askedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  },
  {
    qid: "dwfq-parked01-2",
    actor: "agent#2@1",
    question: "两条指令互相矛盾，先满足哪一条？",
    askedAt: Date.UTC(2026, 7, 21, 9, 4, 30),
  },
];

const PARKED_DETAIL: DynamicWorkflowRunDetail = {
  ...RUNNING_DETAIL,
  runId: "dwfrun-parked",
  pendingQuestions: PARKED_QUESTIONS,
};

const PARKED_OUTPUT: GetWorkflowRunOutput = {
  ...RUNNING_OUTPUT,
  runId: "dwfrun-parked",
  pendingQuestions: PARKED_QUESTIONS,
};

describe("GetWorkflowRun handler — pending escalations", () => {
  it("surfaces parked questions with their IDs, and keeps the field absent when there are none", async () => {
    const output = await call("dwfrun-parked", stubDetailPort({ "dwfrun-parked": PARKED_DETAIL }));
    const parsed = GetWorkflowRunOutputSchema.parse(output);

    expect(parsed.pendingQuestions).toHaveLength(2);
    expect(parsed.pendingQuestions?.[0]).toEqual({
      qid: "dwfq-parked01-1",
      actor: "agent#1@1",
      actorName: "judge",
      question: "评分上限是 95，通过线是 96，这个门不可能过。",
      context: "已经试了 6 轮，最高 95。",
      askedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    });
    // An anonymous actor gets no synthesized fallback name; an absent optional field is absent.
    expect(parsed.pendingQuestions?.[1] && "actorName" in parsed.pendingQuestions[1]).toBe(false);
    expect(parsed.pendingQuestions?.[1] && "context" in parsed.pendingQuestions[1]).toBe(false);

    // Zero entries → the whole field is absent (an empty array would read as "asked and all
    // answered"; absence is what says "nobody is waiting").
    const idle = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }));
    expect("pendingQuestions" in idle).toBe(false);
    const empty = await call(
      "dwfrun-empty",
      stubDetailPort({ "dwfrun-empty": { ...RUNNING_DETAIL, runId: "dwfrun-empty", pendingQuestions: [] } }),
    );
    expect("pendingQuestions" in empty).toBe(false);
  });

  it("renders the pending block with the qid and the ResolveWorkflowQuestion instruction", () => {
    const content = String(getWorkflowRunToolEntry.formatModelContent?.(PARKED_OUTPUT));

    expect(content).toContain("<pending_questions>");
    expect(content).toContain("dwfq-parked01-1");
    expect(content).toContain("dwfq-parked01-2");
    expect(content).toContain("judge");
    // An anonymous actor falls back to the structured ref.
    expect(content).toContain("agent#2@1");
    expect(content).toContain("ResolveWorkflowQuestion");
    // Placed before the log tail: a parked actor is the thing to do right now and must not be
    // buried behind twenty lines of narrative.
    expect(content.indexOf("<pending_questions>")).toBeLessThan(content.indexOf("<log_tail>"));
  });

  it("omits the pending block entirely for a run with nothing parked", () => {
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "pending_questions",
    );
  });
});

// ————————————————————————————————————————————————
// The situation cross-section (docs/dynamic-workflow/launch.md "`GetWorkflowRun`").
//
// The three scenarios pin the same thing: can this output answer "where is the run, who is doing
// what, is it still moving". The block order is a contract, and so is the wording of each line —
// so this asserts both the order and the words of those lines. `summary` is cast by the real
// assembler (not a hand-written sentence), so these three texts are the true end-to-end rendering.
// ————————————————————————————————————————————————

/** Where each block appears in the text, used to assert the block order. */
function blockOrder(content: string, tags: readonly string[]): number[] {
  return tags.map((tag) => content.indexOf(tag));
}

function renderWithSummary(base: Omit<GetWorkflowRunOutput, "summary">): string {
  const output: GetWorkflowRunOutput = { ...base, summary: buildWorkflowRunSummary(base) };
  return String(getWorkflowRunToolEntry.formatModelContent?.(output));
}

const SITREP_BASE: Omit<GetWorkflowRunOutput, "summary"> = {
  runId: "dwfrun-7f3a",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  generatedAt: NOW,
  maxConcurrency: 3,
  subagentModel: "bigmodel/GLM-4.6$high",
  // The counters and the roster line up with each other: each subagent in the live phase
  // contributes one still-running ask row (one executing / one waiting / one parked), so
  // nodesRunning = 3; nodesObserved is the sum of the three states = 5 + 3.
  usage: {
    spentTokens: 18_420,
    nodesObserved: 8,
    nodesRunning: 3,
    nodesCompleted: 5,
    nodesFailed: 0,
  },
  actors: [
    { siteId: "agent#1", ordinal: 1, name: "collector" },
    { siteId: "agent#2", ordinal: 1, name: "judge" },
    { siteId: "agent#2", ordinal: 2, name: "judge" },
    { siteId: "agent#3", ordinal: 1 },
  ],
  logTail: [
    { sequence: 11, message: "collected 14 failing specs", at: Date.UTC(2026, 7, 21, 9, 0, 50) },
    { sequence: 14, message: "dispatching judges in pairs", at: Date.UTC(2026, 7, 21, 9, 1, 50) },
    { sequence: 19, message: "judge#1 finished: 6 flaky, 1 real", at: Date.UTC(2026, 7, 21, 9, 4, 10) },
  ],
  phases: [
    { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 0, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
    { name: "judge", state: "current", rounds: 1, nodesSettled: 3, nodesRunning: 3, enteredAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
    { name: "verify", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
    { name: "report", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
  ],
  subagents: [
    {
      siteId: "agent#1",
      ordinal: 1,
      name: "collector",
      // On a live run the port never sends `done` (that is a terminal word): a subagent that
      // finished its own share is `idle`.
      state: "idle",
      phaseName: "collect",
      stepsSettled: 2,
      stepsFailed: 0,
      tokens: 6_210,
    },
    {
      siteId: "agent#2",
      ordinal: 1,
      name: "judge",
      state: "parked",
      phaseName: "judge",
      currentAsk: {
        siteId: "ask#4",
        ordinal: 0,
        actorSeq: 1,
        instructionsHead: "Judge specs 8-14 for flakiness; report real failures with evidence",
        startedAt: Date.UTC(2026, 7, 21, 9, 2, 0),
      },
      parkedOn: "q-01",
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 4_980,
    },
    {
      siteId: "agent#2",
      ordinal: 2,
      name: "judge",
      state: "executing",
      phaseName: "judge",
      currentAsk: {
        siteId: "ask#4",
        ordinal: 1,
        actorSeq: 2,
        instructionsHead: "Judge specs 1-7 for flakiness; report real failures with evidence",
        startedAt: Date.UTC(2026, 7, 21, 9, 4, 28),
        turn: 4,
        toolCalls: 7,
        lastTool: { name: "Read", target: "packages/net/retry.spec.ts", at: Date.UTC(2026, 7, 21, 9, 5, 32) },
      },
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 5_100,
      lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 32),
    },
    {
      siteId: "agent#3",
      ordinal: 1,
      state: "waiting",
      phaseName: "judge",
      wait: { cause: "backoff", reason: "429", retryAfterMs: 20_000, since: Date.UTC(2026, 7, 21, 9, 5, 20) },
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 2_130,
    },
  ],
  health: {
    lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    concurrency: { effective: 2, cap: 3, reason: "rate_limited", since: Date.UTC(2026, 7, 21, 9, 4, 35) },
    consecutiveFailures: 0,
    cachedSteps: 0,
    pendingQuestionsKnown: true,
  },
  pendingQuestions: [
    {
      qid: "q-01",
      actor: "agent#2@1",
      actorName: "judge",
      question: "Two specs disagree on the retry budget; which one is authoritative?",
      context: "packages/net/retry.spec.ts vs docs/net/retry.md",
      askedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    },
  ],
  artifacts: [{ id: "triage-board", kind: "board", title: "Triage board", version: 3, itemCount: 7 }],
};

describe("GetWorkflowRun model content — a running situation report", () => {
  const content = renderWithSummary(SITREP_BASE);

  it("keeps the contract block order, summary first and routing last", () => {
    const order = blockOrder(content, [
      "<summary>",
      "<run_id>",
      "<status>",
      "<max_concurrency>",
      "<subagent_model>",
      "<created_at>",
      "<pending_questions>",
      "<health>",
      "<phases>",
      "<subagents>",
      "<log_tail>",
      "<usage>",
      "<artifacts",
      "<amendable>",
    ]);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it("assembles the summary from status, phase position, step counts, questions and progress", () => {
    expect(content).toContain(
      "<summary>Running for 5m 40s, in phase 2 of 4 (judge). 5 of 8 dispatched steps settled, 3 running (1 executing, 1 waiting, 1 parked). 1 question awaiting your answer. Last progress 40s ago.</summary>",
    );
  });

  it("reports health on one line with the throttle and its age", () => {
    expect(content).toContain(
      "<health>last_progress=40s ago  concurrency=2/3 (rate_limited since 1m 05s ago)  stalled=no  consecutive_failures=0  cached_steps=0</health>",
    );
  });

  // An `ahead` row has only the name and the state: it has not happened yet, so no rounds, no
  // counts, no duration.
  it("draws the phase table with rounds, counts and the current phase's time so far", () => {
    expect(content).toContain("1. collect  done     1 round  2 steps settled  1m 20s");
    expect(content).toContain("2. judge    current  1 round  3 settled, 3 running  4m 20s so far");
    expect(content).toContain("3. verify   ahead");
    expect(content).toContain("4. report   ahead");
  });

  // A line reads as "who · where · which actor · which phase · doing what · how much spent".
  it("draws one roster line per subagent, with the ask, the last tool and the wait cause", () => {
    expect(content).toContain(
      "judge      agent#2@2  executing  phase judge  ask#4@1 (step 3), 1m 12s on this step, turn 4, 7 tool calls, last Read packages/net/retry.spec.ts 8s ago  5,100 tokens",
    );
    expect(content).toContain("judge      agent#2@1  parked     phase judge  on question q-01 for 40s  4,980 tokens");
    expect(content).toContain("agent#3@1  waiting    phase judge  backoff after 429 for 20s, retry in 20s  2,130 tokens");
    expect(content).toContain("collector  agent#1@1  idle       phase collect  2 steps  6,210 tokens");
    // The task summary is indented on its own line, hung under the line it belongs to.
    expect(content).toContain("  task: Judge specs 1-7 for flakiness; report real failures with evidence");
  });

  it("prefixes each log line with its age", () => {
    expect(content).toContain("[19]  1m 30s ago  judge#1 finished: 6 flaky, 1 real");
  });

  it("dates the parked question by age instead of an ISO instant", () => {
    expect(content).toContain("[q-01] judge asked 40s ago");
    expect(content).toContain("ResolveWorkflowQuestion");
  });
});

describe("GetWorkflowRun model content — a completed run", () => {
  const completed: Omit<GetWorkflowRunOutput, "summary"> = {
    ...SITREP_BASE,
    status: "completed",
    updatedAt: Date.UTC(2026, 7, 21, 9, 4, 20),
    usage: { ...SITREP_BASE.usage, spentTokens: 41_200, nodesRunning: 0, nodesCompleted: 12, nodesObserved: 12 },
    phases: [
      { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 0, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
      { name: "judge", state: "done", rounds: 1, nodesSettled: 6, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 1, 20), exitedAt: Date.UTC(2026, 7, 21, 9, 3, 0) },
      { name: "verify", state: "done", rounds: 2, nodesSettled: 3, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 3, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 4, 0) },
      { name: "report", state: "done", rounds: 1, nodesSettled: 1, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 4, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 4, 20) },
    ],
    // Only on a terminal run is a finished subagent `done`.
    subagents: [{ ...SITREP_BASE.subagents[0]!, state: "done" }],
    health: { lastProgressAt: Date.UTC(2026, 7, 21, 9, 4, 20), consecutiveFailures: 0, cachedSteps: 2, pendingQuestionsKnown: true },
    pendingQuestions: undefined,
    result: "12 specs triaged",
    artifacts: [
      { id: "report", kind: "markdown", title: "Nightly triage report", version: 1, itemCount: 0, primary: true },
    ],
  };
  const content = renderWithSummary(completed);

  it("counts phases instead of pointing at one, and names the deliverable", () => {
    expect(content).toContain(
      "<summary>Completed in 4m 20s, across 4 phases. 12 steps settled, 41,200 tokens. Deliverable: Nightly triage report (markdown, primary).</summary>",
    );
  });

  // A terminal run reports no stalled (of course it no longer moves) and no leftover (there are no
  // leftover rows).
  it("drops the stalled reading from a terminal run's health", () => {
    expect(content).toContain("<health>last_progress=1m 20s ago  consecutive_failures=0  cached_steps=2</health>");
    expect(content).not.toContain("stalled=");
    expect(content).not.toContain("leftover");
  });

  it("gives every phase its duration and no 'so far'", () => {
    expect(content).toContain("2. judge    done  1 round  6 steps settled  1m 40s");
    expect(content).toContain("3. verify   done  2 rounds  3 steps settled  1m 00s");
    expect(content).not.toContain("so far");
  });
});

describe("GetWorkflowRun model content — an interrupted run seen from another session", () => {
  const interrupted: Omit<GetWorkflowRunOutput, "summary"> = {
    ...SITREP_BASE,
    status: "stopped",
    stopReason: "interrupted",
    ownedByThisSession: false,
    updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    error: { code: "Interrupted", message: "the owning process exited" },
    // In a terminal run, the "still running" rows are the leftovers: nodesRunning =
    // leftoverRunning = one row for each of the two unfinished subagents. observed is still the
    // sum of the three states = 5 + 2.
    usage: { ...SITREP_BASE.usage, nodesObserved: 7, nodesRunning: 2 },
    phases: [
      { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 0, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
      { name: "judge", state: "unfinished", rounds: 1, nodesSettled: 3, nodesRunning: 2, enteredAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
      { name: "verify", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
      { name: "report", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
    ],
    subagents: [
      { ...SITREP_BASE.subagents[0]!, state: "done" },
      {
        siteId: "agent#2",
        ordinal: 1,
        name: "judge",
        state: "unfinished",
        phaseName: "judge",
        currentAsk: { siteId: "ask#4", ordinal: 0, actorSeq: 1, startedAt: Date.UTC(2026, 7, 21, 9, 2, 0) },
        stepsSettled: 1,
        stepsFailed: 0,
        tokens: 4_980,
      },
      {
        siteId: "agent#2",
        ordinal: 2,
        name: "judge",
        state: "unfinished",
        phaseName: "judge",
        currentAsk: { siteId: "ask#4", ordinal: 1, actorSeq: 2, startedAt: Date.UTC(2026, 7, 21, 9, 4, 28) },
        stepsSettled: 1,
        stepsFailed: 0,
        tokens: 5_100,
      },
    ],
    health: {
      lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 0),
      consecutiveFailures: 0,
      cachedSteps: 0,
      leftoverRunning: 2,
      // The parked-question table lives only in the asking process's memory: this read has no way
      // to know whether anyone is waiting.
      pendingQuestionsKnown: false,
    },
    pendingQuestions: undefined,
    artifacts: undefined,
  };
  const content = renderWithSummary(interrupted);

  it("says the leftovers will be re-dispatched and that the run is another session's", () => {
    expect(content).toContain(
      "<summary>Stopped (interrupted) 40s ago after 5m 00s, in phase 2 of 4 (judge). 5 of 7 dispatched steps settled; 2 were still running when the owning process exited and will be re-dispatched on resume. Pending questions are unknown from this session. Owned by another session.</summary>",
    );
  });

  // Silence would be read as "nobody is waiting", the most dangerous misreading — this is one of
  // the only two places that say "unknown" out loud.
  it("replaces the pending block with the explicit unknown sentence", () => {
    expect(content).toContain("<pending_questions>Unknown: pending questions are tracked only by the process");
    expect(content).toContain("Resuming the run will re-ask any question its subagent still needs answered.");
    expect(content).not.toContain("[q-01]");
  });

  // The other place: rows marked running in a terminal run are leftovers, not live work.
  it("adds the leftover note under health and marks the phase unfinished", () => {
    expect(content).toContain('The 2 "running" steps below are leftovers of the exited process, not live work.');
    expect(content).toContain("2. judge    unfinished  1 round  3 settled, 2 unfinished");
    expect(content).toContain("judge      agent#2@1  unfinished  phase judge  ask#4@0 (step 2) was in flight at the stop");
  });

  it("still routes to ResumeWorkflowRun and AmendWorkflow with the full argument", () => {
    expect(content).toContain("<resumable>");
    expect(content).toContain("<amendable>");
    expect(content).toContain("Use it when the script or a setting needs to change");
  });
});

describe("GetWorkflowRun declaration", () => {
  it("declares a read-only, no-side-effect capability consistently on both faces", () => {
    expect(getWorkflowRunToolEntry.metadata).toMatchObject({
      name: GET_WORKFLOW_RUN_TOOL_NAME,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      timeoutMs: 10_000,
    });
    expect(getWorkflowRunToolEntry.permission).toMatchObject({
      permission: "getWorkflowRun",
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      denyPriority: "beforeAsk",
    });
    expect(getWorkflowRunToolEntry.permission.alwaysAsk).toBeUndefined();
  });

  // The result is exactly the kind of payload that can grow large enough to need an artifact
  // (modeled on TaskOutput).
  it("budgets the result as a persistable artifact", () => {
    expect(getWorkflowRunToolEntry.resultBudget).toMatchObject({
      maxInlineBytes: 400_000,
      maxModelBytes: 400_000,
      strategy: "artifact",
      artifact: { enabled: true, retention: "session" },
    });
    expect(getWorkflowRunToolEntry.maxModelChars).toBe(100_000);
    expect(getWorkflowRunToolEntry.resultArtifactContentType).toBe("text/plain");
  });

  // tool-contracts.test.ts's full v2 round-trip aborts at the first inconsistency; each new tool
  // pins it again here on its own.
  it("declares the v2 common contract", () => {
    expectV2CommonContract(getWorkflowRunToolEntry);
  });

  it("steers the model to TaskOutput for blocking waits and away from polling", () => {
    const description = getWorkflowRunToolEntry.metadata.description ?? "";

    expect(description).toMatch(/do not poll/i);
    expect(description).toMatch(/notification/i);
    expect(description).toContain("TaskOutput");
    expect(description).toMatch(/wait/i);
    expect(description).toContain("ListWorkflowRuns");
  });

  // Routing guidance (2026-08-29): resumable terminal states must point at ResumeWorkflowRun. Pin
  // keywords, not verbatim text.
  it("cross-references ResumeWorkflowRun for the resumable terminal states", () => {
    const description = getWorkflowRunToolEntry.metadata.description ?? "";

    expect(description).toContain("ResumeWorkflowRun");
    expect(description).toMatch(/cancel/i);
    expect(description).toContain("interrupted");
  });

  // Amend-resume (2026-08-31): the description also needs the second route, and it must be
  // distinguished from the previous one.
  it("cross-references AmendWorkflow for any run and names the superseded state", () => {
    const description = getWorkflowRunToolEntry.metadata.description ?? "";

    expect(description).toContain("AmendWorkflow");
    expect(description).not.toContain("resume_from");
    expect(description).toMatch(/revised/i);
    expect(description).toContain("superseded");
  });
});

describe("GetWorkflowRun registration", () => {
  it("is always on, with no gate option", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);

    expect(registry.has(GET_WORKFLOW_RUN_TOOL_NAME)).toBe(true);
    expect(registry.toContracts().map((tool) => tool.name)).toContain(GET_WORKFLOW_RUN_TOOL_NAME);
  });

  for (const mode of ["plan", "build", "yolo"] as const) {
    it(`is auto-allowed in ${mode} mode`, () => {
      const capability = resolveRuntimePermissionCapability(
        getWorkflowRunToolEntry,
        { run_id: "dwfrun-x" },
        {
          workingDirectory: "/workspace/project",
          workspaceRoot: "/workspace/project",
        } as never,
      );

      expect(
        new PermissionService().checkPermission(
          {
            input: { run_id: "dwfrun-x" },
            mode,
            riskLevel: "low",
            toolName: GET_WORKFLOW_RUN_TOOL_NAME,
          },
          capability,
        ),
      ).toMatchObject({ allowed: true, decision: "allow" });
    });
  }
});

// Holes (docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"): `holes` follows the same
// rule as pendingQuestions — absent at zero entries, mirrored field by field; the model face's
// `<holes>` block lists the waiting and the filled ones and names FillWorkflowHole and hole_id.
describe("GetWorkflowRun handler — holes", () => {
  const holes = [
    {
      siteId: "hole#1",
      ordinal: 1,
      name: "决定分组",
      type: "Verdict",
      state: "waiting" as const,
      since: NOW - 40_000,
    },
    {
      siteId: "hole#2",
      ordinal: 1,
      name: "收尾",
      type: "string",
      state: "filled" as const,
      filledAt: NOW - 10_000,
      filledBy: "sess_get_run",
    },
  ];

  it("mirrors the holes list and leaves it absent when empty", async () => {
    const detail: DynamicWorkflowRunDetail = { ...RUNNING_DETAIL, holes };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));
    expectMirrorsDetail(output, detail);
    // The summary calls it out too: a waiting hole is what the model is being asked to do right
    // now (filled ones do not count).
    expect(output.summary).toContain("1 hole awaiting your code.");
    const empty = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": { ...RUNNING_DETAIL, holes: [] } }),
    );
    expect("holes" in empty).toBe(false);
    expect(empty.summary).not.toContain("hole");
  });

  it("renders a <holes> block naming FillWorkflowHole and the hole ids, after pending questions", () => {
    const text = getWorkflowRunToolEntry.formatModelContent!({
      ...RUNNING_OUTPUT,
      pendingQuestions: [
        { qid: "dwfq-1", actor: "agent#1@1", question: "q?", askedAt: NOW - 5_000 },
      ],
      holes,
    }) as string;
    expect(text).toContain("<holes>");
    expect(text).toContain('[hole#1] "决定分组": Verdict — waiting 40s');
    expect(text).toContain('[hole#2] "收尾": string — filled 10s ago');
    expect(text).toContain(
      'FillWorkflowHole with run_id="dwfrun-running" and the hole id in brackets as hole_id',
    );
    expect(text.indexOf("<pending_questions>")).toBeLessThan(text.indexOf("<holes>"));
    expect(text.indexOf("<holes>")).toBeLessThan(text.indexOf("<health"));
    expect(getWorkflowRunToolEntry.formatModelContent!(RUNNING_OUTPUT) as string).not.toContain(
      "<holes>",
    );
  });
});

// Nested holes: a nested site id appears verbatim inside the square brackets of the `<holes>`
// block (the escaping does not touch `/` or `#`).
describe("GetWorkflowRun — nested hole ids", () => {
  it("prints the nested site id verbatim", () => {
    const text = getWorkflowRunToolEntry.formatModelContent!({
      ...RUNNING_OUTPUT,
      holes: [
        {
          siteId: "hole#1/hole#1/hole#2",
          ordinal: 1,
          name: "内层",
          type: "Inner",
          state: "waiting" as const,
          since: NOW - 1_000,
        },
      ],
    }) as string;
    expect(text).toContain('[hole#1/hole#1/hole#2] "内层": Inner — waiting 1s');
  });
});
