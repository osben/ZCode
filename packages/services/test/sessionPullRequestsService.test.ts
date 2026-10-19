import assert from "assert/strict";
import test from "node:test";
import type { GraphqlPullRequestNode } from "../src/git/sessionPullRequestMapping.js";
import type { GhCommandProvider } from "../src/git/providers/ghCommandProvider.js";
import {
  createSessionPullRequestsService,
  type SessionPullRequestsGitRunner,
  type SessionPullRequestsRepo,
} from "../src/git/sessionPullRequestsService.js";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";

/**
 * All gh/git interaction is faked: no test may touch the network. The fake gh
 * answers `auth status`, `repo set-default --view`, and `api graphql` from a
 * scripted per-repository branch → nodes map.
 */

function makeNode(overrides: Partial<GraphqlPullRequestNode> = {}): GraphqlPullRequestNode {
  return {
    number: 1,
    url: "https://github.com/osben/ZCode/pull/1",
    title: "Example",
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    updatedAt: "2026-10-18T10:00:00Z",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    additions: 3,
    deletions: 1,
    headRefName: "feat/x",
    headRepositoryOwner: { login: "osben" },
    mergeStateStatus: "CLEAN",
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: { totalCount: 0, nodes: [] },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

interface FakeGhOptions {
  binary?: string | null;
  authExitCode?: number;
  defaultRepoStdout?: string;
  rateRemaining?: number;
  rateResetAt?: string;
  /** Hold the first `api graphql` call until the test resolves it (race tests). */
  manualFirstApi?: boolean;
}

type Script = Record<string, Record<string, GraphqlPullRequestNode[]>>;

function createFakeGh(script: Script, options: FakeGhOptions = {}) {
  const binary = options.binary === undefined ? "/fake/gh" : options.binary;
  const apiCalls: Array<{ owner: string; name: string; branches: string[] }> = [];
  let firstApiStartedResolve: (() => void) | null = null;
  const firstApiStarted = new Promise<void>((resolve) => {
    firstApiStartedResolve = resolve;
  });
  let resolveFirstApi: ((stdout: string) => void) | null = null;

  const gh = {
    resolveGhBinary: async () => binary,
    run: async ({ args }: { args: string[] }) => {
      if (args[0] === "auth") {
        return {
          binaryPath: "/fake/gh",
          stdout: "",
          stderr: "",
          exitCode: options.authExitCode ?? 0,
          timedOut: false,
        };
      }
      if (args[0] === "repo") {
        return {
          binaryPath: "/fake/gh",
          stdout: options.defaultRepoStdout ?? "",
          stderr: "",
          exitCode: options.defaultRepoStdout ? 0 : 1,
          timedOut: false,
        };
      }

      const params = new Map<string, string>();
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== "-f" || index + 1 >= args.length) {
          continue;
        }
        const pair = args[index + 1]!;
        const equalsIndex = pair.indexOf("=");
        if (equalsIndex > 0) {
          params.set(pair.slice(0, equalsIndex), pair.slice(equalsIndex + 1));
        }
      }
      const owner = params.get("owner") ?? "";
      const name = params.get("name") ?? "";
      const branches: string[] = [];
      for (let index = 0; params.has(`b${index}`); index += 1) {
        branches.push(params.get(`b${index}`)!);
      }
      apiCalls.push({ owner, name, branches });

      const repositoryScript = script[`${owner}/${name}`] ?? {};
      const repository: Record<string, { nodes: unknown[] }> = {};
      branches.forEach((branch, index) => {
        repository[`b${index}`] = { nodes: repositoryScript[branch] ?? [] };
      });
      const stdout = JSON.stringify({
        data: {
          repository,
          rateLimit: {
            remaining: options.rateRemaining ?? 5000,
            resetAt: options.rateResetAt ?? "2026-10-18T12:00:00Z",
          },
        },
      });

      if (options.manualFirstApi && apiCalls.length === 1) {
        firstApiStartedResolve?.();
        return new Promise((resolvePromise) => {
          resolveFirstApi = (value: string) =>
            resolvePromise({
              binaryPath: "/fake/gh",
              stdout: value,
              stderr: "",
              exitCode: 0,
              timedOut: false,
            });
        });
      }
      return {
        binaryPath: "/fake/gh",
        stdout,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    },
  } as unknown as GhCommandProvider;

  return {
    gh,
    apiCalls,
    firstApiStarted,
    resolveFirstApi: (stdout: string) => resolveFirstApi?.(stdout),
  };
}

function createFakeRepo(
  remotes: Array<{ name: string; url: string }>,
  headByPath: Record<string, string | null> = {},
): SessionPullRequestsRepo {
  return {
    getRepositoryRemotes: async (workspacePath: string) => ({
      workspacePath,
      isGitAvailable: true,
      isRepository: true,
      remotes,
    }),
    readHeadBranch: async (path: string) => headByPath[path] ?? null,
  };
}

const GIT_RUNNER: SessionPullRequestsGitRunner = {
  // All git config lookups read as unset: the push remote chain falls back to origin.
  run: async () => ({ exitCode: 1, stdout: "", timedOut: false }),
};

function createLoggerCapture(): { logger: ServiceLogger; infos: unknown[][]; warns: unknown[][] } {
  const infos: unknown[][] = [];
  const warns: unknown[][] = [];
  return {
    infos,
    warns,
    logger: {
      debug: () => {},
      info: (_traceId, ...args: unknown[]) => infos.push(args),
      warn: (_traceId, ...args: unknown[]) => warns.push(args),
      error: () => {},
    },
  };
}

function createHarness(
  script: Script,
  options?: {
    gh?: FakeGhOptions;
    remotes?: Array<{ name: string; url: string }>;
    headByPath?: Record<string, string | null>;
    coalesceWindowMs?: number;
  },
) {
  const fakeGh = createFakeGh(script, options?.gh);
  const logger = createLoggerCapture();
  let nowMs = 0;
  const service = createSessionPullRequestsService({
    repo: createFakeRepo(
      options?.remotes ?? [{ name: "origin", url: "git@github.com:osben/ZCode.git" }],
      options?.headByPath,
    ),
    gitRunner: GIT_RUNNER,
    gh: fakeGh.gh,
    logger: logger.logger,
    now: () => nowMs,
    coalesceWindowMs: options?.coalesceWindowMs ?? 10,
  });
  return {
    fakeGh,
    logger,
    service,
    setNow: (value: number) => {
      nowMs = value;
    },
  };
}

const OPEN_PR = makeNode({ number: 7, headRefName: "feat/x" });
const MERGED_PR = makeNode({
  number: 3,
  headRefName: "feat/x",
  state: "MERGED",
  mergedAt: "2026-10-17T00:00:00Z",
  updatedAt: "2026-10-17T00:00:00Z",
});

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
