import type {
  PullRequestChecks,
  PullRequestStage,
  SessionPullRequest,
  SessionPullRequestReviewDecision,
} from "@zcode/shared";

/**
 * Pure mapping for the session pull request probe (specs/sidebar-pr-status.md).
 * No IO: raw `gh api graphql` payloads map to the shared contract, and selection,
 * sorting, and TTL tiers are derived here so tests cover them without network.
 */

/** Subset of the GraphQL PullRequest node the query selects. */
export interface GraphqlPullRequestNode {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  updatedAt: string;
  mergeable: string;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  headRefName: string;
  headRepositoryOwner: { login: string } | null;
  mergeStateStatus: string;
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: {
            totalCount: number;
            nodes: RollupContextNode[];
          };
        } | null;
      } | null;
    } | null>;
  } | null;
}

export interface RollupContextNode {
  /** CheckRun fields. */
  conclusion?: string | null;
  status?: string | null;
  /** StatusContext field. */
  state?: string | null;
}

export interface GhGraphqlResponse {
  data?: {
    repository?: Record<string, { nodes: unknown[] } | null> | null;
    rateLimit?: { remaining: number; resetAt: string } | null;
  } | null;
  errors?: Array<{ type?: string; message?: string }>;
}

const FAILING_CHECK_RUN_CONCLUSIONS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
]);
const FAILING_STATUS_CONTEXT_STATES = new Set(["FAILURE", "ERROR"]);
const RUNNING_CHECK_RUN_STATUSES = new Set(["QUEUED", "IN_PROGRESS"]);
const RUNNING_STATUS_CONTEXT_STATES = new Set(["PENDING", "EXPECTED"]);

const STAGE_RANK: Record<PullRequestStage, number> = {
  open: 0,
  draft: 1,
  merged: 2,
  closed: 3,
};

function mapStage(node: GraphqlPullRequestNode): PullRequestStage | null {
  if (node.state === "OPEN") {
    return node.isDraft ? "draft" : "open";
  }
  if (node.state === "MERGED") {
    return "merged";
  }
  if (node.state === "CLOSED") {
    return "closed";
  }
  return null;
}

function mapReviewDecision(value: string | null): SessionPullRequestReviewDecision | null {
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes_requested";
  if (value === "REVIEW_REQUIRED") return "review_required";
  return null;
}

function mapChecks(node: GraphqlPullRequestNode): {
  checks: PullRequestChecks;
  failingCheckCount: number;
  totalCheckCount: number;
} {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const contexts = rollup?.contexts?.nodes ?? [];
  const totalCount = rollup?.contexts?.totalCount ?? contexts.length;

  let failingCheckCount = 0;
  let running = false;
  for (const context of contexts) {
    const conclusion = context.conclusion ?? null;
    const status = context.status ?? null;
    const state = context.state ?? null;
    if (
      (conclusion !== null && FAILING_CHECK_RUN_CONCLUSIONS.has(conclusion)) ||
      (state !== null && FAILING_STATUS_CONTEXT_STATES.has(state))
    ) {
      failingCheckCount += 1;
      continue;
    }
    if (
      (status !== null && RUNNING_CHECK_RUN_STATUSES.has(status)) ||
      (state !== null && RUNNING_STATUS_CONTEXT_STATES.has(state))
    ) {
      running = true;
    }
  }

  // UNSTABLE means every failing check is non-required (decided 2026-10-18):
  // warning dot + "{count} optional checks failing" instead of red.
  const failingChecks: PullRequestChecks =
    node.mergeStateStatus === "UNSTABLE" ? "optional_failing" : "failing";
  if (failingCheckCount > 0) {
    return { checks: failingChecks, failingCheckCount, totalCheckCount: totalCount };
  }
  if (running) {
    return { checks: "running", failingCheckCount, totalCheckCount: totalCount };
  }
  // The first 100 contexts can omit the failing one, so the aggregate state decides what the
  // page cannot show. The count is a lower bound: at least one failing context exists.
  const aggregateState = rollup?.state ?? null;
  if (aggregateState === "FAILURE" || aggregateState === "ERROR") {
    return { checks: failingChecks, failingCheckCount: 1, totalCheckCount: totalCount };
  }
  if (aggregateState === "PENDING" || aggregateState === "EXPECTED") {
    return { checks: "running", failingCheckCount, totalCheckCount: totalCount };
  }
  // A truncated page cannot prove that the omitted contexts passed, so only SUCCESS is green.
  const truncated = totalCount > contexts.length;
  if (truncated) {
    return {
      checks: aggregateState === "SUCCESS" ? "passing" : "running",
      failingCheckCount,
      totalCheckCount: totalCount,
    };
  }
  if (contexts.length > 0 || totalCount > 0) {
    return { checks: "passing", failingCheckCount, totalCheckCount: totalCount };
  }
  return { checks: "none", failingCheckCount, totalCheckCount: totalCount };
}

/** Map one GraphQL node; null when the node is unparsable or has an unknown state. */
export function mapGraphqlPullRequest(
  node: GraphqlPullRequestNode,
  repository: string,
): SessionPullRequest | null {
  const stage = mapStage(node);
  if (stage === null) {
    return null;
  }
  const { checks, failingCheckCount, totalCheckCount } = mapChecks(node);
  return {
    number: node.number,
    url: node.url,
    title: node.title,
    repository,
    headRefName: node.headRefName,
    stage,
    checks,
    failingCheckCount,
    totalCheckCount,
    hasConflict: node.mergeable === "CONFLICTING",
    reviewDecision: mapReviewDecision(node.reviewDecision ?? null),
    additions: node.additions,
    deletions: node.deletions,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt ?? null,
  };
}

/** Sort by primary selection: open > draft > merged > closed, ties by newest updatedAt. */
export function sortSessionPullRequests(
  pullRequests: readonly SessionPullRequest[],
): SessionPullRequest[] {
  return [...pullRequests].sort(
    (a, b) =>
      STAGE_RANK[a.stage] - STAGE_RANK[b.stage] ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
      a.number - b.number,
  );
}

/** TTL tier of a branch's pull requests: 60s active, 10min none, 30min settled. */
export function sessionPullRequestsTtlTier(
  pullRequests: readonly SessionPullRequest[],
): "active" | "none" | "settled" {
  if (pullRequests.length === 0) {
    return "none";
  }
  for (const pullRequest of pullRequests) {
    if (pullRequest.stage === "open" || pullRequest.stage === "draft") {
      return "active";
    }
  }
  return "settled";
}

const queryTextByBranchCount = new Map<number, string>();

/**
 * Build the batched query: one aliased `pullRequests(headRefName: $bN)` field per branch.
 * Branch names are GraphQL variables, never interpolated into the query text.
 */
export function buildSessionPullRequestsQuery(branchCount: number): string {
  const cached = queryTextByBranchCount.get(branchCount);
  if (cached) {
    return cached;
  }
  const variableDeclarations = Array.from(
    { length: branchCount },
    (_, index) => `$b${index}: String!`,
  ).join(", ");
  const fields = Array.from({ length: branchCount }, (_, index) => {
    return `b${index}: pullRequests(headRefName: $b${index}, first: 10, states: [OPEN, MERGED, CLOSED], orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...Pr } }`;
  }).join("\n    ");
  const query = `query ($owner: String!, $name: String!${variableDeclarations ? `, ${variableDeclarations}` : ""}) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
  rateLimit { remaining resetAt }
}
fragment Pr on PullRequest {
  number url title state isDraft mergedAt updatedAt mergeable reviewDecision
  additions deletions headRefName headRepositoryOwner { login } mergeStateStatus
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state contexts(first: 100) { totalCount nodes {
      ... on CheckRun { conclusion status }
      ... on StatusContext { state }
    } }
  } } } }
}`;
  queryTextByBranchCount.set(branchCount, query);
  return query;
}

/** Parse the gh GraphQL stdout; null when the payload is not valid JSON. */
export function parseGhGraphqlResponse(stdout: string): GhGraphqlResponse | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    return parsed as GhGraphqlResponse;
  } catch {
    return null;
  }
}
