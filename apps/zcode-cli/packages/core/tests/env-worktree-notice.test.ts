// Execution-worktree isolation notice in the Environment sections (spec: execution-worktree-model-context.md).
// Covers the main-agent env section and the subagent env block; plain sessions must stay byte-identical.
import { describe, expect, it } from "vitest";
import type { EnvInfo } from "@zcode/contracts";
import {
  buildEnvInfoSection,
  type ExecutionWorktreeEnvFact,
} from "../src/context/sections/env-info.js";
import { buildSubagentEnvironmentContext } from "../src/subagent/system-prompt.js";

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

describe("execution worktree notice in the Environment section", () => {
  it("healthy worktree session renders the isolation bullet right after the working directory", () => {
    const content = buildEnvInfoSection(envInfo, undefined, healthyFact).content;
    const lines = content.split("\n");
    expect(lines[2]).toBe(
      "- Primary working directory: /workspace/project-worktrees/zcode-sleepy-capybara",
    );
    expect(lines[3]).toBe(
      "- Execution worktree: this session runs in a linked git worktree of /workspace/project (branch zcode/sleepy-capybara); file changes stay in the worktree until they are merged.",
    );
  });

  it("healthy fact without a branch omits the branch clause", () => {
    const content = buildEnvInfoSection(envInfo, undefined, {
      ...healthyFact,
      branchName: undefined,
    }).content;
    expect(content).toContain(
      "- Execution worktree: this session runs in a linked git worktree of /workspace/project; file changes stay in the worktree until they are merged.",
    );
    expect(content).not.toContain("(branch");
  });

  it("missing worktree renders the fallback bullet naming the parent workspace", () => {
    const content = buildEnvInfoSection(envInfo, undefined, {
      path: healthyFact.path,
      missing: true,
      workspacePath: "/workspace/project",
    }).content;
    expect(content).toContain(
      "- Execution worktree: the requested worktree /workspace/project-worktrees/zcode-sleepy-capybara is missing; this session is running in the parent workspace /workspace/project instead.",
    );
  });

  it("plain sessions keep the section byte-identical (regression guard)", () => {
    const withExplicitUndefined = buildEnvInfoSection(envInfo, undefined, undefined).content;
    const withoutParam = buildEnvInfoSection(envInfo).content;
    expect(withExplicitUndefined).toBe(withoutParam);
    expect(withoutParam).not.toContain("Execution worktree");
    expect(withoutParam.split("\n")[3]).toBe("- Is a git repository: no");
  });
});

describe("execution worktree notice in the subagent environment block", () => {
  it("subagent in a worktree session carries the same notice inside <env>", () => {
    const content = buildSubagentEnvironmentContext({
      agentPrompt: "searcher",
      envInfo,
      executionWorktree: healthyFact,
    });
    const lines = content.split("\n");
    expect(lines[2]).toBe("Working directory: /workspace/project-worktrees/zcode-sleepy-capybara");
    expect(lines[3]).toBe(
      "Execution worktree: this session runs in a linked git worktree of /workspace/project (branch zcode/sleepy-capybara); file changes stay in the worktree until they are merged.",
    );
    // The <env> block keeps its boundaries and remaining lines untouched.
    expect(lines[1]).toBe("<env>");
    expect(lines[8]).toBe("</env>");
  });

  it("subagent in a plain session keeps the block byte-identical (no notice)", () => {
    const withExplicitUndefined = buildSubagentEnvironmentContext({
      agentPrompt: "searcher",
      envInfo,
      executionWorktree: undefined,
    });
    const withoutOption = buildSubagentEnvironmentContext({ agentPrompt: "searcher", envInfo });
    expect(withExplicitUndefined).toBe(withoutOption);
    expect(withoutOption).not.toContain("Execution worktree");
  });
});
