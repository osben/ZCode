// Execution-worktree isolation notice (spec: execution-worktree-model-context.md).
// The main agent gets the notice as its own dynamic system section; subagents get a bare <env> block.
// Plain sessions must not carry the notice at all.
import { describe, expect, it } from "vitest";
import type { EnvInfo } from "@zcode/contracts";
import { createContextBuilder } from "../src/context/index.js";
import {
  buildEnvInfoSection,
  buildExecutionWorktreeSection,
  type ExecutionWorktreeEnvFact,
} from "../src/context/sections/env-info.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";
import { buildSubagentExecutionWorktreeContext } from "../src/subagent/system-prompt.js";

const envInfo: EnvInfo = {
  cwd: "/workspace/project-worktrees/zcode-sleepy-capybara",
  platform: "darwin",
  shell: "zsh",
  osVersion: "24.3.0",
  nodeVersion: "v26.0.0",
};

const healthyFact: ExecutionWorktreeEnvFact = {
  path: "/workspace/project-worktrees/zcode-sleepy-capybara",
  branchName: "zcode/sleepy-capybara",
  workspacePath: "/workspace/project",
};

const HEALTHY_SENTENCE =
  "Execution worktree: this session runs in a linked git worktree of /workspace/project (branch zcode/sleepy-capybara); file changes stay in the worktree until they are merged.";

describe("execution worktree notice in the Environment section", () => {
  it("healthy worktree session renders the isolation bullet as its own system section", () => {
    const section = buildExecutionWorktreeSection(healthyFact);
    expect(section?.injectionTarget).toBe("system");
    expect(section?.content).toBe(`# Environment\n- ${HEALTHY_SENTENCE}`);
  });

  it("healthy fact without a branch omits the branch clause", () => {
    const content = buildExecutionWorktreeSection({
      ...healthyFact,
      branchName: undefined,
    })?.content;
    expect(content).toContain(
      "- Execution worktree: this session runs in a linked git worktree of /workspace/project; file changes stay in the worktree until they are merged.",
    );
    expect(content).not.toContain("(branch");
  });

  it("missing worktree explains filesystem actions are blocked until it is restored", () => {
    const content = buildExecutionWorktreeSection({
      path: healthyFact.path,
      missing: true,
      workspacePath: "/workspace/project",
    })?.content;
    expect(content).toContain(
      "- Execution worktree: the requested worktree /workspace/project-worktrees/zcode-sleepy-capybara is missing; filesystem and terminal actions are blocked until it is restored. The parent workspace is /workspace/project.",
    );
  });

  it("plain sessions keep the environment section free of the notice (regression guard)", () => {
    const withExplicitUndefined = buildEnvInfoSection(envInfo).content;
    expect(withExplicitUndefined).not.toContain("Execution worktree");
    expect(withExplicitUndefined.split("\n")[3]).toBe(" - Is a git repository: false");
    expect(buildExecutionWorktreeSection(undefined)).toBeNull();
  });

  it("the context builder delivers the notice in system messages only for worktree sessions", () => {
    const worktree = createContextBuilder({
      workingDirectory: envInfo.cwd,
      envInfo,
      executionWorktree: healthyFact,
    }).build();
    const worktreeSystem = worktree.systemMessages.map((message) => String(message.content));
    expect(worktreeSystem.join("\n")).toContain(`- ${HEALTHY_SENTENCE}`);

    const plain = createContextBuilder({ workingDirectory: envInfo.cwd, envInfo }).build();
    const plainSystem = plain.systemMessages.map((message) => String(message.content));
    expect(plainSystem.join("\n")).not.toContain("Execution worktree");
  });
});

describe("execution worktree notice in the subagent environment block", () => {
  it("subagent in a worktree session carries the same notice inside <env>", () => {
    const block = buildSubagentExecutionWorktreeContext(healthyFact);
    const lines = block.split("\n");
    expect(lines).toEqual(["<env>", HEALTHY_SENTENCE, "</env>"]);
  });

  it("subagent in a plain session has no notice block", () => {
    expect(buildSubagentExecutionWorktreeContext(undefined)).toBe("");
    const plain = createSubagentContextBuilder({ agentPrompt: "searcher", envInfo }).build();
    expect(plain.systemMessages.map((message) => String(message.content)).join("\n")).not.toContain(
      "Execution worktree",
    );
  });

  it("the subagent context builder carries the notice in its system messages", () => {
    const result = createSubagentContextBuilder({
      agentPrompt: "searcher",
      envInfo,
      executionWorktree: healthyFact,
    }).build();
    const system = result.systemMessages.map((message) => String(message.content)).join("\n");
    expect(system).toContain(`<env>\n${HEALTHY_SENTENCE}\n</env>`);
  });
});
