import { gitRemoteUrlToRepository } from "@zcode/shared";
import type { GitRepositoryRemotesResult } from "@zcode/shared";
import type { GhCommandProvider } from "./providers/ghCommandProvider.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  buildSessionPullRequestsQuery,
  parseGhGraphqlResponse,
  type GraphqlPullRequestNode,
} from "./sessionPullRequestMapping.js";

/**
 * Host-side lookups for the session pull request service: workspace context (gh availability,
 * auth, GitHub remotes), head-owner resolution from git config, and the batched GraphQL call.
 * Split out of sessionPullRequestsService.ts to keep each module under the staged size gate.
 */

const AVAILABILITY_TTL_MS = 10 * 60_000;
const RATE_LIMIT_MIN_REMAINING = 100;

export interface BaseRepository {
  host: string;
  owner: string;
  name: string;
}

export interface WorkspaceContext {
  state: "available" | "no_gh" | "auth" | "not_github";
  checkedAtMs: number;
  baseRepositories: BaseRepository[];
  remoteUrlByName: Map<string, string>;
}

/** One GraphQL node with the label of the base repository it was queried from. */
export interface LabeledNode {
  repositoryLabel: string;
  node: GraphqlPullRequestNode;
}

export function createSessionPullRequestsLookup(options: {
  repo: { getRepositoryRemotes(workspacePath: string): Promise<GitRepositoryRemotesResult> };
  gitRunner: {
    run(options: {
      cwd: string;
      args: string[];
      timeoutMs?: number;
    }): Promise<{ exitCode: number | null; stdout: string; timedOut: boolean }>;
  };
  gh: GhCommandProvider;
  logger: ServiceLogger;
  now: () => number;
  warnOnce: (workspaceKey: string, className: string, message: string) => void;
}) {
  const now = options.now;
  const logger = options.logger;
  const warnOnce = options.warnOnce;
  const contextByWorkspace = new Map<string, WorkspaceContext>();

  async function readGitConfigValue(workspacePath: string, key: string): Promise<string | null> {
    const result = await options.gitRunner.run({
      cwd: workspacePath,
      args: ["config", "--get", key],
    });
    if (result.exitCode !== 0 || result.timedOut) {
      return null;
    }
    return result.stdout.trim() || null;
  }

  async function readRemoteUrl(workspacePath: string, remoteName: string): Promise<string | null> {
    const direct = await options.gitRunner.run({
      cwd: workspacePath,
      args: ["remote", "get-url", remoteName],
    });
    if (direct.exitCode !== 0 || direct.timedOut) {
      return null;
    }
    return direct.stdout.trim() || null;
  }

  /** Head owner = owner of the branch's push remote (spec: pushRemote → pushDefault → branch remote → origin). */
  async function resolveHeadOwner(
    workspacePath: string,
    branch: string,
    remoteUrlByName: Map<string, string>,
  ): Promise<string | null> {
    const remoteName =
      (await readGitConfigValue(workspacePath, `branch.${branch}.pushRemote`)) ??
      (await readGitConfigValue(workspacePath, "remote.pushDefault")) ??
      (await readGitConfigValue(workspacePath, `branch.${branch}.remote`)) ??
      "origin";
    const url = remoteUrlByName.get(remoteName) ?? (await readRemoteUrl(workspacePath, remoteName));
    if (!url) {
      return null;
    }
    return gitRemoteUrlToRepository(url)?.owner ?? null;
  }

  async function readGhDefaultRepository(workspacePath: string): Promise<BaseRepository | null> {
    const result = await options.gh.run({
      cwd: workspacePath,
      args: ["repo", "set-default", "--view"],
    });
    if (result.timedOut) {
      return null;
    }
    const match = result.stdout.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*$/m);
    if (!match || !match[1] || !match[2]) {
      return null;
    }
    return { host: "github.com", owner: match[1], name: match[2] };
  }

  async function resolveWorkspaceContext(
    workspaceKey: string,
    workspacePath: string,
  ): Promise<WorkspaceContext> {
    const cached = contextByWorkspace.get(workspaceKey);
    if (cached && now() - cached.checkedAtMs < AVAILABILITY_TTL_MS) {
      return cached;
    }

    const ghBinary = await options.gh.resolveGhBinary();
    if (!ghBinary) {
      const context: WorkspaceContext = {
        state: "no_gh",
        checkedAtMs: now(),
        baseRepositories: [],
        remoteUrlByName: new Map(),
      };
      contextByWorkspace.set(workspaceKey, context);
      warnOnce(workspaceKey, "no_gh", "gh binary not found; session pull request status disabled");
      return context;
    }

    // Reason: without --hostname, gh exits non-zero when any configured host (e.g. GHE) has a
    // bad token, which would disable GitHub.com PR status for a valid github.com login.
    const auth = await options.gh.run({
      cwd: workspacePath,
      args: ["auth", "status", "--hostname", "github.com"],
    });
    if (auth.exitCode !== 0 || auth.timedOut) {
      const context: WorkspaceContext = {
        state: "auth",
        checkedAtMs: now(),
        baseRepositories: [],
        remoteUrlByName: new Map(),
      };
      contextByWorkspace.set(workspaceKey, context);
      warnOnce(
        workspaceKey,
        "auth",
        "gh is not authenticated; session pull request status disabled",
      );
      return context;
    }

    const remotes = await options.repo.getRepositoryRemotes(workspacePath);
    const remoteUrlByName = new Map<string, string>();
    const githubRepositories: BaseRepository[] = [];
    for (const remote of remotes.remotes) {
      remoteUrlByName.set(remote.name, remote.url);
      const repository = gitRemoteUrlToRepository(remote.url);
      if (repository && repository.host === "github.com") {
        githubRepositories.push({
          host: repository.host,
          owner: repository.owner,
          name: repository.name,
        });
      }
    }
    if (!remotes.isRepository || githubRepositories.length === 0) {
      const context: WorkspaceContext = {
        state: "not_github",
        checkedAtMs: now(),
        baseRepositories: [],
        remoteUrlByName: new Map(),
      };
      contextByWorkspace.set(workspaceKey, context);
      return context;
    }

    // gh is never asked to guess the repository: the gh default when set,
    // otherwise every distinct GitHub remote repository (fork workflows).
    const defaultRepository = await readGhDefaultRepository(workspacePath);
    const distinct: BaseRepository[] = [];
    const seen = new Set<string>();
    for (const repository of defaultRepository
      ? [defaultRepository, ...githubRepositories]
      : githubRepositories) {
      // Reason: GitHub owner and repository names are case-insensitive; differently cased remotes
      // are the same repository and must not produce duplicate jobs or PRs.
      const id = `${repository.owner}/${repository.name}`.toLowerCase();
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      distinct.push(repository);
    }

    const context: WorkspaceContext = {
      state: "available",
      checkedAtMs: now(),
      baseRepositories: defaultRepository ? distinct.slice(0, 1) : distinct,
      remoteUrlByName,
    };
    contextByWorkspace.set(workspaceKey, context);
    return context;
  }

  async function runGraphqlBatch(
    workspacePath: string,
    repository: BaseRepository,
    branches: string[],
    onLowRemaining: (resetAt: string | null) => void,
  ): Promise<{
    outcome: "nodes" | "error" | "rate_limited";
    nodesByBranch: Map<string, LabeledNode[]>;
    resetAt: string | null;
  }> {
    const query = buildSessionPullRequestsQuery(branches.length);
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${repository.owner}`,
      "-f",
      `name=${repository.name}`,
      ...branches.flatMap((branch, index) => ["-f", `b${index}=${branch}`]),
    ];
    const result = await options.gh.run({ cwd: workspacePath, args, hostname: repository.host });
    logger.debug(undefined, "session pull requests gh graphql", {
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
    });
    if (result.timedOut) {
      return { outcome: "error", nodesByBranch: new Map(), resetAt: null };
    }
    // gh exits non-zero for GraphQL errors (including RATE_LIMITED) but still prints the
    // response body, so the error classification must read stdout before the exit code.
    const parsed = parseGhGraphqlResponse(result.stdout);
    if (!parsed) {
      return { outcome: "error", nodesByBranch: new Map(), resetAt: null };
    }
    const rateLimitInfo = parsed.data?.rateLimit ?? null;
    const errors = parsed.errors ?? [];
    const rateLimitedError = errors.some((error) => error.type === "RATE_LIMITED");
    if (rateLimitedError) {
      const resetAt = rateLimitInfo?.resetAt ?? null;
      return { outcome: "rate_limited", nodesByBranch: new Map(), resetAt };
    }
    if (result.exitCode !== 0 || errors.length > 0 || !parsed.data?.repository) {
      return { outcome: "error", nodesByBranch: new Map(), resetAt: null };
    }
    if (
      !rateLimitedError &&
      typeof rateLimitInfo?.remaining === "number" &&
      rateLimitInfo.remaining < RATE_LIMIT_MIN_REMAINING
    ) {
      // Data still arrived; consume it and back off the next requests.
      onLowRemaining(rateLimitInfo.resetAt ?? null);
    }
    const repositoryLabel = `${repository.owner}/${repository.name}`;
    const nodesByBranch = new Map<string, LabeledNode[]>();
    branches.forEach((branch, index) => {
      const nodes = (parsed.data?.repository?.[`b${index}`]?.nodes ??
        []) as GraphqlPullRequestNode[];
      nodesByBranch.set(
        branch,
        nodes.map((node) => ({ repositoryLabel, node })),
      );
    });
    return { outcome: "nodes", nodesByBranch, resetAt: null };
  }

  return { resolveWorkspaceContext, resolveHeadOwner, runGraphqlBatch };
}
