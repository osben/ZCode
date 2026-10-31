import { describe, expect, it } from "vitest";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import { FACADE_DTS } from "@zcode/dynamic-workflow";
import { AMEND_WORKFLOW_TOOL_DESCRIPTION } from "../src/tool/handlers/amend-workflow-description.js";
import { CREATE_WORKFLOW_TOOL_DESCRIPTION } from "../src/tool/handlers/create-workflow-description.js";
import { EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION } from "../src/tool/handlers/eval-workflow-snippet-description.js";
import { SAVE_WORKFLOW_TOOL_DESCRIPTION } from "../src/tool/handlers/save-workflow-description.js";
import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { createToolRegistry } from "../src/tool/registry.js";

// 2026-09-21 (docs/dynamic-workflow/authoring.md "The authoring surface"): the four authoring tools'
// descriptions were shortened to a few hundred tokens, and the facade and writing rules moved into the
// dynamic-workflows skill, guaranteed to have been read by the skill gate on resolveInput. The descriptions
// keep only three standing things — what it is, when (not) to use it, and to read the skill first. The
// assertions here are keyword-based, not verbatim: the wording may be polished, the routing signals must not
// be lost, and the size must not grow back.
const DESCRIPTIONS = {
  AmendWorkflow: AMEND_WORKFLOW_TOOL_DESCRIPTION,
  CreateWorkflow: CREATE_WORKFLOW_TOOL_DESCRIPTION,
  EvalWorkflowSnippet: EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION,
  SaveWorkflow: SAVE_WORKFLOW_TOOL_DESCRIPTION,
} as const;

/** Size cap for the standing descriptions (characters). CreateWorkflow alone used to be 34k characters; the four together must now stay within this. */
const MAX_DESCRIPTION_CHARS = 2_200;

describe("authoring tool descriptions stay short and point at the skill", () => {
  for (const [name, description] of Object.entries(DESCRIPTIONS)) {
    it(`${name}: no facade, no rule book, a skill pointer, under budget`, () => {
      expect(description.length).toBeLessThan(MAX_DESCRIPTION_CHARS);
      // The facade's ambient declarations and the writing-rules list are no longer resent with every request.
      expect(description).not.toContain("declare ");
      expect(description).not.toContain("Authoring rules");
      expect(description).not.toContain("noUncheckedIndexedAccess");
      // Each one names the skill and the Skill tool, and states that the gate refuses.
      expect(description).toContain(`\`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill`);
      expect(description).toContain("Skill tool");
      expect(description).toContain("refused until");
    });
  }
});

// Desktop observation: even when the user explicitly said "workflow", the model still called Agent. The root
// cause was a combination of descriptive lies — CreateWorkflow described itself as
// "placeholder / does NOT run anything" (never updated after the engine was wired up), while Agent advertised
// itself for "complex, multi-step tasks", so the model's rational choice was Agent.
describe("CreateWorkflow tool description", () => {
  it("不再自称 placeholder / 不执行", () => {
    const lowered = CREATE_WORKFLOW_TOOL_DESCRIPTION.toLowerCase();
    expect(lowered).not.toContain("placeholder");
    expect(lowered).not.toContain("does not run");
    expect(lowered).not.toContain("not executed");
  });

  it("描述真实执行路径：typecheck → 确认 → 后台 run → 通知", () => {
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("typechecked");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("confirm");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("background");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("notified");
  });

  it("给出 when-to-use，并把「点名即绑定」写进去", () => {
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("When to use");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("in any language");
    // Simple delegation still belongs to Agent — the other half of the shape nudge, preventing over-triggering.
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("Agent");
  });

  it("点名即绑定是强制的：列出「use a workflow / in any language」这类措辞，并禁止以「太小」为由改道", () => {
    // Addendum in docs/dynamic-workflow/launch.md "Run introspection tools" (2026-09-07): the original wording
    // only said "use this tool", and the model would still judge a small task as not worth a workflow and
    // switch to Agent or do it directly. Three signals are pinned here: mandatory tone, wording users would
    // actually say, and "size only decides the scale, not whether".
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("mandatory");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("use a workflow");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("in any language");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("too small");
  });

  // User ruling of 2026-09-16: workflows may only be started by `/workflow` or an explicit request; the model must not decide on its own to start one.
  it("只按点名路由：没有编排场景那一条，有明确的否定规则和替代动作", () => {
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).not.toContain("Multi-subagent orchestration");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).not.toContain("deterministic control flow");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain(
      "Without such an explicit request, do not start a workflow",
    );
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain(
      "delegate with the Agent tool or do the work yourself",
    );
  });

  // The routing rules stay in the description, not in the skill: they decide "whether to call this tool at
  // all" and must be readable before the skill loads. The three sources and the "edit the file and pass back
  // the path" loop also get a sentence — that is the repasted-script cost this feature exists to eliminate
  // (docs/dynamic-workflow/launch.md "Script files"), which cannot wait until after the skill loads.
  it("留下三条来源、path 回路与 AmendWorkflow 的指路，说明 saved 免技能", () => {
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("exactly one source");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("`saved`");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("resubmit with `path`");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("never paste the script again");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("call AmendWorkflow instead");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain(
      "running a saved workflow by name is exempt",
    );
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).not.toContain("resume_from");
  });
});

// docs/dynamic-workflow/launch.md "What the model is told": the amendment routing (fix, extend, change
// mid-run, settings-only, and recovery goes to Resume) stays in the description; caching, tri-state fields,
// script_unchanged, and confirmation rules live in the skill.
describe("AmendWorkflow tool description", () => {
  it("说清何时修订而不是重建、不要先停不要等、只改设定不带脚本、恢复归 ResumeWorkflowRun", () => {
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("supersedes the old one");
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain(
      "Never rewrite the workflow from scratch with CreateWorkflow",
    );
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("Do not TaskStop it first");
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("neither `path` nor `script`");
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("ResumeWorkflowRun");
    // The gate's boundary is written in the description: only script-carrying amendments need the skill.
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("a settings-only call is not");
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).not.toContain("in flight starts again");
  });

  // Ring 4 (docs/design/v2/tool/00-tool-change-chain.md): the provider-visible copy must really be projected
  // through ToolRegistry.toContracts(), otherwise the model never sees a changed description.
  it("经 ToolRegistry.toContracts() 投影给模型", () => {
    const registry = createToolRegistry();
    registry.register(amendWorkflowToolEntry);
    const contract = registry.toContracts().find((entry) => entry.name === "AmendWorkflow");
    expect(contract?.description).toContain("Do not TaskStop it first");
    expect(contract?.description).toContain(`\`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill`);
  });
});

// docs/dynamic-workflow/launch.md "`SaveWorkflow`": the one rule that must be seen before deciding whether to
// call it — never save unsolicited — stays in the description.
describe("SaveWorkflow tool description", () => {
  it("常驻「绝不主动保存」，并点名 script_path 是不重吐脚本的那条路", () => {
    expect(SAVE_WORKFLOW_TOOL_DESCRIPTION).toContain("NEVER call this tool unsolicited");
    expect(SAVE_WORKFLOW_TOOL_DESCRIPTION).toContain("suggest saving it in one sentence and wait");
    expect(SAVE_WORKFLOW_TOOL_DESCRIPTION).toContain("`script_path`");
  });
});

describe("facade prose", () => {
  it("不再把 declare 措辞写成作者指引", () => {
    // The facade prose once said "an interface declared in this script", which together with the ambient
    // `declare` items above formed an even stronger pull than the old RULES wording. The prose may change; the
    // keywords must not.
    expect(FACADE_DTS).not.toContain("declared in");
    expect(FACADE_DTS).toContain("an interface you define in");
    expect(FACADE_DTS).toContain('no "declare" modifier');
  });

  it("ambient declare 关键字仍然完整（编译器要的真 d.ts）", () => {
    // The prose rewrite must not touch keywords: they are the precondition for the facade to be fed into the
    // virtual host as a .d.ts by createWorkflowProgram; missing one is a compile-time API gap.
    //
    // The expected count is **derived** from the list below, not a magic number. The previously hard-coded 8
    // would become a mandatory synchronized edit every time a new primitive was added, while what it actually
    // guards against is "the prose rewrite losing some declare" — the derived count guards against that just
    // as well, plus one more thing: a new declaration missing from the list is also caught.
    const declarations = [
      "declare interface Node<T>",
      "declare interface AgentPersona",
      "declare interface Agent",
      "declare function agent(",
      "declare const args",
      // docs/dynamic-workflow/authoring.md "The run's identity": run identity, a facade value like args.
      "declare const run",
      "declare function log(",
      "declare function report(",
      // docs/dynamic-workflow/authoring.md "Declaring a dashboard": content members + the specs of the four preset boards.
      "declare interface ArtifactRef",
      "declare interface ArtifactOptions",
      "declare interface ArtifactFileOptions",
      "declare interface ArtifactField",
      "declare interface ChartSpec",
      "declare interface TableSpec",
      "declare interface MetricsSpec",
      "declare interface BoardSpec",
      "declare const artifact",
      "declare function phase(",
      "declare interface GrepMatch",
      "declare const files",
      "declare interface GitStatus",
      "declare interface GitCommit",
      "declare const git",
      "declare interface WorldRunResult",
      "declare const world",
      // docs/dynamic-workflow/authoring.md "Streams: `channel` and `future`": the facade/dts-stream.ts section.
      "declare interface Channel<T>",
      "declare function channel<T>(",
      "declare function future<T>(",
      // docs/dynamic-workflow/authoring.md "Choosing a model per subagent": the facade/dts-model.ts section.
      "declare class ModelRef",
      "declare function model(",
      // docs/dynamic-workflow/authoring.md "Holes: `hole<T>()`": the three overloads (prompt / body / both).
      "declare function hole<T>(name: string, prompt?: string): Promise<T>;",
      "declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;",
      "declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;",
    ];
    const keywords = FACADE_DTS.match(/^declare /gm) ?? [];
    expect(keywords).toHaveLength(declarations.length);
    for (const decl of declarations) {
      expect(FACADE_DTS).toContain(decl);
    }
  });
});

describe("Agent tool description", () => {
  it("在 When to use 里交叉指向 CreateWorkflow", () => {
    const description = agentToolEntry.metadata.description ?? "";
    expect(description).toContain("When to use");
    expect(description).toContain("in any language");
    expect(description).toContain("CreateWorkflow");
    // The reverse pointer is mandatory in tone too: Agent must not accept a request naming a workflow on the grounds that the task is small.
    expect(description).toContain("mandatory");
    expect(description).toContain("use a workflow");
  });
});

// This file previously also asserted that the task-behavior system-prompt section carried the same routing
// rules. Upstream 4eea9c1d00 (align provider-visible prompt content) deleted the locally authored
// task-behavior / communication-style / risk-actions sections wholesale and asserts the reverse in
// context-builder.test.ts with `not.toContain("# Task Behavior")` — that destination no longer exists and
// rebuilding it is not allowed. The routing signals are now carried only by the two tool descriptions above
// (CreateWorkflow's own description + Agent's reverse pointer), both asserted in this file.
