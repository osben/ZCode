import type {
  GitRepositoryRemotesResult,
  SessionPullRequest,
  SessionPullRequestsRequest,
  SessionPullRequestsResult,
  SessionPullRequestStatus,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { GhCommandProvider } from "./providers/ghCommandProvider.js";
import {
  mapGraphqlPullRequest,
  sessionPullRequestsTtlTier,
  sortSessionPullRequests,
} from "./sessionPullRequestMapping.js";
import {
  assembleBranchStatus,
  logStageChanges,
  unavailableStatus,
} from "./sessionPullRequestsStatus.js";
import {
  createSessionPullRequestsLookup,
  type BaseRepository,
  type LabeledNode,
  type WorkspaceContext,
} from "./sessionPullRequestsLookup.js";

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
const ERROR_RETRY_DELAY_MS = 60_000;
const COALESCE_WINDOW_MS = 250;
const CHUNK_SIZE = 25;
const MAX_CONCURRENT_BATCHES = 4;
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
}

interface InFlightBranch {
  generation: number;
  promise: Promise<void>;
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
  const warnedClasses = new Set<string>();
  let rateLimit: { untilMs: number; resetAt: string | null; consecutive: number } | null = null;
  const lookup = createSessionPullRequestsLookup({
    repo: options.repo,
    gitRunner: options.gitRunner,
    gh: options.gh,
    logger,
    now,
    warnOnce,
  });
  const { resolveWorkspaceContext, resolveHeadOwner, runGraphqlBatch } = lookup;

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
    if (now() < entry.retryNotBeforeMs) {
      // A failed refresh keeps the previous value stale until the retry delay passes.
      return true;
    }
    if (entry.state === "ready") {
      return now() - entry.fetchedAtMs < entryTtlMs(entry);
    }
    if (entry.state === "rate_limited") {
      return false;
    }
    return false;
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
      const ownerByBranch = new Map<string, string | null>(
        await Promise.all(
          branches.map(
            async (branch) =>
              [
                branch,
                await resolveHeadOwner(workspacePath, branch, context.remoteUrlByName),
              ] as const,
          ),
        ),
      );

      const jobs: Array<{ repository: BaseRepository; branches: string[] }> = [];
      for (const repository of context.baseRepositories) {
        for (let index = 0; index < branches.length; index += chunkSize) {
          jobs.push({ repository, branches: branches.slice(index, index + chunkSize) });
        }
      }

      type BranchAggregate = {
        labeledNodes: LabeledNode[];
        successCount: number;
        expectedBatches: number;
        rateLimited: boolean;
      };
      const aggregateByBranch = new Map<string, BranchAggregate>(
        branches.map((branch) => [
          branch,
          {
            labeledNodes: [],
            successCount: 0,
            expectedBatches: jobs.filter((job) => job.branches.includes(branch)).length,
            rateLimited: false,
          },
        ]),
      );

      let cursor = 0;
      const workerCount = Math.min(maxConcurrentBatches, Math.max(jobs.length, 1));
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor]!;
          cursor += 1;
          // Reason: the GraphQL quota is shared per token, so one rate-limit signal invalidates
          // the rest of the flush. Skipped branches are marked rate limited, not failed.
          if (rateLimitActive()) {
            for (const branch of job.branches) {
              const aggregate = aggregateByBranch.get(branch);
              if (aggregate) {
                aggregate.rateLimited = true;
              }
            }
            continue;
          }
          const batch = await runGraphqlBatch(
            workspacePath,
            job.repository,
            job.branches,
            enterRateLimit,
          );
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
        // Reason: a partial aggregate (one repository batch failed or was rate limited) would
        // drop that repository's PRs and present the gap as fresh data. Replace the cache only
        // when every batch for the branch succeeded; otherwise the previous entry stays stale.
        if (
          aggregate &&
          aggregate.expectedBatches > 0 &&
          aggregate.successCount === aggregate.expectedBatches
        ) {
          const headOwner = ownerByBranch.get(branch) ?? null;
          const pullRequests = sortSessionPullRequests(
            aggregate.labeledNodes
              // A contributor fork may reuse the same branch name; only PRs pushed
              // by the branch's head owner belong to this session (spec scenario 8).
              .filter(
                (labeled) =>
                  headOwner !== null &&
                  labeled.node.headRepositoryOwner?.login != null &&
                  labeled.node.headRepositoryOwner.login.toLowerCase() === headOwner.toLowerCase(),
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
          logStageChanges(logger, previous?.pullRequests ?? [], pullRequests);
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
            branchEntries.set(key, {
              ...previous,
              stale: true,
              retryNotBeforeMs: timestamp + ERROR_RETRY_DELAY_MS,
            });
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
          // No detail: branch names are user data and must not reach warnings.
          warnOnce(workspaceKey, "gh-error", "session pull request gh call failed");
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
        let rejectPromise!: (error: unknown) => void;
        const promise = new Promise<void>((resolve, reject) => {
          resolvePromise = resolve;
          rejectPromise = reject;
        });
        const pendingKeys = new Set<string>();
        // The window opens with the queue; branches arriving before it fires
        // join this batch, later ones start the next queue.
        const timer = setTimeout(() => {
          queueByWorkspace.delete(workspaceKey);
          const keys = [...pendingKeys];
          // Reason: a flush failure must reject the awaiting requests so getSessionPullRequests
          // takes its request-error fallback. Resolving here would assemble old or empty entries
          // as if the refresh had completed, and would leave an unhandled rejection behind.
          flushBranches(workspaceKey, workspacePath, context, keys).then(
            () => resolvePromise(),
            (error: unknown) => {
              // Reason: the fallback answers from the cache, so cached branches must be marked
              // stale and held back for the retry delay; otherwise the next request re-probes at once.
              const retryNotBeforeMs = now() + ERROR_RETRY_DELAY_MS;
              for (const key of keys) {
                const previous = branchEntries.get(key);
                if (previous) {
                  branchEntries.set(key, { ...previous, stale: true, retryNotBeforeMs });
                }
              }
              rejectPromise(error);
            },
          );
        }, coalesceWindowMs);
        timer.unref?.();
        queue = { cacheKeys: pendingKeys, promise };
        queueByWorkspace.set(workspaceKey, queue);
      }
      queue.cacheKeys.add(key);
      awaited.push(queue.promise);
    }
    await Promise.all(awaited);
  }

  function assembleTaskStatus(workspaceKey: string, branches: string[]): SessionPullRequestStatus {
    const entries = branches
      .map((branch) => branchEntries.get(cacheKey(workspaceKey, branch)))
      .filter((entry): entry is BranchEntry => entry !== undefined);
    return assembleBranchStatus(entries, rateLimitActive());
  }

  async function getSessionPullRequests(
    request: SessionPullRequestsRequest,
  ): Promise<SessionPullRequestsResult> {
    const workspaceKey = workspaceKeyOf(request);
    const forcedTaskIds = new Set(request.forceTaskIds ?? []);
    const result: SessionPullRequestsResult = {};

    try {
      // Branch set per task: persisted executionWorktree.branchName ∪ live worktree HEAD.
      const taskBranches = await Promise.all(
        request.tasks.map(async (task) => {
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
          return { taskId: task.taskId, branches: [...branches].sort() };
        }),
      );

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
      // Once per workspace and failure class, like the other gh failures. Only the error class
      // is logged: messages can embed workspace paths or remote URLs.
      warnOnce(workspaceKey, "request-error", "session pull requests request failed", {
        errorName: error instanceof Error ? error.name : "unknown",
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
