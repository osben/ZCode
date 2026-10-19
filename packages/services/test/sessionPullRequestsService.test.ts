import assert from "assert/strict";
import test from "node:test";
import {
  createHarness,
  makeNode,
  MERGED_PR,
  OPEN_PR,
  type Script,
} from "./helpers/sessionPullRequestsServiceFakes.js";

test("resolves an open pull request for a worktree task branch", async () => {
  const harness = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: "/wt" }],
  });
  const status = result.t1!;
  assert.equal(status.state, "ready");
  assert.equal(status.primaryNumber, 7);
  assert.equal(status.pullRequests.length, 1);
  assert.equal(status.pullRequests[0]?.stage, "open");
  assert.equal(status.pullRequests[0]?.repository, "osben/ZCode");
  assert.equal(status.stale, false);
  assert.equal(harness.fakeGh.apiCalls.length, 1);
});

test("branch set unions persisted branchName and live worktree HEAD", async () => {
  const harness = createHarness(
    {
      "osben/ZCode": {
        "feat/a": [MERGED_PR],
        "feat/b": [makeNode({ number: 9, headRefName: "feat/b" })],
      },
    },
    { headByPath: { "/wt": "feat/b" } },
  );
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/a", worktreePath: "/wt" }],
  });
  const status = result.t1!;
  assert.equal(status.pullRequests.length, 2, "PRs of both branches are listed");
  assert.equal(status.primaryNumber, 9, "open beats merged");
  assert.equal(status.pullRequests[0]?.number, 9);
  assert.equal(status.pullRequests[1]?.number, 3);
  assert.deepEqual(
    harness.fakeGh.apiCalls[0]?.branches.sort(),
    ["feat/a", "feat/b"],
    "both branches ride one batched call",
  );
});

test("queries every distinct GitHub remote when no gh default is set", async () => {
  const harness = createHarness(
    {
      "osben/ZCode": { "feat/x": [OPEN_PR] },
      "zai-org/ZCode": {
        "feat/x": [makeNode({ number: 42, headRefName: "feat/x" })],
      },
    },
    {
      remotes: [
        { name: "origin", url: "git@github.com:osben/ZCode.git" },
        { name: "upstream", url: "https://github.com/zai-org/ZCode.git" },
      ],
    },
  );
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(result.t1?.pullRequests.length, 2);
  assert.deepEqual(
    harness.fakeGh.apiCalls.map((call) => `${call.owner}/${call.name}`).sort(),
    ["osben/ZCode", "zai-org/ZCode"],
    "one batch per base repository",
  );
});

test("a gh default repository narrows targeting to that repository", async () => {
  const harness = createHarness(
    { "osben/ZCode": { "feat/x": [OPEN_PR] } },
    {
      gh: { defaultRepoStdout: "osben/ZCode\n" },
      remotes: [
        { name: "origin", url: "git@github.com:osben/ZCode.git" },
        { name: "upstream", url: "https://github.com/zai-org/ZCode.git" },
      ],
    },
  );
  await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(harness.fakeGh.apiCalls.length, 1);
  assert.equal(harness.fakeGh.apiCalls[0]?.owner, "osben");
});

test("drops pull requests pushed by a different head owner", async () => {
  const harness = createHarness({
    "osben/ZCode": {
      "feat/x": [OPEN_PR, makeNode({ number: 8, headRepositoryOwner: { login: "someone-else" } })],
    },
  });
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(result.t1?.pullRequests.length, 1);
  assert.equal(result.t1?.pullRequests[0]?.number, 7);
});

test("TTL tiers: 60s active, 10min no PR, 30min settled", async () => {
  const active = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  await active.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  active.setNow(30_000);
  await active.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(active.fakeGh.apiCalls.length, 1, "open PR stays cached at 30s");
  active.setNow(61_000);
  await active.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(active.fakeGh.apiCalls.length, 2, "open PR re-probes after 60s");

  const none = createHarness({ "osben/ZCode": {} });
  await none.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  none.setNow(9 * 60_000);
  await none.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(none.fakeGh.apiCalls.length, 1, "no-PR stays cached for 10 min");
  none.setNow(10 * 60_000 + 1_000);
  await none.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(none.fakeGh.apiCalls.length, 2);

  const settled = createHarness({ "osben/ZCode": { "feat/x": [MERGED_PR] } });
  await settled.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  settled.setNow(29 * 60_000);
  await settled.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(settled.fakeGh.apiCalls.length, 1, "merged PR stays cached for 30 min");
  settled.setNow(30 * 60_000 + 1_000);
  await settled.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(settled.fakeGh.apiCalls.length, 2);
});

test("forceTaskIds bypasses the TTL", async () => {
  const harness = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const request = (force?: string[]) => ({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
    ...(force ? { forceTaskIds: force } : {}),
  });
  await harness.service.getSessionPullRequests(request());
  harness.setNow(5_000);
  await harness.service.getSessionPullRequests(request());
  assert.equal(harness.fakeGh.apiCalls.length, 1, "within TTL no probe");
  await harness.service.getSessionPullRequests(request(["t1"]));
  assert.equal(harness.fakeGh.apiCalls.length, 2, "force refresh probes immediately");
});

test("concurrent requests coalesce into one batch per repository", async () => {
  const harness = createHarness(
    { "osben/ZCode": { "feat/a": [makeNode({ number: 1 })], "feat/b": [makeNode({ number: 2 })] } },
    { coalesceWindowMs: 30 },
  );
  const request = (taskId: string, branchName: string) => ({
    workspacePath: "/w",
    tasks: [{ taskId, branchName, worktreePath: null }],
  });
  const [first, second] = await Promise.all([
    harness.service.getSessionPullRequests(request("t1", "feat/a")),
    harness.service.getSessionPullRequests(request("t2", "feat/b")),
  ]);
  assert.equal(first.t1?.primaryNumber, 1);
  assert.equal(second.t2?.primaryNumber, 2);
  assert.equal(harness.fakeGh.apiCalls.length, 1, "one gh call for both tasks");
  assert.deepEqual(harness.fakeGh.apiCalls[0]?.branches.sort(), ["feat/a", "feat/b"]);
});

test("rate limit serves the last value stale and blocks new requests", async () => {
  const harness = createHarness(
    { "osben/ZCode": { "feat/x": [OPEN_PR] } },
    { gh: { rateRemaining: 50, rateResetAt: new Date(300_000).toISOString() } },
  );
  await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  harness.setNow(1_000);
  const second = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [
      { taskId: "t1", branchName: "feat/x", worktreePath: null },
      { taskId: "t2", branchName: "feat/other", worktreePath: null },
    ],
  });
  assert.equal(harness.fakeGh.apiCalls.length, 1, "no gh call during backoff");
  assert.equal(second.t1?.stale, true, "existing value served stale");
  assert.equal(second.t1?.primaryNumber, 7);
  assert.equal(second.t2?.state, "rate_limited", "a never-fetched branch reports rate_limited");
});

test("missing gh reports unavailable with one warn", async () => {
  const harness = createHarness({}, { gh: { binary: null } });
  const request = {
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  };
  const first = await harness.service.getSessionPullRequests(request);
  assert.equal(first.t1?.state, "unavailable");
  assert.equal(first.t1?.unavailableReason, "no_gh");
  await harness.service.getSessionPullRequests(request);
  assert.equal(harness.logger.warns.length, 1, "warn once per workspace");
});

test("unauthenticated gh reports unavailable auth", async () => {
  const harness = createHarness({}, { gh: { authExitCode: 1 } });
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(result.t1?.state, "unavailable");
  assert.equal(result.t1?.unavailableReason, "auth");
});

test("workspace without GitHub remotes reports not_github", async () => {
  const harness = createHarness(
    {},
    { remotes: [{ name: "origin", url: "https://gitlab.example.com/group/repo.git" }] },
  );
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(result.t1?.state, "unavailable");
  assert.equal(result.t1?.unavailableReason, "not_github");
  assert.equal(harness.fakeGh.apiCalls.length, 0);
});

test("ordinary sessions stay absent at the request boundary", async () => {
  const harness = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [
      { taskId: "ordinary", branchName: null, worktreePath: null },
      { taskId: "worktree", branchName: "feat/x", worktreePath: "/wt" },
    ],
  });
  assert.equal(result["ordinary"]?.state, "ready");
  assert.equal(result["ordinary"]?.pullRequests.length, 0);
  assert.equal(result["ordinary"]?.fetchedAt, null);
  assert.equal(result["worktree"]?.primaryNumber, 7);
  assert.equal(harness.fakeGh.apiCalls.length, 1, "only the worktree branch rides the call");
  assert.deepEqual(harness.fakeGh.apiCalls[0]?.branches, ["feat/x"]);
});

test("cache keys by workspaceIdentity with path fallback", async () => {
  const harness = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const request = (identity?: string) => ({
    workspacePath: "/w",
    ...(identity ? { workspaceIdentity: identity } : {}),
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  await harness.service.getSessionPullRequests(request("id-a"));
  await harness.service.getSessionPullRequests(request("id-b"));
  assert.equal(harness.fakeGh.apiCalls.length, 2, "distinct identities probe separately");
  await harness.service.getSessionPullRequests(request("id-b"));
  await harness.service.getSessionPullRequests(request("  "));
  assert.equal(
    harness.fakeGh.apiCalls.length,
    3,
    "identity reuse hits cache; blank identity falls back to path key",
  );
});

test("a forced task invalidates an in-flight probe's write", async () => {
  const script: Script = { "osben/ZCode": {} };
  const harness = createHarness(script, { gh: { manualFirstApi: true }, coalesceWindowMs: 10 });
  const request = (force?: string) => ({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
    ...(force ? { forceTaskIds: [force] } : {}),
  });

  const firstCall = harness.service.getSessionPullRequests(request());
  await harness.fakeGh.firstApiStarted;

  // While the first probe is in flight, the turn ends and forces a refresh.
  script["osben/ZCode"] = {
    "feat/x": [makeNode({ number: 99, headRefName: "feat/x" })],
  };
  const forced = await harness.service.getSessionPullRequests(request("t1"));
  assert.equal(forced.t1?.primaryNumber, 99, "the forced probe sees the new PR");

  // The stale in-flight result (no PRs) resolves after the forced write.
  harness.fakeGh.resolveFirstApi(
    JSON.stringify({
      data: {
        repository: { b0: { nodes: [] } },
        rateLimit: { remaining: 5000, resetAt: "2026-10-18T12:00:00Z" },
      },
    }),
  );
  await firstCall;
  harness.setNow(5_000);
  const after = await harness.service.getSessionPullRequests(request());
  assert.equal(after.t1?.primaryNumber, 99, "the stale write did not repopulate the entry");
  assert.equal(harness.fakeGh.apiCalls.length, 2);
});

test("gh failures serve the previous value stale and warn once", async () => {
  const script: Script = { "osben/ZCode": { "feat/x": [OPEN_PR] } };
  const harness = createHarness(script);
  const request = {
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  };
  await harness.service.getSessionPullRequests(request);

  // The next probe fails with a non-zero exit; the fake returns garbage stdout.
  const originalRun = (
    harness.fakeGh.gh as unknown as {
      run: (options: { args: string[] }) => Promise<{ exitCode: number; stdout: string }>;
    }
  ).run;
  (harness.fakeGh.gh as unknown as { run: typeof originalRun }).run = async (options: {
    args: string[];
  }) => {
    if (options.args[0] === "api") {
      return { exitCode: 1, stdout: "", stderr: "boom", timedOut: false };
    }
    return originalRun(options);
  };

  harness.setNow(61_000);
  const failed = await harness.service.getSessionPullRequests(request);
  assert.equal(failed.t1?.primaryNumber, 7, "previous value survives the failure");
  assert.equal(failed.t1?.stale, true);

  harness.setNow(62_000);
  await harness.service.getSessionPullRequests(request);
  assert.equal(harness.logger.warns.length, 1, "one warn per workspace per failure class");
});

test("head owner matches case-insensitively against the remote URL spelling", async () => {
  // The remote URL spells the owner "OSBen"; GitHub logins are case-insensitive.
  const harness = createHarness(
    { "OSBen/ZCode": { "feat/x": [OPEN_PR] } },
    { remotes: [{ name: "origin", url: "git@github.com:OSBen/ZCode.git" }] },
  );
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(result.t1?.pullRequests.length, 1, "login osben matches remote owner OSBen");
});

test("gh exits non-zero with a RATE_LIMITED body: the branch reports rate_limited", async () => {
  const harness = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const gh = harness.fakeGh.gh as unknown as {
    run: (options: { args: string[] }) => Promise<unknown>;
  };
  const originalRun = gh.run;
  gh.run = async (options: { args: string[] }) => {
    if (options.args[0] === "api") {
      // gh prints the GraphQL response on stdout and exits non-zero for GraphQL errors.
      return {
        binaryPath: "/fake/gh",
        stdout: JSON.stringify({
          data: { repository: null, rateLimit: { remaining: 0, resetAt: "2026-10-18T12:00:00Z" } },
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        }),
        stderr: "",
        exitCode: 1,
        timedOut: false,
      };
    }
    return originalRun(options);
  };
  const result = await harness.service.getSessionPullRequests({
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  });
  assert.equal(result.t1?.state, "rate_limited");
});

test("a failed refresh keeps the previous value stale and waits out the retry delay", async () => {
  const harness = createHarness({ "osben/ZCode": { "feat/x": [OPEN_PR] } });
  const request = {
    workspacePath: "/w",
    tasks: [{ taskId: "t1", branchName: "feat/x", worktreePath: null }],
  };
  await harness.service.getSessionPullRequests(request);

  let failing = true;
  let apiCalls = 0;
  const gh = harness.fakeGh.gh as unknown as {
    run: (options: { args: string[] }) => Promise<unknown>;
  };
  const originalRun = gh.run;
  gh.run = async (options: { args: string[] }) => {
    if (options.args[0] === "api") {
      apiCalls += 1;
      if (failing) {
        return { binaryPath: "/fake/gh", stdout: "", stderr: "boom", exitCode: 1, timedOut: false };
      }
    }
    return originalRun(options);
  };

  // The TTL expired at 60s, so this probe fails and keeps the value stale.
  harness.setNow(61_000);
  const failed = await harness.service.getSessionPullRequests(request);
  assert.equal(apiCalls, 1);
  assert.equal(failed.t1?.stale, true);

  // The retry delay (60s) applies to the stale entry too: no probe on every request.
  harness.setNow(100_000);
  const during = await harness.service.getSessionPullRequests(request);
  assert.equal(apiCalls, 1, "no gh call before the retry delay passes");
  assert.equal(during.t1?.primaryNumber, 7, "previous value still served");

  failing = false;
  harness.setNow(121_001);
  const recovered = await harness.service.getSessionPullRequests(request);
  assert.equal(apiCalls, 2, "retry once the delay has passed");
  assert.equal(recovered.t1?.stale, false);
});
