import type { GraphqlPullRequestNode } from "../../src/git/sessionPullRequestMapping.js";
import type { GhCommandProvider } from "../../src/git/providers/ghCommandProvider.js";
import {
  createSessionPullRequestsService,
  type SessionPullRequestsGitRunner,
  type SessionPullRequestsRepo,
} from "../../src/git/sessionPullRequestsService.js";
import type { ServiceLogger } from "../../src/logger/serviceLogger.js";

// Shared fakes for sessionPullRequestsService.test.ts: scripted gh, fake repo, and harness.

/**
 * All gh/git interaction is faked: no test may touch the network. The fake gh
 * answers `auth status`, `repo set-default --view`, and `api graphql` from a
 * scripted per-repository branch → nodes map.
 */

export function makeNode(overrides: Partial<GraphqlPullRequestNode> = {}): GraphqlPullRequestNode {
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

export interface FakeGhOptions {
  binary?: string | null;
  authExitCode?: number;
  defaultRepoStdout?: string;
  rateRemaining?: number;
  rateResetAt?: string;
  /** Hold the first `api graphql` call until the test resolves it (race tests). */
  manualFirstApi?: boolean;
}

export type Script = Record<string, Record<string, GraphqlPullRequestNode[]>>;

export function createFakeGh(script: Script, options: FakeGhOptions = {}) {
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

export function createFakeRepo(
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

export const GIT_RUNNER: SessionPullRequestsGitRunner = {
  // All git config lookups read as unset: the push remote chain falls back to origin.
  run: async () => ({ exitCode: 1, stdout: "", timedOut: false }),
};

export function createLoggerCapture(): {
  logger: ServiceLogger;
  infos: unknown[][];
  warns: unknown[][];
} {
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

export function createHarness(
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

export const OPEN_PR = makeNode({ number: 7, headRefName: "feat/x" });
export const MERGED_PR = makeNode({
  number: 3,
  headRefName: "feat/x",
  state: "MERGED",
  mergedAt: "2026-10-17T00:00:00Z",
  updatedAt: "2026-10-17T00:00:00Z",
});
