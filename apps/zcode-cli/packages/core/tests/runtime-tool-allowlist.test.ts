import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  ESCALATE_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
} from "@zcode/contracts";
import { createSessionId } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "../src/subagent/explore-tools.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDisallowedTools,
} from "../src/runtime/helpers/tool-allowlist.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";

function config(patch: Partial<AgentRuntimeConfig>): AgentRuntimeConfig {
  return patch as AgentRuntimeConfig;
}

describe("resolveBuiltInToolAllowlist", () => {
  it("keeps RespondToCoordinator after the Explore child intersection", () => {
    expect(
      resolveBuiltInToolAllowlist(
        config({
          taskType: "subagent_child",
          toolset: "explore",
          toolAllowlist: [...EXPLORE_AGENT_ALLOWED_TOOLS, RESPOND_TO_COORDINATOR_TOOL_NAME],
        }),
      ),
    ).toContain(RESPOND_TO_COORDINATOR_TOOL_NAME);
  });

  it("does not add RespondToCoordinator to a main Explore runtime", () => {
    expect(
      resolveBuiltInToolAllowlist(
        config({
          toolset: "explore",
          toolAllowlist: [...EXPLORE_AGENT_ALLOWED_TOOLS, RESPOND_TO_COORDINATOR_TOOL_NAME],
        }),
      ),
    ).not.toContain(RESPOND_TO_COORDINATOR_TOOL_NAME);
  });

  it("adds RespondToCoordinator to a custom child allowlist", () => {
    expect(
      resolveBuiltInToolAllowlist(
        config({
          taskType: "subagent_child",
          toolset: "main",
          toolAllowlist: ["Read"],
        }),
      ),
    ).toEqual(["Read", RESPOND_TO_COORDINATOR_TOOL_NAME]);
  });

  it("keeps an unrestricted general child allowlist unrestricted", () => {
    expect(
      resolveBuiltInToolAllowlist(config({ taskType: "subagent_child", toolset: "main" })),
    ).toBeUndefined();
  });

  it("keeps an unrestricted workflow child allowlist unrestricted", () => {
    expect(
      resolveBuiltInToolAllowlist(config({ taskType: "workflow_child", toolset: "main" })),
    ).toBeUndefined();
  });

  it("does not add submit_result or escalate outside workflow children", () => {
    expect(
      resolveBuiltInToolAllowlist(config({ toolset: "main", toolAllowlist: ["Read"] })),
    ).toEqual(["Read"]);
    const subagentChild = resolveBuiltInToolAllowlist(
      config({ taskType: "subagent_child", toolset: "main", toolAllowlist: ["Read"] }),
    );
    expect(subagentChild).not.toContain(SUBMIT_RESULT_TOOL_NAME);
    expect(subagentChild).not.toContain(ESCALATE_TOOL_NAME);
  });
});

// workflow_child forces yolo and does not mirror interaction events into the parent session, so CreateWorkflow's
// alwaysAsk would emit a confirmation request inside the child that nobody can see (see
// docs/dynamic-workflow/launch.md "Recorded exceptions").
// SaveWorkflow is listed for the same root cause: it also declares alwaysAsk. ResumeWorkflowRun joined for the same
// reason (2026-08-29): resuming a run equals re-executing the whole script, and its alwaysAsk likewise has no window
// to pop in the child. ResolveWorkflowQuestion is the fourth, guarding a different invariant
// (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md):
// in escalation Q&A the right to answer belongs only to the side that created the workflow; the child must not decide on its behalf.
describe("resolveRuntimeDisallowedTools", () => {
  it("excludes the always-ask workflow tools from workflow-child runtimes", () => {
    const disallowed = resolveRuntimeDisallowedTools(config({ taskType: "workflow_child" }));
    expect(disallowed).toEqual([
      CREATE_WORKFLOW_TOOL_NAME,
      AMEND_WORKFLOW_TOOL_NAME,
      SAVE_WORKFLOW_TOOL_NAME,
      RESUME_WORKFLOW_RUN_TOOL_NAME,
      RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
      FILL_WORKFLOW_HOLE_TOOL_NAME,
    ]);
    // Reverse assertion: read-only run introspection tools are not listed — that ban's rationale is "no window to pop",
    // which does not apply to read-only queries.
    expect(disallowed).not.toContain(LIST_WORKFLOW_RUNS_TOOL_NAME);
    expect(disallowed).not.toContain(GET_WORKFLOW_RUN_TOOL_NAME);
  });

  it("merges with an existing turn disallowlist instead of replacing it", () => {
    expect(
      resolveRuntimeDisallowedTools(
        config({ taskType: "workflow_child", toolDisallowlist: ["CronCreate"] }),
      ),
    ).toEqual([
      "CronCreate",
      CREATE_WORKFLOW_TOOL_NAME,
      AMEND_WORKFLOW_TOOL_NAME,
      SAVE_WORKFLOW_TOOL_NAME,
      RESUME_WORKFLOW_RUN_TOOL_NAME,
      RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
      FILL_WORKFLOW_HOLE_TOOL_NAME,
    ]);
  });

  it("does not duplicate an already disallowed CreateWorkflow", () => {
    expect(
      resolveRuntimeDisallowedTools(
        config({ taskType: "workflow_child", toolDisallowlist: [CREATE_WORKFLOW_TOOL_NAME] }),
      ),
    ).toEqual([
      CREATE_WORKFLOW_TOOL_NAME,
      AMEND_WORKFLOW_TOOL_NAME,
      SAVE_WORKFLOW_TOOL_NAME,
      RESUME_WORKFLOW_RUN_TOOL_NAME,
      RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
      FILL_WORKFLOW_HOLE_TOOL_NAME,
    ]);
  });

  it("leaves other task types on their configured disallowlist", () => {
    expect(resolveRuntimeDisallowedTools(config({ taskType: "subagent_child" }))).toBeUndefined();
    expect(resolveRuntimeDisallowedTools(config({ toolDisallowlist: ["CronCreate"] }))).toEqual([
      "CronCreate",
    ]);
  });

  // The structural half: the ban takes effect by **taskType**, so it does not depend on whether the persona profile
  // happens to narrow it away. bootstrap's DEFAULT_DISALLOWED_TOOLS is a deliberately duplicated second gate
  // (following CreateWorkflow's two-column precedent) covering only the "default" profile; this gate covers every
  // workflow child, so future persona profiles will not open the door either.
  it("keeps ResolveWorkflowQuestion out of every workflow child, whatever the persona profile", () => {
    // With no turn-level list (equivalent to the persona trimming nothing under a narrowed profile), the structural ban still holds.
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      disallowedTools: resolveRuntimeDisallowedTools(config({ taskType: "workflow_child" })),
    });
    expect(registry.has(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME)).toBe(false);
    // Reverse assertion: the actor's **asking** channel must never be caught by this ban.
    expect(resolveRuntimeDisallowedTools(config({ taskType: "workflow_child" }))).not.toContain(
      ESCALATE_TOOL_NAME,
    );
  });

  // The answer tool's identity boundary (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md): the main
  // session has it, actor sessions do not — the entire point of escalation is to hand the judgment to the side that
  // created the workflow; letting another actor casually answer would quietly degrade it into actors persuading each
  // other. The actor session's ban is pushed down by bootstrap's workflowActorToolPolicy (DEFAULT_DISALLOWED_TOOLS);
  // what is asserted here is its effect on the registry.
  it("registers ResolveWorkflowQuestion in a main runtime but not in an actor session", () => {
    const mainRegistry = createToolRegistry();
    registerBuiltInTools(mainRegistry, {
      disallowedTools: resolveRuntimeDisallowedTools(config({})),
    });
    expect(mainRegistry.has(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME)).toBe(true);

    // Actor session: the persona's "default" profile trims it away (the list comes from bootstrap; simulated here under the same name).
    const actorRegistry = createToolRegistry();
    registerBuiltInTools(actorRegistry, {
      disallowedTools: resolveRuntimeDisallowedTools(
        config({
          taskType: "workflow_child",
          toolDisallowlist: [RESOLVE_WORKFLOW_QUESTION_TOOL_NAME],
        }),
      ),
    });
    expect(actorRegistry.has(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME)).toBe(false);
  });

  it("keeps the tool out of the registry for a workflow child but not for a main runtime", () => {
    const childRegistry = createToolRegistry();
    registerBuiltInTools(childRegistry, {
      disallowedTools: resolveRuntimeDisallowedTools(config({ taskType: "workflow_child" })),
    });
    expect(childRegistry.has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);
    expect(childRegistry.has(RESUME_WORKFLOW_RUN_TOOL_NAME)).toBe(false);

    const mainRegistry = createToolRegistry();
    registerBuiltInTools(mainRegistry, {
      disallowedTools: resolveRuntimeDisallowedTools(config({})),
    });
    expect(mainRegistry.has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
    expect(mainRegistry.has(RESUME_WORKFLOW_RUN_TOOL_NAME)).toBe(true);
  });
});

// docs/dynamic-workflow/launch.md "Gray release" DWG-03 / DWG-04.
const GATED_DYNAMIC_WORKFLOW_TOOL_NAMES = [
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  // Hole completion moves with the gray gate in lockstep: with the gate off, no run ever reaches a hole, and keeping
  // the tool would only point at something that does not exist.
  FILL_WORKFLOW_HOLE_TOOL_NAME,
];

describe("registerBuiltInTools：动态工作流灰度门", () => {
  const GATED_TOOL_NAMES = GATED_DYNAMIC_WORKFLOW_TOOL_NAMES;

  it("includeDynamicWorkflow:false 时十个工具一个都不注册", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeDynamicWorkflow: false });
    for (const name of GATED_TOOL_NAMES) {
      expect({ name, registered: registry.has(name) }).toEqual({ name, registered: false });
    }
  });

  // Turning the gray gate off only targets dynamic workflow: the difference between gate-open and gate-closed must
  // be **exactly** these ten. It also guards the old `Workflow` in reverse (the /expert script channel) — its gate
  // has always been only includeWorkflow, gaining or losing nothing from the gray gate.
  it("关门与开门的差集恰好是十个，不多剃一件工具", () => {
    const enabled = createToolRegistry();
    registerBuiltInTools(enabled, { includeDynamicWorkflow: true, includeWorkflow: true });
    const disabled = createToolRegistry();
    registerBuiltInTools(disabled, { includeDynamicWorkflow: false, includeWorkflow: true });

    const registeredWhenDisabled = new Set(disabled.list());
    expect(
      enabled
        .list()
        .filter((name) => !registeredWhenDisabled.has(name))
        .toSorted(),
    ).toEqual([...GATED_TOOL_NAMES].toSorted());
  });

  // Absent means fully open (in-process embedders); the standalone CLI's TUI / headless pass true/false explicitly via --workflow-mode (DWG-04).
  it.each([{ includeDynamicWorkflow: undefined }, { includeDynamicWorkflow: true }])(
    "缺席或 true 时十个工具全部注册：%j",
    (options) => {
      const registry = createToolRegistry();
      registerBuiltInTools(registry, options);
      for (const name of GATED_TOOL_NAMES) {
        expect({ name, registered: registry.has(name) }).toEqual({ name, registered: true });
      }
    },
  );
});

// The hop that carries the gray gate from runtimeConfig to the registry (runtime-tools.ts): unlike off-peak,
// the criterion is not the presence of a port but an explicit false written by the Host or the standalone CLI entry.
describe("AgentRuntime：dynamicWorkflowEnabled 到工具注册表", () => {
  it.each([
    { config: { dynamicWorkflowEnabled: false }, registered: false },
    { config: { dynamicWorkflowEnabled: true }, registered: true },
    // In-process embedders do not write this field; all tools must be kept.
    { config: {}, registered: true },
  ])("config %j", ({ config: runtimeConfig, registered }) => {
    const registry = createToolRegistry();
    new AgentRuntime(createSessionId("gray-release"), runtimeConfig, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: registry,
    });
    expect(registry.has(CREATE_WORKFLOW_TOOL_NAME)).toBe(registered);
    expect(registry.has(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME)).toBe(registered);
  });
});

// Regression (2026-09-16): the registration surface had two entry points and the second one (branch refresh) missed
// the gray gate, so the ten tools were added right back when the Bash shell snapshot was initialized. The real trigger
// path is initializeSessionShellEnvironmentIfNeeded, so this test goes through the public method instead of calling
// the internal refreshBranchAwareBuiltInTools directly.
describe("AgentRuntime：分支刷新后灰度门仍然成立", () => {
  const CMD_SHELL_SELECTION = {
    dialect: "cmd",
    display: { name: "CMD" },
    id: "cmd",
    label: "CMD",
    path: "cmd.exe",
    source: "user-config",
  } as const;

  it.each([
    { config: { dynamicWorkflowEnabled: false }, registered: false },
    { config: { dynamicWorkflowEnabled: true }, registered: true },
    { config: {}, registered: true },
  ])("config %j", ({ config: runtimeConfig, registered }) => {
    const runtime = new AgentRuntime(createSessionId("gray-release-refresh"), runtimeConfig, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: createToolRegistry(),
    });
    // The shape after first assembly.
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(registered);

    // Shell snapshot initialization before the first real user execution; internally goes through refreshBranchAwareBuiltInTools.
    expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

    const registry = runtime.getToolRegistry();
    for (const name of GATED_DYNAMIC_WORKFLOW_TOOL_NAMES) {
      expect({ name, registered: registry.has(name) }).toEqual({ name, registered });
    }
    // Reverse assertion: the refresh's own duty (Glob/Grep under the embedded search branch) is unaffected,
    // and the ordinary tool surface remains under all three values.
    expect(registry.has("Read")).toBe(true);
  });
});

// The gray gate governs more than the registration surface — it also governs the **description**
// (docs/dynamic-workflow/launch.md "Gray release"): the Agent / Task provider descriptions contain a line saying
// "CreateWorkflow is mandatory when the user names a workflow". With the gate off that tool is not in the registry,
// and keeping the sentence would only point the model at a tool that does not exist.
// Both registration entry points share options.includeDynamicWorkflow, so the description after a branch refresh must be consistent too.
describe("Agent / Task 描述随灰度门增删工作流那一行", () => {
  function descriptionsOf(options: { includeDynamicWorkflow?: boolean }): {
    agent: string;
    task: string;
  } {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeAgent: true, ...options });
    const agent = registry.get("Agent")?.metadata.description ?? "";
    const task = registry.get("Task")?.metadata.description ?? "";
    return { agent, task };
  }

  it("关闭时 Agent 与 Task 的描述都不再提 CreateWorkflow", () => {
    const { agent, task } = descriptionsOf({ includeDynamicWorkflow: false });
    expect(agent).not.toContain("CreateWorkflow");
    expect(task).not.toContain("CreateWorkflow");
    // Reverse assertion: only that line was removed; the description body remains.
    expect(agent).toContain("Launch a new agent");
    expect(task).toContain("Claude Code-compatible alias");
  });

  it.each([{ includeDynamicWorkflow: true }, {}])("开启或缺席时那一行保留：%j", (options) => {
    const { agent, task } = descriptionsOf(options);
    expect(agent).toContain("CreateWorkflow");
    expect(task).toContain("CreateWorkflow");
  });
});
