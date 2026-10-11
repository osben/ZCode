#!/usr/bin/env node
// Check baseline freshness before work. Fail if the current branch is behind its own remote,
// or (for non-feature branches) behind origin/main beyond the threshold. This prevents analysis,
// tests, and fixes against an outdated architecture or problems that have already disappeared.
//
// Background: local zcode-cua was once 140 commits behind origin/main (its Skill was still
// 558 lines while main had converged to 128); the z-code integration branch was once 29 commits
// behind its own remote. Both started work on stale baselines. Run this before every session
// (the zcode-cua repository uses its equivalent Python script).
//
// Rules:
//   1) Behind the branch's own upstream by any amount → fail; first run git merge --ff-only <upstream>.
//   2) ahead==0 and behind origin/main beyond the threshold → fail; a local main-like branch is stale.
//   3) ahead>0 (feature/MR branch) and behind origin/main beyond the threshold → warn, but do not fail:
//      divergence is normal. Print the counts so you can decide whether to rebase (do not rebase blindly
//      when draft changes are unmerged).
//
// Usage: node scripts/check-workspace-freshness.mjs [--max-behind-main 50] [--no-fetch]

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const maxBehindMainIndex = args.indexOf("--max-behind-main");
const maxBehindMain = maxBehindMainIndex >= 0 ? Number(args[maxBehindMainIndex + 1]) : 50;
if (!Number.isInteger(maxBehindMain) || maxBehindMain < 0) {
  console.error("[freshness] --max-behind-main 需要一个非负整数");
  process.exit(2);
}
const doFetch = !args.includes("--no-fetch");

async function git(...gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { encoding: "utf8" });
  return stdout.trim();
}

if (doFetch) {
  await git("fetch", "origin", "--prune");
}

const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
let upstream = null;
try {
  upstream = await git("rev-parse", "--abbrev-ref", "@{upstream}");
} catch {
  console.warn(
    `[freshness] ${branch} 没有远端跟踪分支，跳过 behind-remote 检查（是否忘了 push -u？）`,
  );
}

const failures = [];
if (upstream) {
  const behindRemote = Number(await git("rev-list", "--count", `HEAD..${upstream}`));
  if (behindRemote > 0) {
    failures.push(
      `${branch} 落后 ${upstream} ${behindRemote} 个提交：先 git merge --ff-only ${upstream}`,
    );
  }
}

let mainReport = "";
try {
  await git("rev-parse", "--verify", "origin/main^{commit}");
  const aheadMain = Number(await git("rev-list", "--count", `origin/main..HEAD`));
  const behindMain = Number(await git("rev-list", "--count", `HEAD..origin/main`));
  mainReport = `相对 origin/main：ahead ${aheadMain} / behind ${behindMain}（阈值 ${maxBehindMain}）`;
  if (behindMain > maxBehindMain) {
    const message = `落后 origin/main ${behindMain} 个提交，超过阈值 ${maxBehindMain}`;
    if (aheadMain === 0) {
      failures.push(`${message}：git merge --ff-only origin/main 或重建分支`);
    } else {
      console.warn(
        `[freshness] 警告：${message}。这是特性/MR 分支（ahead ${aheadMain}），` +
          `分叉本身正常；若要跟主线对齐请先确认 MR 状态（冻结中的 Draft MR 不要盲目 rebase）。`,
      );
    }
  }
} catch {
  console.warn("[freshness] 仓库没有 origin/main，跳过 main 距离检查。");
}

if (failures.length > 0) {
  console.error(`[freshness] 基线过期，拒绝在旧架构上开工（当前分支：${branch}）：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `[freshness] 基线新鲜：${branch}${upstream ? `（与 ${upstream} 同步）` : ""}${
    mainReport ? `，${mainReport}` : ""
  }`,
);
