export function selectDefaultBranchRef({ originHead, hasCommit }) {
  // Bug cause: a new branch's first push has no remote SHA; falling back directly to origin/main
  // would count history that staging has not yet merged into main as changes on this branch, and widen the architecture check scope.
  return ["origin/staging", originHead, "origin/main", "origin/master", "main", "master"].find(
    (candidate) => candidate && hasCommit(candidate),
  );
}
