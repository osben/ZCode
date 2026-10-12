// Protocol schema for saved workflows (docs/dynamic-workflow/launch.md "Data path" +
// docs/dynamic-workflow/launch.md "Data path").
import { describe, expect, it } from "vitest";
import {
  ZCODE_WORKFLOWS_RUNS_MAX_LIMIT,
  zcodeProtocolMethods,
  zcodeSavedWorkflowMetaSchema,
  zcodeSavedWorkflowScopeSchema,
  zcodeWorkflowsDeleteParamsSchema,
  zcodeWorkflowsDeleteResultSchema,
  zcodeWorkflowsGetParamsSchema,
  zcodeWorkflowsGetResultSchema,
  zcodeWorkflowsListParamsSchema,
  zcodeWorkflowsListResultSchema,
  zcodeWorkflowsMoveParamsSchema,
  zcodeWorkflowsMoveResultSchema,
  zcodeWorkflowsRunsParamsSchema,
  zcodeWorkflowsRunsResultSchema,
  zcodeWorkflowsUpdateMetaParamsSchema,
  zcodeWorkflowsUpdateMetaResultSchema,
  ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES,
  zcodeWorkflowsForRunParamsSchema,
  zcodeWorkflowsForRunResultSchema,
  zcodeWorkflowsSaveParamsSchema,
  zcodeWorkflowsSaveResultSchema,
} from "../src/zcode-protocol/index.js";

// The workspace ref must carry workspaceKey (the services layer fills it in via resolveWorkspaceKey; the protocol layer does not guess).
const workspace = { workspacePath: "/repo", workspaceKey: "/repo" };

describe("zcode-protocol saved workflows", () => {
  it("方法名固定，都是 workspace 级、无 session 的方法", () => {
    expect(zcodeProtocolMethods.workflowsList).toBe("workflows/list");
    expect(zcodeProtocolMethods.workflowsGet).toBe("workflows/get");
    expect(zcodeProtocolMethods.workflowsUpdateMeta).toBe("workflows/updateMeta");
    expect(zcodeProtocolMethods.workflowsDelete).toBe("workflows/delete");
    expect(zcodeProtocolMethods.workflowsRuns).toBe("workflows/runs");
    expect(zcodeProtocolMethods.workflowsMove).toBe("workflows/move");
  });

  it("scope 枚举两档：project / global，拒绝别的值", () => {
    expect(zcodeSavedWorkflowScopeSchema.parse("project")).toBe("project");
    expect(zcodeSavedWorkflowScopeSchema.parse("global")).toBe("global");
    // The skills / subagents tier is called user; this feature intentionally diverges — user is not accepted.
    expect(() => zcodeSavedWorkflowScopeSchema.parse("user")).toThrow();
  });

  it("list：结果里的条目不含脚本正文，坏文件单列 invalid，dir 必填", () => {
    expect(zcodeWorkflowsListParamsSchema.parse({ workspace })).toEqual({ workspace });
    // scope is optional: global is accepted, unknown values are rejected.
    expect(zcodeWorkflowsListParamsSchema.parse({ workspace, scope: "global" }).scope).toBe(
      "global",
    );
    expect(() => zcodeWorkflowsListParamsSchema.parse({ workspace, scope: "user" })).toThrow();
    const result = zcodeWorkflowsListResultSchema.parse({
      workflows: [
        {
          name: "x",
          description: "d",
          scope: "global",
          path: "/home/me/.zcode/workflows/x.dwf.ts",
          args: { branch: { type: "string", required: true } },
        },
      ],
      invalid: [{ path: "/repo/.zcode/workflows/bad.dwf.ts", reason: "invalid_yaml" }],
      dir: "/home/me/.zcode/workflows",
    });
    expect(result.workflows[0]?.args?.branch?.required).toBe(true);
    expect(result.dir).toBe("/home/me/.zcode/workflows");
    // Reject when dir is missing (the GUI's file watching has nowhere to watch without it).
    expect(() =>
      zcodeWorkflowsListResultSchema.parse({
        workflows: [],
        invalid: [],
      }),
    ).toThrow();
    // Entries that mix in script content are still rejected.
    expect(() =>
      zcodeWorkflowsListResultSchema.parse({
        workflows: [{ name: "x", description: "d", scope: "project", path: "/p", script: "…" }],
        invalid: [],
        dir: "/repo/.zcode/workflows",
      }),
    ).toThrow();
  });

  it("get：scope 可选；ok 分支带 meta + script；失败分支 reason 四态可分辨", () => {
    expect(zcodeWorkflowsGetParamsSchema.parse({ workspace, name: "x" })).toEqual({
      workspace,
      name: "x",
    });
    expect(
      zcodeWorkflowsGetParamsSchema.parse({ workspace, name: "x", scope: "global" }).scope,
    ).toBe("global");
    expect(() =>
      zcodeWorkflowsGetParamsSchema.parse({ workspace, name: "x", scope: "user" }),
    ).toThrow();
    const ok = zcodeWorkflowsGetResultSchema.parse({
      ok: true,
      name: "x",
      path: "/p",
      scope: "global",
      meta: { description: "d", whenToUse: "w" },
      script: "export default async () => {}",
    });
    expect(ok.ok).toBe(true);
    for (const reason of ["invalid_name", "not_found", "parse_error", "read_error"]) {
      expect(zcodeWorkflowsGetResultSchema.parse({ ok: false, reason })).toEqual({
        ok: false,
        reason,
      });
    }
    expect(() => zcodeWorkflowsGetResultSchema.parse({ ok: false, reason: "boom" })).toThrow();
  });

  it("updateMeta：scope 可选；meta 复用 contracts 的 meta schema，strict 拒未知键", () => {
    const meta = { description: "d", args: { n: { type: "number", default: 3 } } };
    expect(zcodeWorkflowsUpdateMetaParamsSchema.parse({ workspace, name: "x", meta })).toEqual({
      workspace,
      name: "x",
      meta,
    });
    expect(
      zcodeWorkflowsUpdateMetaParamsSchema.parse({ workspace, name: "x", meta, scope: "global" })
        .scope,
    ).toBe("global");
    expect(() => zcodeSavedWorkflowMetaSchema.parse({ description: "" })).toThrow();
    expect(() => zcodeSavedWorkflowMetaSchema.parse({ description: "d", script: "x" })).toThrow();
    expect(() =>
      zcodeWorkflowsUpdateMetaParamsSchema.parse({ workspace, name: "x", meta, script: "x" }),
    ).toThrow();
    expect(zcodeWorkflowsUpdateMetaResultSchema.parse({ ok: true, path: "/p" })).toEqual({
      ok: true,
      path: "/p",
    });
  });

  it("delete：scope 可选；params 只有 workspace + name (+ scope)；结果 ok/failure 二态", () => {
    expect(zcodeWorkflowsDeleteParamsSchema.parse({ workspace, name: "x" })).toEqual({
      workspace,
      name: "x",
    });
    expect(
      zcodeWorkflowsDeleteParamsSchema.parse({ workspace, name: "x", scope: "global" }).scope,
    ).toBe("global");
    expect(() => zcodeWorkflowsDeleteParamsSchema.parse({ workspace, name: "" })).toThrow();
    expect(zcodeWorkflowsDeleteResultSchema.parse({ ok: false, reason: "not_found" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("runs：scope 可选；limit 1..50、name 可选；行带归属字段 / cwd / args；truncated 只能是 true", () => {
    expect(zcodeWorkflowsRunsParamsSchema.parse({ workspace, limit: 1 })).toEqual({
      workspace,
      limit: 1,
    });
    expect(
      zcodeWorkflowsRunsParamsSchema.parse({ workspace, limit: 1, scope: "global" }).scope,
    ).toBe("global");
    expect(() =>
      zcodeWorkflowsRunsParamsSchema.parse({ workspace, limit: 1, scope: "user" }),
    ).toThrow();
    expect(
      zcodeWorkflowsRunsParamsSchema.parse({
        workspace,
        name: "x",
        limit: ZCODE_WORKFLOWS_RUNS_MAX_LIMIT,
      }).name,
    ).toBe("x");
    expect(() => zcodeWorkflowsRunsParamsSchema.parse({ workspace, limit: 0 })).toThrow();
    expect(() =>
      zcodeWorkflowsRunsParamsSchema.parse({
        workspace,
        limit: ZCODE_WORKFLOWS_RUNS_MAX_LIMIT + 1,
      }),
    ).toThrow();
    expect(() => zcodeWorkflowsRunsParamsSchema.parse({ workspace, limit: 1.5 })).toThrow();
    const result = zcodeWorkflowsRunsResultSchema.parse({
      runs: [
        {
          runId: "r1",
          name: "x",
          status: "running",
          createdAt: 1,
          updatedAt: 2,
          spentTokens: 0,
          parentSessionId: "s1",
          toolCallId: "t1",
          args: { branch: "main" },
          cwd: "/repo/one",
        },
        { runId: "r2", status: "errored", createdAt: 1, updatedAt: 2, spentTokens: 10 },
      ],
      truncated: true,
    });
    expect(result.runs).toHaveLength(2);
    // Rows of the global variant carry cwd (the GUI uses it to label the project); old rows / the project variant may omit it.
    expect(result.runs[0]?.cwd).toBe("/repo/one");
    expect(result.runs[1]).not.toHaveProperty("cwd");
    expect(result.truncated).toBe(true);
    expect(() => zcodeWorkflowsRunsResultSchema.parse({ runs: [], truncated: false })).toThrow();
    expect(zcodeWorkflowsRunsResultSchema.parse({ runs: [] })).toEqual({ runs: [] });
  });

  // Central summary of the user-facing artifacts (docs/dynamic-workflow/authoring.md "How the user sees them").
  // optional, following the precedent of `cwd`: older CLIs do not send this key; a missing key is degradation, not an error.
  it("runs：行的 artifacts 可选、≤ 8 件、只认六个 kind，老行缺席仍可解析", () => {
    const withArtifacts = zcodeWorkflowsRunsResultSchema.parse({
      runs: [
        {
          runId: "r1",
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
          spentTokens: 0,
          artifacts: [
            { id: "report", kind: "file", title: "审计报告", version: 2, contentType: "application/pdf" },
            // Preset boards have no contentType; title may also be missing (the facade's default title is the id).
            { id: "perf", kind: "chart", version: 1 },
          ],
        },
        // Old CLI / runs without artifacts: the whole field is absent, not an empty array.
        { runId: "r2", status: "errored", createdAt: 1, updatedAt: 2, spentTokens: 10 },
      ],
    });
    expect(withArtifacts.runs[0]?.artifacts).toHaveLength(2);
    expect(withArtifacts.runs[0]?.artifacts?.[0]?.kind).toBe("file");
    expect(withArtifacts.runs[0]?.artifacts?.[1]).not.toHaveProperty("contentType");
    expect(withArtifacts.runs[1]).not.toHaveProperty("artifacts");

    const row = (artifacts: unknown) => ({
      runs: [{ runId: "r1", status: "completed", createdAt: 1, updatedAt: 2, spentTokens: 0, artifacts }],
    });
    // Upper bound of 8: how many chips fit on one row, same value as the notification payload.
    const nine = Array.from({ length: 9 }, (_, index) => ({
      id: `a${index}`,
      kind: "markdown" as const,
      version: 1,
    }));
    expect(() => zcodeWorkflowsRunsResultSchema.parse(row(nine))).toThrow();
    expect(zcodeWorkflowsRunsResultSchema.parse(row(nine.slice(0, 8))).runs[0]?.artifacts).toHaveLength(8);
    // Reject both unknown kinds and unknown keys (elements are strict): the GUI draws icons by kind and has no fallback icon.
    expect(() => zcodeWorkflowsRunsResultSchema.parse(row([{ id: "a", kind: "video", version: 1 }]))).toThrow();
    expect(() =>
      zcodeWorkflowsRunsResultSchema.parse(row([{ id: "a", kind: "file", version: 1, bytes: 12 }])),
    ).toThrow();
    // id must be non-empty, version is required.
    expect(() => zcodeWorkflowsRunsResultSchema.parse(row([{ id: "", kind: "file", version: 1 }]))).toThrow();
    expect(() => zcodeWorkflowsRunsResultSchema.parse(row([{ id: "a", kind: "file" }]))).toThrow();
  });

  it("move：params 只有 workspace/name（无 to，全局→项目单向）；结果 ok 分支带 from/to，失败分支 reason 五态", () => {
    expect(zcodeWorkflowsMoveParamsSchema.parse({ workspace, name: "x" })).toEqual({
      workspace,
      name: "x",
    });
    // Addendum 2026-09-04: project→global became a model summary instead, and the `to` parameter was removed; including it is rejected as strict.
    expect(() =>
      zcodeWorkflowsMoveParamsSchema.parse({ workspace, name: "x", to: "global" }),
    ).toThrow();
    expect(() =>
      zcodeWorkflowsMoveParamsSchema.parse({ workspace, name: "x", to: "project" }),
    ).toThrow();

    const ok = zcodeWorkflowsMoveResultSchema.parse({
      ok: true,
      from: "/home/me/.zcode/workflows/x.dwf.ts",
      to: "/repo/.zcode/workflows/x.dwf.ts",
    });
    expect(ok).toEqual({
      ok: true,
      from: "/home/me/.zcode/workflows/x.dwf.ts",
      to: "/repo/.zcode/workflows/x.dwf.ts",
    });
    for (const reason of [
      "invalid_name",
      "not_found",
      "target_exists",
      "read_error",
      "write_error",
    ]) {
      expect(
        zcodeWorkflowsMoveResultSchema.parse({ ok: false, reason, path: "/p", detail: "why" }),
      ).toEqual({ ok: false, reason, path: "/p", detail: "why" });
    }
    // path / detail may be missing; unknown reasons are rejected.
    expect(zcodeWorkflowsMoveResultSchema.parse({ ok: false, reason: "target_exists" })).toEqual({
      ok: false,
      reason: "target_exists",
    });
    expect(() => zcodeWorkflowsMoveResultSchema.parse({ ok: false, reason: "boom" })).toThrow();
    // The ok branch is rejected when from/to are missing; an extra legacy scope is also rejected (strict).
    expect(() => zcodeWorkflowsMoveResultSchema.parse({ ok: true, from: "/a" })).toThrow();
    expect(() =>
      zcodeWorkflowsMoveResultSchema.parse({ ok: true, from: "/a", to: "/b", scope: "project" }),
    ).toThrow();
  });
});

// The two methods of the completion card (docs/dynamic-workflow/transcript-and-notifications.md "Saving the run, and
// running it again").
describe("zcode-protocol saving a run", () => {
  it("方法名固定", () => {
    expect(zcodeProtocolMethods.workflowsSave).toBe("workflows/save");
    expect(zcodeProtocolMethods.workflowsForRun).toBe("workflows/forRun");
  });

  it("save 入参：runId 取代脚本（不收 script），workspace 必带，scope / overwrite 可缺；strict", () => {
    const params = { workspace, runId: "run-1", name: "pr-review", meta: { description: "d" } };
    expect(zcodeWorkflowsSaveParamsSchema.parse(params)).toEqual(params);
    expect(
      zcodeWorkflowsSaveParamsSchema.parse({ ...params, scope: "global", overwrite: true }),
    ).toMatchObject({ scope: "global", overwrite: true });
    expect(() => zcodeWorkflowsSaveParamsSchema.parse({ ...params, script: "x" })).toThrow();
    const { workspace: _dropped, ...withoutWorkspace } = params;
    expect(() => zcodeWorkflowsSaveParamsSchema.parse(withoutWorkspace)).toThrow();
    expect(() => zcodeWorkflowsSaveParamsSchema.parse({ ...params, runId: "" })).toThrow();
  });

  it("save 结果：ok 分支带 overwritten 与可选的遮蔽方向；拒绝词表封闭", () => {
    expect(
      zcodeWorkflowsSaveResultSchema.parse({
        ok: true,
        name: "x",
        scope: "project",
        path: "/p",
        overwritten: false,
        shadowing: "hides_global",
      }),
    ).toMatchObject({ shadowing: "hides_global" });
    for (const reason of [
      "invalid_name",
      "run_not_found",
      "script_missing",
      "target_exists",
      "compile_failed",
      "write_error",
    ]) {
      expect(zcodeWorkflowsSaveResultSchema.parse({ ok: false, reason })).toEqual({
        ok: false,
        reason,
      });
    }
    expect(() => zcodeWorkflowsSaveResultSchema.parse({ ok: false, reason: "boom" })).toThrow();
  });

  it("forRun：候选有上界；结果三个字段全可缺（全缺即「没保存、也不知道实参」）", () => {
    const candidates = Array.from({ length: ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES }, (_, i) => ({
      name: `w${i}`,
    }));
    expect(
      zcodeWorkflowsForRunParamsSchema.parse({ workspace, runId: "r", candidates }).candidates,
    ).toHaveLength(ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES);
    expect(() =>
      zcodeWorkflowsForRunParamsSchema.parse({
        workspace,
        runId: "r",
        candidates: [...candidates, { name: "one-too-many" }],
      }),
    ).toThrow();
    expect(zcodeWorkflowsForRunResultSchema.parse({})).toEqual({});
    expect(
      zcodeWorkflowsForRunResultSchema.parse({
        entry: { name: "x", description: "d", scope: "project", path: "/p" },
        match: "script",
        runArgs: { base: "main" },
      }),
    ).toMatchObject({ match: "script", runArgs: { base: "main" } });
    expect(() => zcodeWorkflowsForRunResultSchema.parse({ match: "guess" })).toThrow();
  });
});
