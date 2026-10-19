import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const shellQuote = (value) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

export async function fixture(t, { legacy = false } = {}) {
  const dir = await mkdtemp(join(repoRoot, "scripts", ".tmp-lefthook-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await realpath(dir);
  const env = {
    ...process.env,
    PATH: `${join(repoRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
  };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"])
    delete env[name];
  const git = async (...args) => (await exec("git", args, { cwd: root, env })).stdout.trim();
  const put = async (name, text) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  };
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Hook Test");
  await git("config", "user.email", "hook@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  let config = await readFile(join(repoRoot, "lefthook.yml"), "utf8");
  for (const path of [
    "scripts/check-staged-file-tokens.mjs",
    "scripts/run-lefthook.mjs",
    "scripts/pre-push-hook.sh",
  ]) {
    config = config.replaceAll(path, shellQuote(join(repoRoot, path)));
  }
  config = config.replace(
    "pnpm exec lint-staged --config lint-staged.pre-commit.config.mjs",
    "pnpm exec lint-staged --config lint-staged.fixture.mjs",
  );
  const stagedConfig = (await readFile(join(repoRoot, "lint-staged.pre-commit.config.mjs"), "utf8"))
    .replace(
      "./scripts/fork-format.mjs",
      pathToFileURL(join(repoRoot, "scripts/fork-format.mjs")).href,
    )
    .replace(
      "node scripts/run-pre-commit-checks.mjs",
      `node ${shellQuote(join(repoRoot, "scripts/run-pre-commit-checks.mjs"))}`,
    );
  await put("lint-staged.fixture.mjs", stagedConfig);
  await put("lefthook.yml", config);
  await put("tracked.json", '{ "staged": 0 }\n');
  await git("add", ".");
  await git("commit", "-qm", "baseline");
  if (legacy) {
    await git("config", "core.hooksPath", ".husky/_");
    await put(".husky/_/pre-commit", "#!/bin/sh\nexit 1\n");
  }
  const install = () =>
    exec(process.execPath, [join(repoRoot, "scripts/install-git-hooks.mjs")], { cwd: root, env });
  const commit = async () => {
    try {
      return {
        code: 0,
        ...(await exec("git", ["commit", "-m", "fixture change"], { cwd: root, env })),
      };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return error;
    }
  };
  return { root, env, git, put, install, commit };
}
