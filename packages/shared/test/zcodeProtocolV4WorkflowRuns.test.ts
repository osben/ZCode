// Protocol surface of the workflowRuns state key + event-log query.
// See docs/dynamic-workflow/presentation.md "The run state the pane draws", "Event log", "v4 wire version skew".
import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  WORKFLOW_RUNS_LIMITS,
  workflowRunPhaseSchema,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunNodeLastToolSchema,
  backgroundWorkSummarySchema,
  conversationSnapshotSchema,
  statePatchSchema,
  v4ConversationWorkflowRunEventsParamsSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunSummarySchema,
  v4ConversationWorkflowRunsResultSchema,
  workflowRunsStateSchema,
  PROTOCOL_V4_LIMITS,
  WORKFLOW_ARTIFACT_LIMITS,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  workflowRunArtifactSchema,
  workflowRunArtifactSummarySchema,
} from "../src/zcode-protocol-v4/index.js";

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: "dwfrun-1",
    toolCallId: "tc-1",
    status: "running" as const,
    usage: { spentTokens: 1_200, nodesUsed: 3 },
    actors: [
      {
        siteId: "actor#1",
        ordinal: 1,
        name: "planner",
        sessionId: "sess_dwf-1",
        status: "running" as const,
      },
    ],
    nodes: [
      {
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask" as const,
        phase: "settled" as const,
        outcome: "ok" as const,
      },
    ],
    lastEventSequence: 9,
    ...overrides,
  };
}

describe("workflowRuns 状态键", () => {
  it("接受完整的运行态条目并原样回出", () => {
    const state = { revision: 3, runs: [run()] };
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("用量只记已花 token 与步数：没有上限、没有剩余量、没有 budget 键", () => {
    // docs/dynamic-workflow/authoring.md: the budget construct was removed entirely; usage is an observation surface.
    const usage = run({ usage: { spentTokens: 42, nodesUsed: 1 } });
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [usage] })).toEqual({
      revision: 1,
      runs: [usage],
    });
    // Old-shape bound keys are stripped (zod non-strict: skew between old desktops and new agents is handled by stripping, not frame rejection).
    const stale = run({ usage: { spentTokens: 1, nodesUsed: 1, maxNodes: 100, budgetTotal: 10 } });
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [stale] }).runs[0]?.usage).toEqual({
      spentTokens: 1,
      nodesUsed: 1,
    });
    // Remaining-only shapes without spent values are invalid; `budget` is also no longer a key that can substitute for `usage`.
    for (const invalid of [
      run({ usage: { remainingTokens: 1, remainingNodes: 1 } }),
      { ...run(), usage: undefined, budget: { spentTokens: 1, nodesUsed: 1 } },
    ]) {
      expect(() => workflowRunsStateSchema.parse({ revision: 1, runs: [invalid] })).toThrow();
    }
  });

  it("actors 与 nodes 同界：每个节点都属于某个 actor，压低 actors 只会让平常的 fan-out 静默丢子代理", () => {
    // Used to be 32: a 50-way fan-out would lose 18 subagents in the inspector, while the node table, the engine, and the graph all had room.
    expect(WORKFLOW_RUNS_LIMITS.maxActors).toBe(WORKFLOW_RUNS_LIMITS.maxNodes);
  });

  it("四个数组各有上限，超界即拒（生产侧在超界前置 truncated）", () => {
    const many = (count: number, make: (index: number) => unknown) =>
      Array.from({ length: count }, (_, index) => make(index));

    expect(() =>
      workflowRunsStateSchema.parse({
        revision: 1,
        runs: many(WORKFLOW_RUNS_LIMITS.maxRuns + 1, (index) => run({ runId: `dwfrun-${index}` })),
      }),
    ).toThrow();

    expect(() =>
      workflowRunsStateSchema.parse({
        revision: 1,
        runs: [
          run({
            actors: many(WORKFLOW_RUNS_LIMITS.maxActors + 1, (index) => ({
              siteId: "actor#1",
              ordinal: index,
              status: "waiting",
            })),
          }),
        ],
      }),
    ).toThrow();

    expect(() =>
      workflowRunsStateSchema.parse({
        revision: 1,
        runs: [
          run({
            nodes: many(WORKFLOW_RUNS_LIMITS.maxNodes + 1, (index) => ({
              siteId: "ask#1",
              ordinal: index,
              phase: "queued",
            })),
          }),
        ],
      }),
    ).toThrow();
    expect(() =>
      workflowRunsStateSchema.parse({
        revision: 1,
        runs: [
          run({
            reports: many(WORKFLOW_RUNS_LIMITS.maxReports + 1, (index) => ({
              siteId: "report#1",
              ordinal: index,
              preview: "finding",
            })),
          }),
        ],
      }),
    ).toThrow();
  });

  // ── Data surface of the Results section (docs/dynamic-workflow/presentation.md "The run pane") ──

  it("reports 是渐进产物的有序列表，每条带身份与有界预览", () => {
    const withReports = run({
      reports: [
        { siteId: "report#1", ordinal: 1, preview: "found 3 stale imports" },
        { siteId: "report#2", ordinal: 1, preview: '{\n  "file": "a.ts"\n}' },
      ],
    });
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [withReports] })).toEqual({
      revision: 1,
      runs: [withReports],
    });
  });

  it("reports 零条时整个键缺席，而不是空数组（Results 区据此整区不渲染）", () => {
    // Key absence is a legal shape: optional is precisely the skew-safe half — an old CLI that sends no reports
    // will not make the whole state.updated patch fail to parse on a known key (skew tier three).
    expect(workflowRunsStateSchema.safeParse({ revision: 1, runs: [run()] }).success).toBe(true);
    expect(
      workflowRunsStateSchema.parse({ revision: 1, runs: [run()] }).runs[0],
    ).not.toHaveProperty("reports");
  });

  it("单条 report 的预览有界（展示预算，不是引擎契约）", () => {
    // The engine's run-level report cap (REPORT_CAPS) is the contract; the 64 items / 2KB on the protocol line is a **display** budget.
    // They need not match: entries beyond the display bound still live on the journal's kind="report" rows.
    expect(WORKFLOW_RUNS_LIMITS.maxReports).toBe(64);
    expect(
      workflowRunsStateSchema.safeParse({
        revision: 1,
        runs: [
          run({
            reports: [
              {
                siteId: "report#1",
                ordinal: 1,
                preview: "x".repeat(WORKFLOW_RUNS_LIMITS.maxReportPreviewLength + 1),
              },
            ],
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("node.kind 可缺省：resume 的 cached 命中只发 node-settled，从不发 node-queued", () => {
    // engine.ts:228/232 — a completed-hit short-circuits straight to settled, so kind is unobservable.
    const cached = run({
      nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok", cached: true }],
    });
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [cached] })).toEqual({
      revision: 1,
      runs: [cached],
    });
  });

  it("phase 词汇表就是引擎实际发出的七个（executing / waiting 自 v2 起可观察，throttled 已删）", () => {
    for (const phase of [
      "queued",
      "dispatched",
      "executing",
      "waiting",
      "repairing",
      "nudged",
      "settled",
    ]) {
      expect(
        workflowRunsStateSchema.safeParse({
          revision: 1,
          runs: [run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase }] })],
        }).success,
      ).toBe(true);
    }
    // The v1 throttled phase was replaced by waiting (docs/dynamic-workflow/concurrency.md "Protocol state").
    expect(
      workflowRunsStateSchema.safeParse({
        revision: 1,
        runs: [run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase: "throttled" }] })],
      }).success,
    ).toBe(false);
  });

  it("resultPreview 有界", () => {
    expect(
      workflowRunsStateSchema.safeParse({
        revision: 1,
        runs: [
          run({
            status: "completed",
            resultPreview: "x".repeat(WORKFLOW_RUNS_LIMITS.maxResultPreviewLength + 1),
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("进 statePatch 与 cold snapshot 两处（漏一处即静默丢运行态）", () => {
    const patch = statePatchSchema.parse({
      revision: 5,
      workflowRuns: { revision: 2, runs: [run()] },
    });
    expect(patch.workflowRuns?.runs[0]?.runId).toBe("dwfrun-1");
    expect(conversationSnapshotSchema.shape.workflowRuns).toBeDefined();
  });
});

describe("v4 版本偏斜：状态键 vs 行内枚举的不对称", () => {
  it("旧桌面的 non-strict statePatch 容器只丢掉未知键，保住其余键", () => {
    // This is a precedent record: workflowRuns needs no skew defense precisely because the container is not strict.
    const parsed = statePatchSchema.parse({ revision: 7, unknownFutureKey: { a: 1 } });
    expect(parsed.revision).toBe(7);
    expect(parsed).not.toHaveProperty("unknownFutureKey");
  });

  it("backgroundWorks.kind 加宽到 workflow（闭集，旧桌面会整帧拒收——见 spec 偏斜行）", () => {
    const work = {
      workId: "dwfrun-1",
      kind: "workflow" as const,
      title: "workflow run",
      status: "running" as const,
      startedAt: 1_700_000_000_000,
      anchorRowId: null,
    };
    expect(backgroundWorkSummarySchema.parse(work)).toEqual(work);
  });
});

describe("v4 conversation workflowRunEvents query", () => {
  it("声明一个只读、无状态、超时重发安全的分页 query", () => {
    expect(V4_METHODS.conversationWorkflowRunEvents).toBe("v4/conversation/workflowRunEvents");
    expect(
      v4ConversationWorkflowRunEventsParamsSchema.parse({
        sessionId: "session-1",
        runId: "dwfrun-1",
        afterSequence: 4,
        limit: 50,
      }),
    ).toEqual({ sessionId: "session-1", runId: "dwfrun-1", afterSequence: 4, limit: 50 });
    // cursor is optional (defaults to reading from the start), but unknown fields are always rejected.
    expect(
      v4ConversationWorkflowRunEventsParamsSchema.parse({ sessionId: "s", runId: "r" }),
    ).toEqual({ sessionId: "s", runId: "r" });
    expect(() =>
      v4ConversationWorkflowRunEventsParamsSchema.parse({
        sessionId: "s",
        runId: "r",
        cwd: "/repo",
      }),
    ).toThrow();
  });

  it("**刻意不带** atSeq / atLogEpoch —— journal cursor 永不失效，没有陈旧可防", () => {
    // The sibling rows/range and plans queries carry those two fields for stale-read protection because they read the conversation projection,
    // where a rowId only means something within one log epoch. This query reads the journal: sequence only appends, continues from the
    // existing max across resumes, and numbering never changes (proven by the journal contract tests), so the (runId, sequence) cursor is forever valid.
    // Carrying those fields would actually hurt: an unrelated session rewind would make the detail page lose a legitimate journal page.
    expect(Object.keys(v4ConversationWorkflowRunEventsResultSchema.shape).sort()).toEqual([
      "events",
      "hasMore",
    ]);
    // strict: one extra field is rejected outright, so "casually adding atLogEpoch later" turns red here first.
    expect(
      v4ConversationWorkflowRunEventsResultSchema.safeParse({
        events: [],
        hasMore: false,
        atLogEpoch: "epoch-1",
      }).success,
    ).toBe(false);
  });

  it("结果携带事件页与 hasMore（cursor 语义在 journal 契约测里证明）", () => {
    const result = {
      events: [{ sequence: 5, type: "node-settled", payload: { outcome: "ok" } }],
      hasMore: false,
    };
    expect(v4ConversationWorkflowRunEventsResultSchema.parse(result)).toEqual(result);
    expect(() =>
      v4ConversationWorkflowRunEventsResultSchema.parse({ ...result, events: undefined }),
    ).toThrow();
  });
});

// ── Summary shape of the dwf run enumeration query (docs/dynamic-workflow/launch.md "`/dwf`") ──
// The new label / updatedAt are additive optional: old CLIs do not send them, and the read side falls back to runId and
// "no time shown". What is pinned here is exactly that skew posture — the schema is one module on both sides (the server's
// v4-gateway.parse and the desktop's zcodeAgentService.parse share it), so adding optional keys breaks neither side.
describe("v4 conversation workflowRuns query 的 run 摘要", () => {
  function summary(overrides: Record<string, unknown> = {}) {
    return {
      runId: "dwfrun-1",
      status: "running" as const,
      resumable: false,
      ...overrides,
    };
  }

  it("最小摘要（无 label / updatedAt）照旧通过——老服务端的形状", () => {
    const minimal = summary();
    expect(v4ConversationWorkflowRunSummarySchema.parse(minimal)).toEqual(minimal);
  });

  it("label 与 updatedAt 可选且原样透传", () => {
    const full = summary({
      toolCallId: "tc-1",
      label: "nightly audit",
      updatedAt: 1_755_000_000_000,
      status: "stopped" as const,
      stopReason: "interrupted" as const,
      failureCode: "Interrupted",
      failureMessage: "owning process exited",
      resumable: true,
    });
    expect(v4ConversationWorkflowRunSummarySchema.parse(full)).toEqual(full);
  });

  it("lineage 两键可选：修订出来的 run 带 resumedFrom，被替代的 run 带 supersededBy（docs/dynamic-workflow/presentation.md「The run card」）", () => {
    // Field-tested 2026-09-14: this strict schema lacked those two keys + the superseded word, and the desktop's whole run catalog page was
    // rejected ("failed to read run summaries"), leaving the task island's finished count blank. Pinned: both successor and superseded pass.
    const successor = summary({ resumedFrom: "dwfrun-predecessor" });
    expect(v4ConversationWorkflowRunSummarySchema.parse(successor)).toEqual(successor);
    const predecessor = summary({
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "dwfrun-successor",
      resumable: false,
    });
    expect(v4ConversationWorkflowRunSummarySchema.parse(predecessor)).toEqual(predecessor);
    expect(
      v4ConversationWorkflowRunSummarySchema.safeParse(summary({ resumedFrom: "" })).success,
    ).toBe(false);
  });

  it("status 是三终态词汇；stopReason 五值可选（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）", () => {
    for (const status of ["completed", "errored", "pending", "running", "stopped"] as const) {
      expect(v4ConversationWorkflowRunSummarySchema.safeParse(summary({ status })).success).toBe(
        true,
      );
    }
    for (const status of ["failed", "cancelled"]) {
      expect(v4ConversationWorkflowRunSummarySchema.safeParse(summary({ status })).success).toBe(
        false,
      );
    }
    for (const stopReason of ["user", "model", "provider", "interrupted", "superseded"]) {
      expect(
        v4ConversationWorkflowRunSummarySchema.safeParse(summary({ status: "stopped", stopReason }))
          .success,
      ).toBe(true);
    }
    expect(
      v4ConversationWorkflowRunSummarySchema.safeParse(
        summary({ status: "stopped", stopReason: "crash" }),
      ).success,
    ).toBe(false);
  });

  it("label 拒空串、updatedAt 拒负数与小数（时间是 epoch 毫秒整数）", () => {
    expect(v4ConversationWorkflowRunSummarySchema.safeParse(summary({ label: "" })).success).toBe(
      false,
    );
    expect(
      v4ConversationWorkflowRunSummarySchema.safeParse(summary({ updatedAt: -1 })).success,
    ).toBe(false);
    expect(
      v4ConversationWorkflowRunSummarySchema.safeParse(summary({ updatedAt: 1.5 })).success,
    ).toBe(false);
  });

  it("schema 是 strict：未知键仍然拒绝（加字段必须走 schema，不能靠透传）", () => {
    expect(
      v4ConversationWorkflowRunSummarySchema.safeParse(summary({ notAField: 1 })).success,
    ).toBe(false);
  });

  it("结果包裹 runs 数组，最近更新在前由存储层负责", () => {
    const result = {
      runs: [summary({ label: "a", updatedAt: 2 }), summary({ runId: "dwfrun-2" })],
    };
    expect(v4ConversationWorkflowRunsResultSchema.parse(result)).toEqual(result);
  });
});

// ── User-facing artifacts (docs/dynamic-workflow/authoring.md "How the user sees them") ─────────────────
// ⚠ Terminology: the artifact in this section is output a script published to the **user** via `artifact.*`; it has
// nothing to do with `serializeWorkflowArtifact` (the engine's internal name for the "script top-level return value", shown to the model).
describe("workflowRuns[].artifacts 状态键", () => {
  const summary = (overrides: Record<string, unknown> = {}) => ({
    id: "book",
    kind: "file" as const,
    title: "注意力之书",
    version: 2,
    contentType: "application/pdf",
    bytes: 4_194_304,
    itemCount: 0,
    ...overrides,
  });

  it("摘要元素只带最新版元数据：spec / versions / uri / sourcePath 一律拒收", () => {
    expect(workflowRunArtifactSummarySchema.parse(summary())).toEqual(summary());
    // strict: casually stuffing full metadata into this high-frequency state key turns red here first.
    for (const extra of [
      { spec: { x: { field: "round" } } },
      { versions: [{ version: 1, publishedAt: 1 }] },
      { uri: "zcode-artifact://s/a" },
      { sourcePath: "out/book.pdf" },
      { description: "一本书" },
    ]) {
      expect(workflowRunArtifactSummarySchema.safeParse({ ...summary(), ...extra }).success).toBe(
        false,
      );
    }
  });

  it("kind 是六成员闭集；title / contentType / bytes / itemCount 全可缺席", () => {
    for (const kind of ["file", "markdown", "chart", "table", "metrics", "board"]) {
      expect(workflowRunArtifactSummarySchema.parse({ id: "x", kind, version: 1 })).toEqual({
        id: "x",
        kind,
        version: 1,
      });
    }
    expect(
      workflowRunArtifactSummarySchema.safeParse({ id: "x", kind: "spreadsheet", version: 1 })
        .success,
    ).toBe(false);
  });

  it("primary 是可选的字面量 true（交付物；docs/dynamic-workflow/authoring.md「Ids, tags and versions」）", () => {
    expect(workflowRunArtifactSummarySchema.parse(summary({ primary: true }))).toEqual(
      summary({ primary: true }),
    );
    // Not a deliverable = key absent, not false: one convention across the three schemas; the UI only tests `=== true`.
    expect(workflowRunArtifactSummarySchema.safeParse(summary({ primary: false })).success).toBe(
      false,
    );
    expect(workflowRunArtifactSummarySchema.safeParse(summary({ primary: "yes" })).success).toBe(
      false,
    );
  });

  it("artifacts 是 optional（老 CLI 不发这个键的整帧仍可解析——偏斜第三档）", () => {
    // This is the entire reason the field is optional: adding a required field to an existing state key would make the
    // state.updated patch of any old CLI that does not send it lose the whole frame, not just one key.
    const { artifacts: _omitted, ...withoutKey } = { ...run(), artifacts: [summary()] };
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [withoutKey] })).toEqual({
      revision: 1,
      runs: [withoutKey],
    });
    const withKey = { ...run(), artifacts: [summary()] };
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [withKey] })).toEqual({
      revision: 1,
      runs: [withKey],
    });
  });

  it("artifacts 有界 32（= 引擎的 ARTIFACT_CAPS.maxArtifactsPerRun，不另设更低的展示预算）", () => {
    expect(WORKFLOW_RUNS_LIMITS.maxArtifacts).toBe(32);
    const many = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxArtifacts + 1 }, (_value, index) =>
      summary({ id: `a${index}` }),
    );
    expect(
      workflowRunsStateSchema.safeParse({ revision: 1, runs: [{ ...run(), artifacts: many }] })
        .success,
    ).toBe(false);
  });

  it("reports 元素长出可选的 artifactId（打标签的条目仍进 reports——一条通道一套上限）", () => {
    const tagged = {
      ...run(),
      reports: [{ siteId: "report#1", ordinal: 1, preview: "{}", artifactId: "perf" }],
    };
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [tagged] })).toEqual({
      revision: 1,
      runs: [tagged],
    });
    const untagged = { ...run(), reports: [{ siteId: "report#1", ordinal: 1, preview: "{}" }] };
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [untagged] })).toEqual({
      revision: 1,
      runs: [untagged],
    });
  });
});

describe("v4 conversation workflowRunArtifacts query", () => {
  const version = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    title: "注意力之书",
    contentType: "application/pdf",
    bytes: 4_194_304,
    uri: "zcode-artifact://session-1/tool-result-abc",
    sourcePath: "out/book.pdf",
    publishedAt: 1_756_100_000_000,
    ...overrides,
  });

  it("声明一个只读、无状态、超时重发安全的清单 query", () => {
    expect(V4_METHODS.conversationWorkflowRunArtifacts).toBe(
      "v4/conversation/workflowRunArtifacts",
    );
    expect(
      v4ConversationWorkflowRunArtifactsParamsSchema.parse({ sessionId: "s", runId: "r" }),
    ).toEqual({
      sessionId: "s",
      runId: "r",
    });
    expect(
      v4ConversationWorkflowRunArtifactsParamsSchema.safeParse({
        sessionId: "s",
        runId: "r",
        limit: 5,
      }).success,
    ).toBe(false);
  });

  it("元素带全部版本（升序）与 itemCount——这是冷恢复与中枢详情的 durable 读法", () => {
    const artifact = {
      id: "book",
      kind: "file" as const,
      title: "注意力之书",
      description: "59 页",
      contentType: "application/pdf",
      sourcePath: "out/book.pdf",
      version: 2,
      versions: [version(), version({ version: 2, bytes: 5_000_000 })],
      itemCount: 0,
    };
    expect(workflowRunArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: [artifact] })).toEqual(
      { artifacts: [artifact] },
    );
    // strict at both layers: result and element both reject unknown fields.
    expect(
      v4ConversationWorkflowRunArtifactsResultSchema.safeParse({
        artifacts: [artifact],
        hasMore: false,
      }).success,
    ).toBe(false);
  });

  it("primary 在版本项与顶层都可带（引擎按 id 粘着盖章；投影抬到顶层），且只能是 true", () => {
    const artifact = {
      id: "report",
      kind: "markdown" as const,
      version: 2,
      versions: [version({ primary: true }), version({ version: 2, primary: true })],
      itemCount: 0,
      primary: true as const,
    };
    expect(workflowRunArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(workflowRunArtifactSchema.safeParse({ ...artifact, primary: false }).success).toBe(false);
    expect(
      workflowRunArtifactSchema.safeParse({ ...artifact, versions: [version({ primary: false })] })
        .success,
    ).toBe(false);
  });

  it("publishedAt 必填：driver 恒写入，缺席即让「版本没有时刻」在协议边界上就红", () => {
    const { publishedAt: _dropped, ...withoutTime } = version();
    expect(
      workflowRunArtifactSchema.safeParse({
        id: "book",
        kind: "file",
        version: 1,
        versions: [withoutTime],
        itemCount: 0,
      }).success,
    ).toBe(false);
  });

  it("预置看板带 spec、不带字节；版本数与 id 长度按 ARTIFACT_CAPS 有界", () => {
    const board = {
      id: "perf",
      kind: "chart" as const,
      spec: { x: { field: "round" }, y: { field: "queryMs" } },
      version: 1,
      versions: [{ version: 1, spec: { x: { field: "round" } }, publishedAt: 1 }],
      itemCount: 12,
    };
    expect(workflowRunArtifactSchema.parse(board)).toEqual(board);
    expect(WORKFLOW_ARTIFACT_LIMITS.maxVersions).toBe(16);
    expect(
      workflowRunArtifactSchema.safeParse({
        ...board,
        versions: Array.from({ length: 17 }, (_v, index) => ({
          version: index + 1,
          publishedAt: 1,
        })),
      }).success,
    ).toBe(false);
    expect(workflowRunArtifactSchema.safeParse({ ...board, id: "x".repeat(65) }).success).toBe(
      false,
    );
  });
});

describe("v4 conversation workflowRunArtifactData query", () => {
  it("声明看板的取数面：cursor = journal sequence，limit 钳在 500", () => {
    expect(V4_METHODS.conversationWorkflowRunArtifactData).toBe(
      "v4/conversation/workflowRunArtifactData",
    );
    const params = {
      sessionId: "s",
      runId: "r",
      artifactId: "perf",
      afterSequence: 12,
      limit: 200,
    };
    expect(v4ConversationWorkflowRunArtifactDataParamsSchema.parse(params)).toEqual(params);
    expect(
      v4ConversationWorkflowRunArtifactDataParamsSchema.parse({
        sessionId: "s",
        runId: "r",
        artifactId: "perf",
      }),
    ).toEqual({
      sessionId: "s",
      runId: "r",
      artifactId: "perf",
    });
    expect(WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage).toBe(200);
    expect(WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage).toBe(500);
    expect(
      v4ConversationWorkflowRunArtifactDataParamsSchema.safeParse({ ...params, limit: 501 })
        .success,
    ).toBe(false);
    expect(
      v4ConversationWorkflowRunArtifactDataParamsSchema.safeParse({ ...params, limit: 0 }).success,
    ).toBe(false);
  });

  it("条目带**原值**而不是预览文本：看板的纯函数要按字段路径取数", () => {
    // Preview-ification (strings as-is, everything else pretty JSON) is the contract of the Results section's row. A board needs to read
    // spec.x.field paths like "timing.after", which cannot be extracted from a JSON text blob.
    const result = {
      items: [
        { sequence: 12, siteId: "report#1", ordinal: 3, item: { round: 3, timing: { after: 41 } } },
        { sequence: 15, siteId: "report#1", ordinal: 4, item: null },
      ],
      hasMore: true,
    };
    expect(v4ConversationWorkflowRunArtifactDataResultSchema.parse(result)).toEqual(result);
    expect(
      v4ConversationWorkflowRunArtifactDataResultSchema.safeParse({
        items: [],
        hasMore: false,
        nextSequence: 3,
      }).success,
    ).toBe(false);
    expect(
      v4ConversationWorkflowRunArtifactDataResultSchema.safeParse({
        items: [{ sequence: 1, siteId: "report#1", ordinal: 0, item: 1, extra: true }],
        hasMore: false,
      }).success,
    ).toBe(false);
  });
});

describe("v4 conversation workflowRunArtifactRead query", () => {
  it("逐字照 attachmentRead：≤ 512 KiB 一块，复用同一个常量而不另铸", () => {
    expect(V4_METHODS.conversationWorkflowRunArtifactRead).toBe(
      "v4/conversation/workflowRunArtifactRead",
    );
    const params = {
      sessionId: "s",
      runId: "r",
      artifactId: "book",
      version: 1,
      offset: 0,
      limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
    };
    expect(v4ConversationWorkflowRunArtifactReadParamsSchema.parse(params)).toEqual(params);
    expect(
      v4ConversationWorkflowRunArtifactReadParamsSchema.safeParse({
        ...params,
        limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes + 1,
      }).success,
    ).toBe(false);
    // version required and a positive integer: the authorization chain looks up the completed row in the journal by (artifactId, version).
    expect(
      v4ConversationWorkflowRunArtifactReadParamsSchema.safeParse({ ...params, version: 0 })
        .success,
    ).toBe(false);
    const { version: _dropped, ...withoutVersion } = params;
    expect(
      v4ConversationWorkflowRunArtifactReadParamsSchema.safeParse(withoutVersion).success,
    ).toBe(false);
  });

  it("结果按块携带 base64 与总字节；解码超块界、nextOffset 越界都拒收", () => {
    const result = {
      dataBase64: "aGVsbG8=",
      mediaType: "application/pdf",
      totalBytes: 5,
      nextOffset: null,
    };
    expect(v4ConversationWorkflowRunArtifactReadResultSchema.parse(result)).toEqual(result);
    expect(
      v4ConversationWorkflowRunArtifactReadResultSchema.safeParse({
        ...result,
        dataBase64: "not base64!",
      }).success,
    ).toBe(false);
    expect(
      v4ConversationWorkflowRunArtifactReadResultSchema.safeParse({ ...result, nextOffset: 9 })
        .success,
    ).toBe(false);
    expect(
      v4ConversationWorkflowRunArtifactReadResultSchema.safeParse({
        ...result,
        totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
      }).success,
    ).toBe(false);
  });

  it("mediaType **不**限死在 image/video/pdf——限死会让 markdown 与 office 文件整条读不出来", () => {
    // attachmentRead's refine was written for the preview surface of already-sent messages; an artifact's legal types are the driver's
    // 17-entry extension table plus application/octet-stream.
    for (const mediaType of [
      "text/markdown",
      "text/html",
      "text/csv",
      "application/octet-stream",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]) {
      expect(
        v4ConversationWorkflowRunArtifactReadResultSchema.safeParse({
          dataBase64: "aGVsbG8=",
          mediaType,
          totalBytes: 5,
          nextOffset: null,
        }).success,
      ).toBe(true);
    }
  });
});

// ── Phase entry records (docs/dynamic-workflow/presentation.md) ──────────
describe("workflowRuns[].phases / currentPhase 状态键", () => {
  it("phases 与 currentPhase 都是 optional（老 CLI 不发它们的整帧仍可解析）", () => {
    const bare = run();
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [bare] })).toEqual({
      revision: 1,
      runs: [bare],
    });
    const withKeys = { ...run(), phases: [{ name: "plan", rounds: 2 }], currentPhase: "plan" };
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [withKeys] })).toEqual({
      revision: 1,
      runs: [withKeys],
    });
  });

  it("名字非空且 ≤ 128；rounds 是正整数；条数 ≤ 32", () => {
    const ok = { name: "x".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength), rounds: 1 };
    expect(workflowRunPhaseSchema.parse(ok)).toEqual(ok);
    expect(workflowRunPhaseSchema.safeParse({ name: "", rounds: 1 }).success).toBe(false);
    expect(workflowRunPhaseSchema.safeParse({ name: "x".repeat(129), rounds: 1 }).success).toBe(
      false,
    );
    expect(workflowRunPhaseSchema.safeParse({ name: "x", rounds: 0 }).success).toBe(false);
    const tooMany = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxPhases + 1 }, (_, i) => ({
      name: `p${i}`,
      rounds: 1,
    }));
    expect(
      workflowRunsStateSchema.safeParse({ revision: 1, runs: [{ ...run(), phases: tooMany }] })
        .success,
    ).toBe(false);
  });
});

// ── Birth-phase coordinates of instances (docs/dynamic-workflow/presentation.md) ──────
describe("workflowRuns[].actors/nodes 的 phaseName 状态键", () => {
  it("actor 与 node 上都是 optional（不发它的旧 CLI 整帧仍可解析）", () => {
    const bare = run();
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [bare] })).toEqual({
      revision: 1,
      runs: [bare],
    });
    const stamped = {
      ...run(),
      actors: [{ ...run().actors[0], phaseName: "调查" }],
      nodes: [{ ...run().nodes[0], phaseName: "调查" }],
    };
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [stamped] })).toEqual({
      revision: 1,
      runs: [stamped],
    });
  });

  it("名字非空且 ≤ 128：与 phases[].name 同一条界（UI 按名字关联两边）", () => {
    const limit = WORKFLOW_RUNS_LIMITS.maxPhaseNameLength;
    const actor = { siteId: "actor#1", ordinal: 1, status: "running" as const };
    const node = { siteId: "ask#1", ordinal: 1, phase: "settled" as const };
    expect(
      workflowRunActorSchema.safeParse({ ...actor, phaseName: "x".repeat(limit) }).success,
    ).toBe(true);
    expect(
      workflowRunActorSchema.safeParse({ ...actor, phaseName: "x".repeat(limit + 1) }).success,
    ).toBe(false);
    expect(workflowRunActorSchema.safeParse({ ...actor, phaseName: "" }).success).toBe(false);
    expect(
      workflowRunNodeSchema.safeParse({ ...node, phaseName: "x".repeat(limit) }).success,
    ).toBe(true);
    expect(
      workflowRunNodeSchema.safeParse({ ...node, phaseName: "x".repeat(limit + 1) }).success,
    ).toBe(false);
    expect(workflowRunNodeSchema.safeParse({ ...node, phaseName: "" }).success).toBe(false);
  });

  it("phaseName 与节点生命周期 phase 是两个键，可以同时在场", () => {
    const parsed = workflowRunNodeSchema.parse({
      siteId: "ask#1",
      ordinal: 37,
      phase: "settled",
      phaseName: "第三阶段",
    });
    expect(parsed.phase).toBe("settled");
    expect(parsed.phaseName).toBe("第三阶段");
  });
});

// ── One ask's task and progress readings (docs/dynamic-workflow/presentation.md) ──────
describe("workflowRuns[].nodes 的 instructionsHead / turn / toolCalls / lastTool", () => {
  const node = { siteId: "ask#1", ordinal: 1, phase: "executing" as const };

  it("四个键都是 optional：不发它们的旧 CLI 整帧仍可解析，原样回出", () => {
    const bare = run();
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [bare] })).toEqual({
      revision: 1,
      runs: [bare],
    });
    const reported = {
      ...run(),
      nodes: [
        {
          ...node,
          kind: "ask" as const,
          instructionsHead: "读一遍 docs/dynamic-workflow 并列出过时的段落",
          turn: 3,
          toolCalls: 12,
          lastTool: { name: "Read", target: "docs/dynamic-workflow/presentation.md" },
        },
      ],
    };
    expect(workflowRunsStateSchema.parse({ revision: 1, runs: [reported] })).toEqual({
      revision: 1,
      runs: [reported],
    });
  });

  it("instructionsHead 非空且 ≤ 240（与引擎侧 INSTRUCTIONS_HEAD_MAX_CHARS 同值）", () => {
    const limit = WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength;
    expect(limit).toBe(240);
    expect(
      workflowRunNodeSchema.safeParse({ ...node, instructionsHead: "x".repeat(limit) }).success,
    ).toBe(true);
    expect(
      workflowRunNodeSchema.safeParse({ ...node, instructionsHead: "x".repeat(limit + 1) }).success,
    ).toBe(false);
    expect(workflowRunNodeSchema.safeParse({ ...node, instructionsHead: "" }).success).toBe(false);
  });

  it("turn 是正整数、toolCalls 是非负整数：0 轮次不存在，0 次工具调用是事实", () => {
    expect(workflowRunNodeSchema.safeParse({ ...node, turn: 1, toolCalls: 0 }).success).toBe(true);
    expect(workflowRunNodeSchema.safeParse({ ...node, turn: 0 }).success).toBe(false);
    expect(workflowRunNodeSchema.safeParse({ ...node, turn: 1.5 }).success).toBe(false);
    expect(workflowRunNodeSchema.safeParse({ ...node, toolCalls: -1 }).success).toBe(false);
    expect(workflowRunNodeSchema.safeParse({ ...node, toolCalls: 2.5 }).success).toBe(false);
  });

  it("lastTool：工具名必填 ≤ 64，target 可缺席 ≤ 120（放得下路径或命令头，放不下参数全文）", () => {
    const names = WORKFLOW_RUNS_LIMITS.maxLastToolNameLength;
    const targets = WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength;
    expect([names, targets]).toEqual([64, 120]);
    expect(workflowRunNodeLastToolSchema.parse({ name: "Bash" })).toEqual({ name: "Bash" });
    expect(
      workflowRunNodeLastToolSchema.safeParse({
        name: "x".repeat(names),
        target: "y".repeat(targets),
      }).success,
    ).toBe(true);
    expect(workflowRunNodeLastToolSchema.safeParse({ name: "x".repeat(names + 1) }).success).toBe(
      false,
    );
    expect(
      workflowRunNodeLastToolSchema.safeParse({ name: "Bash", target: "y".repeat(targets + 1) })
        .success,
    ).toBe(false);
    expect(workflowRunNodeLastToolSchema.safeParse({ name: "" }).success).toBe(false);
    expect(workflowRunNodeLastToolSchema.safeParse({ target: "a.ts" }).success).toBe(false);
  });

  it("生命周期 phase 与这些读数可以同时在场：settled 的节点也留着它跑完时的读数", () => {
    const parsed = workflowRunNodeSchema.parse({
      siteId: "ask#1",
      ordinal: 4,
      phase: "settled",
      outcome: "ok",
      instructionsHead: "写一份回归测试",
      turn: 6,
      toolCalls: 21,
      lastTool: { name: "Edit", target: "packages/shared/test/x.test.ts" },
    });
    expect(parsed.phase).toBe("settled");
    expect(parsed.turn).toBe(6);
  });
});
