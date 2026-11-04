import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  seedProviderReadinessHistoryFixture,
  type ProviderReadinessHistoryFixture,
} from "./provider-readiness-history-fixture.js";

const execFileAsync = promisify(execFile);

export const SESSION_PR_STATUS_SESSION_ID = "sess_e2e_session_pr_status";
export const SESSION_PR_STATUS_BRANCH = "e2e/pr-status";
export const SESSION_PR_STATUS_OPEN_PR_URL = "https://github.com/e2e-fork/ZCode/pull/101";

const GITHUB_REMOTE_URL = "https://github.com/e2e-fork/ZCode.git";

/**
 * Fixture for the session pull request status spec (specs/sidebar-pr-status.md).
 *
 * Seeds, before the Host boots:
 * - a completed worktree task row (tasks-index) with `executionWorktree`, so the
 *   sidebar row, hover card, and status panel have a worktree session without
 *   driving the composer worktree flow;
 * - a github.com remote on the default workspace, so the probe resolves the
 *   base repository `e2e-fork/ZCode` and the head-owner filter keeps the fake PRs;
 * - a fake gh at the fixed ZCODE_GH_BINARY path wired in wdio.conf (POSIX only),
 *   answering `auth status` and the batched GraphQL query with a fixed payload:
 *   open PR #101 with a failing required check plus merged PR #100, both on
 *   SESSION_PR_STATUS_BRANCH. Any other branch alias resolves to no PR nodes, so
 *   the fake answers only for the branch the worktree actually has.
 */

const FAKE_GH_SCRIPT = `#!/bin/sh
# E2E-only fake gh (ZCODE_GH_BINARY). Deterministic PR payload for any branch query.
set -u
command="$1"
if [ "$command" = "--version" ] || [ "$command" = "version" ]; then
  echo "gh version 2.0.0 (e2e fake)"
  exit 0
fi
if [ "$command" = "auth" ]; then
  exit 0
fi
if [ "$command" = "repo" ]; then
  exit 1
fi
if [ "$command" != "api" ]; then
  exit 0
fi

OPEN_PR='{"number":101,"url":"https://github.com/e2e-fork/ZCode/pull/101","title":"E2E open pull request","state":"OPEN","isDraft":false,"mergedAt":null,"updatedAt":"2026-10-19T00:00:00Z","mergeable":"MERGEABLE","reviewDecision":null,"additions":10,"deletions":2,"headRefName":"${SESSION_PR_STATUS_BRANCH}","headRepositoryOwner":{"login":"e2e-fork"},"mergeStateStatus":"BLOCKED","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE","contexts":{"totalCount":2,"nodes":[{"conclusion":"FAILURE","status":"COMPLETED"},{"conclusion":"SUCCESS","status":"COMPLETED"}]}}}}]}}'
MERGED_PR='{"number":100,"url":"https://github.com/e2e-fork/ZCode/pull/100","title":"E2E merged pull request","state":"MERGED","isDraft":false,"mergedAt":"2026-10-18T00:00:00Z","updatedAt":"2026-10-18T00:00:00Z","mergeable":"UNKNOWN","reviewDecision":null,"additions":5,"deletions":1,"headRefName":"${SESSION_PR_STATUS_BRANCH}","headRepositoryOwner":{"login":"e2e-fork"},"mergeStateStatus":"UNKNOWN","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"totalCount":0,"nodes":[]}}}}]}}'

entries=""
expect_value=0
for argument in "$@"; do
  if [ "$expect_value" = "1" ]; then
    expect_value=0
    key="\${argument%%=*}"
    value="\${argument#*=}"
    case "$key" in
      b*)
        # Only the seeded branch gets PR nodes; every other alias resolves to none.
        if [ "$value" = "${SESSION_PR_STATUS_BRANCH}" ]; then
          nodes="[$OPEN_PR,$MERGED_PR]"
        else
          nodes="[]"
        fi
        entries="$entries\\"$key\\":{\\"nodes\\":$nodes},"
        ;;
    esac
    continue
  fi
  if [ "$argument" = "-f" ]; then
    expect_value=1
  fi
done
printf '{"data":{"repository":{%s},"rateLimit":{"remaining":5000,"resetAt":"2026-10-19T00:00:00Z"}}}\\n' "\${entries%?}"
exit 0
`;

export async function seedSessionPrStatusFixture(options: {
  cliEntryPoint: string;
  e2eHomeDir: string;
  workspacePath: string;
}): Promise<void> {
  const fakeBinDir = join(options.e2eHomeDir, "fake-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  // The path must match the ZCODE_GH_BINARY seam wired in wdio.conf.
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(fakeGhPath, FAKE_GH_SCRIPT, "utf8");
  chmodSync(fakeGhPath, 0o755);

  await execFileAsync("git", ["init", "-q"], { cwd: options.workspacePath });
  const { stdout } = await execFileAsync("git", ["remote"], {
    cwd: options.workspacePath,
    encoding: "utf8",
  });
  const remotes = stdout.split(/\r?\n/).filter(Boolean);
  if (remotes.includes("origin")) {
    await execFileAsync("git", ["remote", "set-url", "origin", GITHUB_REMOTE_URL], {
      cwd: options.workspacePath,
    });
  } else {
    await execFileAsync("git", ["remote", "add", "origin", GITHUB_REMOTE_URL], {
      cwd: options.workspacePath,
    });
  }

  const history: ProviderReadinessHistoryFixture = {
    assistantInputTokens: 0,
    assistantOutputTokens: 0,
    assistantText: "E2E_SESSION_PR_STATUS 已持久化的助手回复",
    modelId: "missing-model",
    runtimeProviderId: "missing-provider",
    sessionId: SESSION_PR_STATUS_SESSION_ID,
    taskProviderId: "glm",
    title: "E2E_SESSION_PR_STATUS worktree 会话",
    userText: "E2E_SESSION_PR_STATUS 已持久化的用户消息",
    executionWorktree: {
      path: join(options.e2eHomeDir, "ZCodeProject-worktrees", "e2e-pr-status"),
      branchName: SESSION_PR_STATUS_BRANCH,
    },
  };
  await seedProviderReadinessHistoryFixture({ ...options, history });
}
