import assert from "assert/strict";
import test from "node:test";
import { createSessionPullRequestsService } from "../src/git/sessionPullRequestsService.js";
import {
  createFakeGh,
  createFakeRepo,
  createHarness,
  createLoggerCapture,
  GIT_RUNNER,
  MERGED_PR,
  OPEN_PR,
} from "./helpers/sessionPullRequestsServiceFakes.js";

// Log content checks for the session pull request service: warnings are deduplicated and no
// workspace path, remote, or PR identity is logged.

test("a thrown request error warns once per workspace and logs no workspace path", async () => {
  const logger = createLoggerCapture();
  const service = createSessionPullRequestsService({
    repo: {
      getRepositoryRemotes: async () => {
        throw new Error("cannot read /private/secret/workspace");
      },
      readHeadBranch: async () => null,
    },
    gitRunner: GIT_RUNNER,
    gh: createFakeGh({}).gh,
    logger: logger.logger,
    now: () => 0,
    coalesceWindowMs: 10,
  });
  const request = {
    workspacePath: "/private/secret/workspace",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  };
  const first = await service.getSessionPullRequests(request);
  await service.getSessionPullRequests(request);
  assert.equal(first.t1?.state, "unavailable");
  assert.equal(logger.warns.length, 1, "one warn for repeated thrown errors");
  assert.equal(JSON.stringify(logger.warns).includes("secret"), false);
});

test("stage change log carries only the stage transition, not workspace or PR identity", async () => {
  const harness = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const request = {
    workspacePath: "/private/secret/workspace",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  };
  await harness.service.getSessionPullRequests(request);

  // After the TTL the next probe returns a merged PR, which is a stage change.
  const gh = harness.fakeGh.gh as unknown as {
    run: (options: { args: string[] }) => Promise<unknown>;
  };
  const originalRun = gh.run;
  gh.run = async (options: { args: string[] }) => {
    if (options.args[0] === "api") {
      return {
        binaryPath: "/fake/gh",
        stdout: JSON.stringify({
          data: {
            repository: { b0: { nodes: [MERGED_PR] } },
            rateLimit: { remaining: 5000, resetAt: "2026-10-18T12:00:00Z" },
          },
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    }
    return originalRun(options);
  };
  harness.setNow(61_000);
  await harness.service.getSessionPullRequests(request);

  const stageLogs = harness.logger.infos.filter(
    (args) => args[0] === "session pull request stage changed",
  );
  assert.ok(stageLogs.length >= 1, "stage change is logged");
  for (const args of stageLogs) {
    assert.deepEqual(Object.keys(args[1] as object).sort(), ["from", "to"]);
  }
  assert.equal(JSON.stringify(harness.logger.infos).includes("secret"), false);
  assert.equal(JSON.stringify(harness.logger.infos).includes("e2e"), false);
});

test("a gh call failure warn carries no branch name", async () => {
  const harness = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const gh = harness.fakeGh.gh as unknown as {
    run: (options: { args: string[] }) => Promise<unknown>;
  };
  const originalRun = gh.run;
  gh.run = async (options: { args: string[] }) => {
    if (options.args[0] === "api") {
      return { exitCode: 1, stdout: "", stderr: "boom", timedOut: false };
    }
    return originalRun(options);
  };

  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/private/secret/workspace",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(result.t1?.state, "unavailable");
  const failures = harness.logger.warns.filter(
    (args) => args[0] === "session pull request gh call failed",
  );
  assert.equal(failures.length, 1, "one warn for the failure class");
  assert.equal(failures[0]?.[1], undefined, "the warn has no detail argument");
  assert.equal(JSON.stringify(harness.logger.warns).includes("feat/x"), false);
});

test("a flush failure rejects the refresh into the request-error fallback", async () => {
  const logger = createLoggerCapture();
  const fakeGh = createFakeGh({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const service = createSessionPullRequestsService({
    repo: createFakeRepo([{ name: "origin", url: "git@github.com:osben/ZCode.git" }]),
    // Head-owner lookup rejects (spawn failure), which is a flush failure, not a gh result.
    gitRunner: {
      run: async () => {
        throw new Error("spawn failed");
      },
    },
    gh: fakeGh.gh,
    logger: logger.logger,
    now: () => 0,
    coalesceWindowMs: 10,
  });

  const result = await service.getSessionPullRequests({
    workspacePath: "/private/secret/workspace",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(result.t1?.state, "unavailable", "no empty ready answer after a failed flush");
  assert.equal(result.t1?.unavailableReason, "error");
  assert.deepEqual(fakeGh.apiCalls, [], "no batch is assembled from a failed flush");
  const requestErrors = logger.warns.filter(
    (args) => args[0] === "session pull requests request failed",
  );
  assert.equal(requestErrors.length, 1, "the request-error fallback warns once");
  assert.equal(JSON.stringify(logger.warns).includes("secret"), false);
});
