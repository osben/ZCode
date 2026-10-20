#!/bin/sh
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

OPEN_PR='{"number":101,"url":"https://github.com/e2e-fork/ZCode/pull/101","title":"E2E open pull request","state":"OPEN","isDraft":false,"mergedAt":null,"updatedAt":"2026-10-19T00:00:00Z","mergeable":"MERGEABLE","reviewDecision":null,"additions":10,"deletions":2,"headRefName":"e2e-branch","headRepositoryOwner":{"login":"e2e-fork"},"mergeStateStatus":"BLOCKED","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE","contexts":{"totalCount":2,"nodes":[{"conclusion":"FAILURE","status":"COMPLETED"},{"conclusion":"SUCCESS","status":"COMPLETED"}]}}}}]}}'
MERGED_PR='{"number":100,"url":"https://github.com/e2e-fork/ZCode/pull/100","title":"E2E merged pull request","state":"MERGED","isDraft":false,"mergedAt":"2026-10-18T00:00:00Z","updatedAt":"2026-10-18T00:00:00Z","mergeable":"UNKNOWN","reviewDecision":null,"additions":5,"deletions":1,"headRefName":"e2e-branch","headRepositoryOwner":{"login":"e2e-fork"},"mergeStateStatus":"UNKNOWN","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"totalCount":0,"nodes":[]}}}}]}}'

aliases=""
expect_value=0
for argument in "$@"; do
  if [ "$expect_value" = "1" ]; then
    expect_value=0
    key="${argument%%=*}"
    case "$key" in
      b*) aliases="$aliases $key" ;;
    esac
    continue
  fi
  if [ "$argument" = "-f" ]; then
    expect_value=1
  fi
done

entries=""
for alias in $aliases; do
  entries="$entries\"$alias\":{\"nodes\":[$OPEN_PR,$MERGED_PR]},"
done
printf '{"data":{"repository":{%s},"rateLimit":{"remaining":5000,"resetAt":"2026-10-19T00:00:00Z"}}}\n' "${entries%?}"
exit 0
