// Fork-owned pre-push diff target resolution, used by run-pre-push.mjs for the documentation-only fast path.
// Upstream's run-affected-unit-tests.mjs delegates test selection to Vitest and no longer exports this resolver.
import { spawnSync } from "node:child_process";

const ZERO_SHA = /^0+$/u;

// Prefer the repository's actual default branch so a stale staging ref cannot pull unrelated history into the diff.
const DEFAULT_BRANCH_CANDIDATES = (originHead) => [
  originHead,
  "origin/fork",
  "origin/staging",
  "origin/main",
  "origin/master",
  "main",
  "master",
];

function runGit(root, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && options.required !== false) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.status === 0 ? result.stdout.trim() : "";
}

function hasCommit(root, ref) {
  if (!ref) {
    return false;
  }
  return Boolean(runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`], { required: false }));
}

function isZeroSha(value) {
  return ZERO_SHA.test(value);
}

function parsePrePushInput(value) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/u);
      if (!localRef || !localSha || !remoteRef || !remoteSha) {
        return undefined;
      }
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter(Boolean);
}

function resolveDefaultBranchBase(root) {
  const originHead = runGit(
    root,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    {
      required: false,
    },
  );
  const ref = DEFAULT_BRANCH_CANDIDATES(originHead).find(
    (candidate) => candidate && hasCommit(root, candidate),
  );
  if (!ref) {
    return undefined;
  }
  return { base: ref, head: "HEAD", label: `default branch ${ref}`, useMergeBase: true };
}

function resolvePrePushTarget(root) {
  const entries = parsePrePushInput(process.env.ZCODE_PRE_PUSH_STDIN ?? "");
  if (entries.length === 0) {
    return undefined;
  }

  const headSha = runGit(root, ["rev-parse", "HEAD"]);
  const currentRef = runGit(root, ["symbolic-ref", "--quiet", "HEAD"], { required: false });
  const candidate =
    entries.find((entry) => entry.localSha === headSha && !isZeroSha(entry.localSha)) ??
    entries.find((entry) => entry.localRef === currentRef && !isZeroSha(entry.localSha)) ??
    entries.find((entry) => !isZeroSha(entry.localSha));
  if (!candidate) {
    return undefined;
  }
  if (isZeroSha(candidate.remoteSha)) {
    return undefined;
  }
  if (!hasCommit(root, candidate.remoteSha) || !hasCommit(root, candidate.localSha)) {
    return undefined;
  }
  return {
    base: candidate.remoteSha,
    head: candidate.localSha,
    label: `pre-push remote ${candidate.remoteRef}`,
    useMergeBase: false,
  };
}

function resolveUpstreamTarget(root) {
  const upstream = runGit(
    root,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    {
      required: false,
    },
  );
  if (!hasCommit(root, upstream)) {
    return undefined;
  }
  return { base: upstream, head: "HEAD", label: `upstream ${upstream}`, useMergeBase: false };
}

/** Resolves the comparison base for the documentation-only check. Explicit bases win, then the pre-push remote SHA, then upstream, then the default branch. */
export function resolveDiffTarget(root) {
  const explicitBase =
    process.env.ZCODE_PRE_PUSH_BASE?.trim() || process.env.ZCODE_AFFECTED_TEST_BASE?.trim();
  if (explicitBase) {
    if (!hasCommit(root, explicitBase)) {
      throw new Error(`显式 base 不存在或不是 commit: ${explicitBase}`);
    }
    return {
      base: explicitBase,
      head: "HEAD",
      label: `explicit base ${explicitBase}`,
      useMergeBase: true,
    };
  }
  return (
    resolvePrePushTarget(root) ?? resolveUpstreamTarget(root) ?? resolveDefaultBranchBase(root)
  );
}
