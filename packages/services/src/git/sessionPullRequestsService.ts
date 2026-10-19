import type {
  GitRepositoryRemotesResult,
  SessionPullRequest,
  SessionPullRequestsRequest,
  SessionPullRequestsResult,
  SessionPullRequestStatus,
} from "@zcode/shared";
import { gitRemoteUrlToRepository } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { GhCommandProvider } from "./providers/ghCommandProvider.js";
import {
  buildSessionPullRequestsQuery,
  mapGraphqlPullRequest,
  parseGhGraphqlResponse,
  sessionPullRequestsTtlTier,
  sortSessionPullRequests,
  type GraphqlPullRequestNode,
} from "./sessionPullRequestMapping.js";

/**
 * Task-level pull request status service (specs/sidebar-pr-status.md).
 *
 * The UI sends one request per workspace carrying that workspace's worktree
 * tasks; this service batches all stale branches into one `gh api graphql`
 * call per base repository, caches per (workspace identity + branch) with
 * stage-dependent TTLs, and never persists anything.
 */
/* eslint-disable max-lines -- cache + coalescing + rate limiting form one state machine; splitting it would pass six maps between modules. */

const CACHE_KEY_SEPARATOR = "\u0000";

const TTL_ACTIVE_MS = 60_000;
const TTL_NONE_MS = 10 * 60_000;
const TTL_SETTLED_MS = 30 * 60_000;
const AVAILABILITY_TTL_MS = 10 * 60_000;
const ERROR_RETRY_DELAY_MS = 60_000;
const COALESCE_WINDOW_MS = 250;
const CHUNK_SIZE = 25;
const MAX_CONCURRENT_BATCHES = 4;
const RATE_LIMIT_MIN_REMAINING = 100;
// Exponential backoff 2 → 32 min when resetAt is unknown.
const RATE_LIMIT_BACKOFF_STEPS_MS = [2, 4, 8, 16, 32].map((minutes) => minutes * 60_000);

export interface SessionPullRequestsRepo {
  getRepositoryRemotes(workspacePath: string): Promise<GitRepositoryRemotesResult>;
  readHeadBranch(workspacePath: string): Promise<string | null>;
}

export interface SessionPullRequestsGitRunner {
  run(options: {
    cwd: string;
    args: string[];
    timeoutMs?: number;
  }): Promise<{ exitCode: number | null; stdout: string; timedOut: boolean }>;
}

interface BaseRepository {
  host: string;
  owner: string;
  name: string;
}

interface WorkspaceContext {
  state: "available" | "no_gh" | "auth" | "not_github";
  checkedAtMs: number;
  baseRepositories: BaseRepository[];
  remoteUrlByName: Map<string, string>;
}

interface BranchEntry {
  state: "ready" | "unavailable" | "rate_limited";
  unavailableReason: "no_gh" | "auth" | "not_github" | "error" | null;
  pullRequests: SessionPullRequest[];
  fetchedAtMs: number;
  stale: boolean;
  /** Next time a failed probe may be retried; keeps outages from probing on every request. */
  retryNotBeforeMs: number;
}

interface CoalesceQueue {
  cacheKeys: Set<string>;
  promise: Promise<void>;
  resolve: () => void;
}

interface InFlightBranch {
  generation: number;
  promise: Promise<void>;
}

/** One GraphQL node with the label of the base repository it was queried from. */
interface LabeledNode {
  repositoryLabel: string;
  node: GraphqlPullRequestNode;
}

export interface SessionPullRequestsService {
  getSessionPullRequests(request: SessionPullRequestsRequest): Promise<SessionPullRequestsResult>;
}

export function createSessionPullRequestsService(options: {
  repo: SessionPullRequestsRepo;
  gitRunner: SessionPullRequestsGitRunner;
  gh: GhCommandProvider;
  logger?: ServiceLogger;
  now?: () => number;
  coalesceWindowMs?: number;
  chunkSize?: number;
  maxConcurrentBatches?: number;
}): SessionPullRequestsService {
  const logger = options.logger ?? createServiceLogger("session-pull-requests");
  const now = options.now ?? Date.now;
  const coalesceWindowMs = options.coalesceWindowMs ?? COALESCE_WINDOW_MS;
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const maxConcurrentBatches = options.maxConcurrentBatches ?? MAX_CONCURRENT_BATCHES;

  const branchEntries = new Map<string, BranchEntry>();
  // Bugfix pattern from branchMergeStatus: a probe waiting on `gh` must not
  // repopulate an entry that was force-invalidated while the probe was in
  // flight (turn end right after a push). Generation is snapshotted when a
  // flush starts; writes require an unchanged generation.
  const generationByKey = new Map<string, number>();
  const inflightByBranch = new Map<string, InFlightBranch>();
  const queueByWorkspace = new Map<string, CoalesceQueue>();
  const contextByWorkspace = new Map<string, WorkspaceContext>();
  const warnedClasses = new Set<string>();
  let rateLimit: { untilMs: number; resetAt: string | null; consecutive: number } | null = null;

  function cacheKey(workspaceKey: string, branch: string): string {
    return `${workspaceKey}${CACHE_KEY_SEPARATOR}${branch}`;
  }

  function branchOfCacheKey(key: string): string {
    const separatorIndex = key.indexOf(CACHE_KEY_SEPARATOR);
    return key.slice(separatorIndex + CACHE_KEY_SEPARATOR.length);
  }

  function workspaceKeyOf(request: { workspacePath: string; workspaceIdentity?: string }): string {
    return request.workspaceIdentity?.trim() || request.workspacePath;
  }

  function warnOnce(
    workspaceKey: string,
    className: string,
    message: string,
    detail?: unknown,
  ): void {
    const warnKey = `${workspaceKey}${CACHE_KEY_SEPARATOR}${className}`;
    if (warnedClasses.has(warnKey)) {
      return;
    }
    warnedClasses.add(warnKey);
    logger.warn(undefined, message, detail);
  }

  function rateLimitActive(): boolean {
    return rateLimit !== null && now() < rateLimit.untilMs;
  }

  function enterRateLimit(resetAt: string | null): void {
    if (resetAt !== null) {
      const resetAtMs = Date.parse(resetAt);
      rateLimit = {
        untilMs: Number.isFinite(resetAtMs) ? resetAtMs : now() + RATE_LIMIT_BACKOFF_STEPS_MS[0]!,
        resetAt,
        consecutive: 0,
      };
      return;
    }
    const consecutive = (rateLimit?.consecutive ?? 0) + 1;
    const backoffMs =
      RATE_LIMIT_BACKOFF_STEPS_MS[
        Math.min(consecutive - 1, RATE_LIMIT_BACKOFF_STEPS_MS.length - 1)
      ]!;
    rateLimit = { untilMs: now() + backoffMs, resetAt: null, consecutive };
  }

  function entryTtlMs(entry: BranchEntry): number {
    if (entry.state !== "ready") {
      return 0;
    }
    const tier = sessionPullRequestsTtlTier(entry.pullRequests);
    if (tier === "active") {
      return TTL_ACTIVE_MS;
    }
    return tier === "none" ? TTL_NONE_MS : TTL_SETTLED_MS;
  }

  /** true when the entry can be served without scheduling a refresh. */
  function entryServedWithoutRefresh(entry: BranchEntry | undefined, forced: boolean): boolean {
    if (forced || !entry) {
      return false;
    }
    if (rateLimitActive()) {
      // During backoff the last value is served with stale: true; no requests.
      return true;
    }
    if (entry.state === "ready") {
      return now() - entry.fetchedAtMs < entryTtlMs(entry);
    }
    if (entry.state === "rate_limited") {
      return false;
    }
    return now() < entry.retryNotBeforeMs;
  }

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

    const auth = await options.gh.run({ cwd: workspacePath, args: ["auth", "status"] });
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
      const id = `${repository.owner}/${repository.name}`;
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
    if (result.exitCode !== 0 || result.timedOut) {
      return { outcome: "error", nodesByBranch: new Map(), resetAt: null };
    }
    const parsed = parseGhGraphqlResponse(result.stdout);
    if (!parsed) {
      return { outcome: "error", nodesByBranch: new Map(), resetAt: null };
    }
    const rateLimitInfo = parsed.data?.rateLimit ?? null;
    const rateLimitedError = parsed.errors?.some((error) => error.type === "RATE_LIMITED") ?? false;
    if (rateLimitedError && !parsed.data?.repository) {
      const resetAt = rateLimitInfo?.resetAt ?? null;
      return { outcome: "rate_limited", nodesByBranch: new Map(), resetAt };
    }
    if (
      !rateLimitedError &&
      typeof rateLimitInfo?.remaining === "number" &&
      rateLimitInfo.remaining < RATE_LIMIT_MIN_REMAINING
    ) {
      // Data still arrived; consume it and back off the next requests.
      enterRateLimit(rateLimitInfo.resetAt ?? null);
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

  function logStageChanges(
    workspaceKey: string,
    previous: SessionPullRequest[],
    next: SessionPullRequest[],
  ): void {
    if (previous === next) {
      return;
    }
    const previousStageById = new Map(
      previous.map((pullRequest) => [
        `${pullRequest.repository}#${pullRequest.number}`,
        pullRequest.stage,
      ]),
    );
    for (const pullRequest of next) {
      const id = `${pullRequest.repository}#${pullRequest.number}`;
      const from = previousStageById.get(id) ?? null;
      if (from !== pullRequest.stage) {
        logger.info(undefined, "session pull request stage changed", {
          workspaceKey,
          repository: pullRequest.repository,
          number: pullRequest.number,
          from,
          to: pullRequest.stage,
        });
      }
    }
  }

  async function flushBranches(
    workspaceKey: string,
    workspacePath: string,
    context: WorkspaceContext,
    cacheKeys: string[],
  ): Promise<void> {
    // Snapshot generations and register in-flight bookkeeping before the first
    // await so a concurrent forced invalidation is already visible to it.
    const generationSnapshot = new Map<string, number>();
    const doneResolvers: Array<() => void> = [];
    for (const key of cacheKeys) {
      const generation = generationByKey.get(key) ?? 0;
      generationSnapshot.set(key, generation);
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      inflightByBranch.set(key, { generation, promise: done });
      doneResolvers.push(resolveDone);
    }

    try {
      const branches = [...new Set(cacheKeys.map(branchOfCacheKey))].sort();
      const ownerByBranch = new Map<string, string | null>();
      for (const branch of branches) {
        ownerByBranch.set(
          branch,
          await resolveHeadOwner(workspacePath, branch, context.remoteUrlByName),
        );
      }

      const jobs: Array<{ repository: BaseRepository; branches: string[] }> = [];
      for (const repository of context.baseRepositories) {
        for (let index = 0; index < branches.length; index += chunkSize) {
          jobs.push({ repository, branches: branches.slice(index, index + chunkSize) });
        }
      }

      type BranchAggregate = {
        labeledNodes: LabeledNode[];
        successCount: number;
        rateLimited: boolean;
      };
      const aggregateByBranch = new Map<string, BranchAggregate>(
        branches.map((branch) => [
          branch,
          { labeledNodes: [], successCount: 0, rateLimited: false },
        ]),
      );

      let cursor = 0;
      const workerCount = Math.min(maxConcurrentBatches, Math.max(jobs.length, 1));
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor]!;
          cursor += 1;
          const batch = await runGraphqlBatch(workspacePath, job.repository, job.branches);
          if (batch.outcome === "rate_limited") {
            enterRateLimit(batch.resetAt);
          }
          for (const branch of job.branches) {
            const aggregate = aggregateByBranch.get(branch);
            if (!aggregate) {
              continue;
            }
            if (batch.outcome === "nodes") {
              aggregate.successCount += 1;
              aggregate.labeledNodes.push(...(batch.nodesByBranch.get(branch) ?? []));
            } else if (batch.outcome === "rate_limited") {
              aggregate.rateLimited = true;
            }
          }
        }
      });
      await Promise.all(workers);

      const timestamp = now();
      for (const key of cacheKeys) {
        if ((generationByKey.get(key) ?? 0) !== generationSnapshot.get(key)) {
          continue; // invalidated while in flight; the forced flow re-probes
        }
        const branch = branchOfCacheKey(key);
        const aggregate = aggregateByBranch.get(branch);
        const previous = branchEntries.get(key);
        if (aggregate && aggregate.successCount > 0) {
          const headOwner = ownerByBranch.get(branch) ?? null;
          const pullRequests = sortSessionPullRequests(
            aggregate.labeledNodes
              // A contributor fork may reuse the same branch name; only PRs pushed
              // by the branch's head owner belong to this session (spec scenario 8).
              .filter(
                (labeled) =>
                  headOwner !== null &&
                  labeled.node.headRepositoryOwner?.login != null &&
                  labeled.node.headRepositoryOwner.login === headOwner,
              )
              .map((labeled) => mapGraphqlPullRequest(labeled.node, labeled.repositoryLabel))
              .filter((pullRequest): pullRequest is SessionPullRequest => pullRequest !== null),
          );
          branchEntries.set(key, {
            state: "ready",
            unavailableReason: null,
            pullRequests,
            fetchedAtMs: timestamp,
            stale: false,
            retryNotBeforeMs: 0,
          });
          logStageChanges(workspaceKey, previous?.pullRequests ?? [], pullRequests);
        } else if (aggregate?.rateLimited) {
          if (previous) {
            branchEntries.set(key, { ...previous, stale: true });
          } else {
            branchEntries.set(key, {
              state: "rate_limited",
              unavailableReason: null,
              pullRequests: [],
              fetchedAtMs: 0,
              stale: false,
              retryNotBeforeMs: 0,
            });
          }
        } else {
          if (previous) {
            branchEntries.set(key, { ...previous, stale: true });
          } else {
            branchEntries.set(key, {
              state: "unavailable",
              unavailableReason: "error",
              pullRequests: [],
              fetchedAtMs: 0,
              stale: false,
              retryNotBeforeMs: timestamp + ERROR_RETRY_DELAY_MS,
            });
          }
          warnOnce(workspaceKey, "gh-error", "session pull request gh call failed", { branch });
        }
      }
    } finally {
      for (const key of cacheKeys) {
        if (inflightByBranch.get(key)?.generation === generationSnapshot.get(key)) {
          inflightByBranch.delete(key);
        }
      }
      for (const resolveDone of doneResolvers) {
        resolveDone();
      }
    }
  }

  /** Coalesce refreshes: requests within the window join one batch per workspace. */
  async function scheduleRefresh(
    workspaceKey: string,
    workspacePath: string,
    context: WorkspaceContext,
    cacheKeys: Iterable<string>,
  ): Promise<void> {
    const awaited: Array<Promise<void>> = [];
    for (const key of cacheKeys) {
      const inflight = inflightByBranch.get(key);
      if (inflight && inflight.generation === (generationByKey.get(key) ?? 0)) {
        awaited.push(inflight.promise);
        continue;
      }
      let queue = queueByWorkspace.get(workspaceKey);
      if (!queue) {
        let resolvePromise!: () => void;
        const promise = new Promise<void>((resolve) => {
          resolvePromise = resolve;
        });
        const pendingKeys = new Set<string>();
        // The window opens with the queue; branches arriving before it fires
        // join this batch, later ones start the next queue.
        const timer = setTimeout(() => {
          queueByWorkspace.delete(workspaceKey);
          const keys = [...pendingKeys];
          void flushBranches(workspaceKey, workspacePath, context, keys).finally(() => {
            resolvePromise();
          });
        }, coalesceWindowMs);
        timer.unref?.();
        queue = { cacheKeys: pendingKeys, promise, resolve: resolvePromise };
        queueByWorkspace.set(workspaceKey, queue);
      }
      queue.cacheKeys.add(key);
      awaited.push(queue.promise);
    }
    await Promise.all(awaited);
  }

  function unavailableStatus(
    unavailableReason: "no_gh" | "auth" | "not_github" | "error",
  ): SessionPullRequestStatus {
    return {
      state: "unavailable",
      unavailableReason,
      source: "branch",
      pullRequests: [],
      primaryNumber: null,
      fetchedAt: null,
      stale: false,
    };
  }

  function assembleTaskStatus(workspaceKey: string, branches: string[]): SessionPullRequestStatus {
    const servingStaleDueToRateLimit = rateLimitActive();
    const entries = branches
      .map((branch) => branchEntries.get(cacheKey(workspaceKey, branch)))
      .filter((entry): entry is BranchEntry => entry !== undefined);
    const pullRequests = sortSessionPullRequests(entries.flatMap((entry) => entry.pullRequests));
    const primary = pullRequests[0] ?? null;
    const anyReady = entries.some((entry) => entry.state === "ready");
    const stale =
      entries.some((entry) => entry.stale) ||
      (servingStaleDueToRateLimit && pullRequests.length > 0);
    const fetchedAtMs =
      entries.length > 0 ? Math.max(...entries.map((entry) => entry.fetchedAtMs)) : 0;
    // A branch set with no entry at all means "never fetched": rate_limited
    // while backoff blocks the refresh, otherwise a plain empty ready state.
    let state: SessionPullRequestStatus["state"] = "ready";
    if (entries.length === 0) {
      state = servingStaleDueToRateLimit ? "rate_limited" : "ready";
    } else if (!anyReady) {
      state = entries.every((entry) => entry.state === "rate_limited")
        ? "rate_limited"
        : "unavailable";
    }
    return {
      state,
      unavailableReason:
        state === "unavailable"
          ? (entries.find((entry) => entry.unavailableReason !== null)?.unavailableReason ??
            "error")
          : null,
      source: "branch",
      pullRequests,
      primaryNumber: primary?.number ?? null,
      fetchedAt: fetchedAtMs > 0 ? new Date(fetchedAtMs).toISOString() : null,
      stale,
    };
  }

  async function getSessionPullRequests(
    request: SessionPullRequestsRequest,
  ): Promise<SessionPullRequestsResult> {
    const workspaceKey = workspaceKeyOf(request);
    const forcedTaskIds = new Set(request.forceTaskIds ?? []);
    const result: SessionPullRequestsResult = {};

    try {
      // Branch set per task: persisted executionWorktree.branchName ∪ live worktree HEAD.
      const taskBranches: Array<{ taskId: string; branches: string[] }> = [];
      for (const task of request.tasks) {
        const branches = new Set<string>();
        const persisted = task.branchName?.trim();
        if (persisted) {
          branches.add(persisted);
        }
        if (task.worktreePath) {
          const live = await options.repo.readHeadBranch(task.worktreePath);
          if (live) {
            branches.add(live);
          }
        }
        taskBranches.push({ taskId: task.taskId, branches: [...branches].sort() });
      }

      // Forced tasks bypass the TTL: bump generation first so an in-flight
      // pre-force probe can no longer repopulate their entries.
      for (const { taskId, branches } of taskBranches) {
        if (!forcedTaskIds.has(taskId)) {
          continue;
        }
        for (const branch of branches) {
          const key = cacheKey(workspaceKey, branch);
          generationByKey.set(key, (generationByKey.get(key) ?? 0) + 1);
        }
      }

      const context = await resolveWorkspaceContext(workspaceKey, request.workspacePath);
      if (context.state !== "available") {
        for (const { taskId } of taskBranches) {
          result[taskId] = unavailableStatus(context.state);
        }
        return result;
      }

      if (!rateLimitActive()) {
        const refreshKeys = new Set<string>();
        for (const { taskId, branches } of taskBranches) {
          const forced = forcedTaskIds.has(taskId);
          for (const branch of branches) {
            const key = cacheKey(workspaceKey, branch);
            if (!entryServedWithoutRefresh(branchEntries.get(key), forced)) {
              refreshKeys.add(key);
            }
          }
        }
        if (refreshKeys.size > 0) {
          await scheduleRefresh(workspaceKey, request.workspacePath, context, refreshKeys);
        }
      }

      for (const { taskId, branches } of taskBranches) {
        result[taskId] = assembleTaskStatus(workspaceKey, branches);
      }
      return result;
    } catch (error) {
      logger.warn(undefined, "session pull requests request failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      for (const task of request.tasks) {
        if (result[task.taskId] === undefined) {
          result[task.taskId] = unavailableStatus("error");
        }
      }
      return result;
    }
  }

  return { getSessionPullRequests };
}
