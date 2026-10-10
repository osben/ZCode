#!/usr/bin/env node
// fork 发版脚本：版本格式 <上游基线>-fork.<N>（见 specs/fork-release-versioning.md）。
// 读取根 package.json 的版本剥离既有 -fork.N 得到基线，扫描本地 git 标签
// v<基线>-fork.* 取最大 N，生成下一个版本并以显式版本调用 release-it。
// fork 发版不写上游 CHANGELOG.md（--no-plugins），避免每次 upstream sync 产生冲突。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveForkBase } from "./fork-release-version.mjs";
import { runCommand, runCommandAndReadStdout } from "./spawn-command.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
const printOnly = process.argv.includes("--print");

function listExistingForkTags(base) {
  const stdout = runCommandAndReadStdout("git", ["tag", "-l", `v${base}-fork.*`], {
    cwd: workspaceRoot,
  });
  const highest = { tag: null, number: 0 };
  const prefix = `v${base}-fork.`;
  for (const rawLine of stdout.split("\n")) {
    const tag = rawLine.trim();
    const suffix = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
    if (/^\d+$/.test(suffix) && Number.parseInt(suffix, 10) > highest.number) {
      highest.tag = tag;
      highest.number = Number.parseInt(suffix, 10);
    }
  }
  return highest;
}

const rootVersion = JSON.parse(
  readFileSync(resolve(workspaceRoot, "package.json"), "utf8"),
).version;

// 仅支持稳定上游基线或既有 fork 版本，避免把 prerelease 拼成未定义的 fork 版本格式。
const forkBase = resolveForkBase(rootVersion);
if (!forkBase) {
  console.error(`[release:fork] 根版本必须是 X.Y.Z 或 X.Y.Z-fork.N: ${String(rootVersion)}`);
  process.exit(1);
}

const { base, isForkVersion } = forkBase;
const rootForkNumber = isForkVersion
  ? Number.parseInt(/-fork\.(\d+)$/.exec(rootVersion)[1], 10)
  : 0;
const highest = listExistingForkTags(base);
// 同时对比根版本里的 N 与已发布标签的 N：根版本可能被手动改过而标签未跟上，
// 只看标签会让下一个版本号倒退。
const nextNumber = Math.max(highest.number, rootForkNumber) + 1;
const nextVersion = `${base}-fork.${nextNumber}`;

if (printOnly) {
  console.log(nextVersion);
  process.exit(0);
}

console.log(`[release:fork] 基线=${base} 最新标签=${highest.tag ?? "无"} 下一版本=${nextVersion}`);

// 显式版本 + --no-plugins：跳过 conventional-changelog，不修改 CHANGELOG.md；
// --ci 关闭交互确认，沿用根 .release-it.json 的提交/标签/推送配置。
runCommand("pnpm", ["exec", "release-it", nextVersion, "--no-plugins", "--ci"], {
  cwd: workspaceRoot,
  stdio: "inherit",
});
