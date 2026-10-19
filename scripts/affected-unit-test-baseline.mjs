export function selectDefaultBranchRef({ originHead, hasCommit }) {
  // New branches have no remote SHA. Prefer the actual default branch so a
  // stale staging ref cannot pull unrelated history into the affected suite.
  return [
    originHead,
    "origin/integration",
    "origin/staging",
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].find((candidate) => candidate && hasCommit(candidate));
}
