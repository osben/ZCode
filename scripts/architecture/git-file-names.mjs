import { spawn } from "node:child_process";

export function gitAddedFilesSince(cwd, { since, ref = "HEAD" }) {
  // Git appends the current time and host timezone to a bare date, so the admitted set for the same ref
  // drifts with execution time. Bare dates are pinned to UTC midnight; explicit timestamps keep the
  // caller-provided boundary.
  const boundary = /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00Z` : since;
  return gitFileNames(cwd, [
    "log",
    "--diff-filter=A",
    "--name-only",
    "-z",
    "--format=",
    `--since=${boundary}`,
    ref,
  ]);
}

export function gitFileNames(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const files = [];
    let pending = "";
    let stderr = "";
    // Persistent CI caches once overflowed execFile's 1 MiB output buffer. Stream the output and use NUL separators to avoid escaping or whitespace corruption.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const names = (pending + chunk).split("\0");
      pending = names.pop() ?? "";
      for (const name of names) if (name) files.push(name);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${signal ?? code}): ${stderr.trim()}`));
        return;
      }
      if (pending) files.push(pending);
      resolve(files);
    });
  });
}
