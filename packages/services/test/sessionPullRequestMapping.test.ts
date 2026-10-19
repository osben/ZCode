import assert from "assert/strict";
import test from "node:test";
import type { GraphqlPullRequestNode } from "../src/git/sessionPullRequestMapping.js";
import {
  buildSessionPullRequestsQuery,
  mapGraphqlPullRequest,
  parseGhGraphqlResponse,
  sessionPullRequestsTtlTier,
  sortSessionPullRequests,
} from "../src/git/sessionPullRequestMapping.js";

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
    additions: 1,
    deletions: 2,
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

function rollup(nodes: Array<Record<string, unknown>>): GraphqlPullRequestNode["commits"] {
  return {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: { totalCount: nodes.length, nodes: nodes as never },
          },
        },
      },
    ],
  };
}

test("mapGraphqlPullRequest maps lifecycle stages and review decisions", () => {
  const open = mapGraphqlPullRequest(makeNode(), "osben/ZCode");
  assert.equal(open?.stage, "open");
  assert.equal(open?.repository, "osben/ZCode");
  assert.equal(open?.reviewDecision, null);
  assert.equal(open?.mergedAt, null);

  const draft = mapGraphqlPullRequest(makeNode({ isDraft: true }), "osben/ZCode");
  assert.equal(draft?.stage, "draft");

  const merged = mapGraphqlPullRequest(
    makeNode({ state: "MERGED", mergedAt: "2026-10-18T11:00:00Z" }),
    "osben/ZCode",
  );
  assert.equal(merged?.stage, "merged");
  assert.equal(merged?.mergedAt, "2026-10-18T11:00:00Z");

  const closed = mapGraphqlPullRequest(makeNode({ state: "CLOSED" }), "osben/ZCode");
  assert.equal(closed?.stage, "closed");

  const approved = mapGraphqlPullRequest(makeNode({ reviewDecision: "APPROVED" }), "osben/ZCode");
  assert.equal(approved?.reviewDecision, "approved");
  const changes = mapGraphqlPullRequest(
    makeNode({ reviewDecision: "CHANGES_REQUESTED" }),
    "osben/ZCode",
  );
  assert.equal(changes?.reviewDecision, "changes_requested");
  const required = mapGraphqlPullRequest(
    makeNode({ reviewDecision: "REVIEW_REQUIRED" }),
    "osben/ZCode",
  );
  assert.equal(required?.reviewDecision, "review_required");

  assert.equal(mapGraphqlPullRequest(makeNode({ state: "WEIRD" }), "osben/ZCode"), null);
});

test("checks mapping: failing conclusions, optional-only via UNSTABLE, running, passing, none", () => {
  const failing = mapGraphqlPullRequest(
    makeNode({
      mergeStateStatus: "BLOCKED",
      commits: rollup([
        { conclusion: "SUCCESS", status: "COMPLETED" },
        { conclusion: "FAILURE", status: "COMPLETED" },
      ]),
    }),
    "r",
  );
  assert.equal(failing?.checks, "failing");
  assert.equal(failing?.failingCheckCount, 1);
  assert.equal(failing?.totalCheckCount, 2);

  for (const conclusion of ["ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]) {
    const mapped = mapGraphqlPullRequest(
      makeNode({ commits: rollup([{ conclusion, status: "COMPLETED" }]) }),
      "r",
    );
    assert.equal(mapped?.checks, "failing", `${conclusion} counts as failing`);
  }

  const statusContextFailure = mapGraphqlPullRequest(
    makeNode({ commits: rollup([{ state: "FAILURE" }]) }),
    "r",
  );
  assert.equal(statusContextFailure?.checks, "failing");
  const statusContextError = mapGraphqlPullRequest(
    makeNode({ commits: rollup([{ state: "ERROR" }]) }),
    "r",
  );
  assert.equal(statusContextError?.checks, "failing");

  // Same failing conclusions, but all failing checks are non-required.
  const optionalOnly = mapGraphqlPullRequest(
    makeNode({
      mergeStateStatus: "UNSTABLE",
      commits: rollup([{ conclusion: "FAILURE", status: "COMPLETED" }]),
    }),
    "r",
  );
  assert.equal(optionalOnly?.checks, "optional_failing");

  const running = mapGraphqlPullRequest(
    makeNode({
      commits: rollup([
        { conclusion: "SUCCESS", status: "COMPLETED" },
        { conclusion: null, status: "IN_PROGRESS" },
        { state: "PENDING" },
      ]),
    }),
    "r",
  );
  assert.equal(running?.checks, "running");

  const queued = mapGraphqlPullRequest(
    makeNode({ commits: rollup([{ conclusion: null, status: "QUEUED" }]) }),
    "r",
  );
  assert.equal(queued?.checks, "running");
  const expected = mapGraphqlPullRequest(
    makeNode({ commits: rollup([{ state: "EXPECTED" }]) }),
    "r",
  );
  assert.equal(expected?.checks, "running");

  const passing = mapGraphqlPullRequest(
    makeNode({ commits: rollup([{ conclusion: "SUCCESS", status: "COMPLETED" }]) }),
    "r",
  );
  assert.equal(passing?.checks, "passing");

  const skipped = mapGraphqlPullRequest(
    makeNode({ commits: rollup([{ conclusion: "SKIPPED", status: "COMPLETED" }]) }),
    "r",
  );
  assert.equal(skipped?.checks, "passing");

  const none = mapGraphqlPullRequest(makeNode(), "r");
  assert.equal(none?.checks, "none");
  assert.equal(none?.totalCheckCount, 0);
});

test("mapGraphqlPullRequest maps conflicts from mergeable", () => {
  const conflicting = mapGraphqlPullRequest(makeNode({ mergeable: "CONFLICTING" }), "r");
  assert.equal(conflicting?.hasConflict, true);
  const mergeable = mapGraphqlPullRequest(makeNode({ mergeable: "UNKNOWN" }), "r");
  assert.equal(mergeable?.hasConflict, false);
});

test("sorting and primary selection: open > draft > merged > closed, ties by newest", () => {
  const merged = makeNode({ number: 10, state: "MERGED", mergedAt: "2026-10-01T00:00:00Z" });
  const openOld = makeNode({ number: 11, updatedAt: "2026-10-10T00:00:00Z" });
  const openNew = makeNode({ number: 12, updatedAt: "2026-10-18T00:00:00Z" });
  const draft = makeNode({ number: 13, isDraft: true });
  const closed = makeNode({ number: 14, state: "CLOSED" });

  const pullRequests = [closed, merged, draft, openOld, openNew]
    .map((node) => mapGraphqlPullRequest(node, "r"))
    .filter((value) => value !== null);
  const sorted = sortSessionPullRequests(pullRequests);
  assert.deepEqual(
    sorted.map((pullRequest) => pullRequest.number),
    [12, 11, 13, 10, 14],
  );
  assert.deepEqual(sortSessionPullRequests([]), []);
});

test("TTL tier follows open/draft presence", () => {
  const open = mapGraphqlPullRequest(makeNode(), "r")!;
  const draft = mapGraphqlPullRequest(makeNode({ isDraft: true }), "r")!;
  const merged = mapGraphqlPullRequest(makeNode({ state: "MERGED" }), "r")!;
  assert.equal(sessionPullRequestsTtlTier([open, merged]), "active");
  assert.equal(sessionPullRequestsTtlTier([draft]), "active");
  assert.equal(sessionPullRequestsTtlTier([merged]), "settled");
  assert.equal(sessionPullRequestsTtlTier([]), "none");
});

test("query builder keeps branch names out of the query text", () => {
  const query = buildSessionPullRequestsQuery(2);
  assert.match(query, /query \(\$owner: String!, \$name: String!, \$b0: String!, \$b1: String!\)/);
  assert.match(query, /b0: pullRequests\(headRefName: \$b0/);
  assert.match(query, /b1: pullRequests\(headRefName: \$b1/);
  assert.match(query, /fragment Pr on PullRequest/);
  assert.match(query, /mergeStateStatus/);
  assert.match(query, /rateLimit \{ remaining resetAt \}/);
  assert.ok(!query.includes("feat/x"), "branch names never appear in the query text");
});

test("parseGhGraphqlResponse rejects non-JSON payloads", () => {
  const parsed = parseGhGraphqlResponse('{"data":{"repository":{}}}');
  assert.equal(parsed?.data?.repository !== null, true);
  assert.equal(parseGhGraphqlResponse("not json"), null);
  assert.equal(parseGhGraphqlResponse("null"), null);
});
