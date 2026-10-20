import { execFile } from "node:child_process";
import path from "node:path";
import { loadPendingUpstream, pendingIdenticalPaths } from "./fork-format-pending.mjs";

const MAX_BYTES = 5_000 * 4;
// Repo-relative paths that may exceed the limit. One path per line, `#` starts a comment.
// Add a file here (and stage the list) instead of using --no-verify.
const EXEMPTIONS_FILE = ".staged-file-size-exemptions";
const LOCK_FILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

function git(args, cwd, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
    // git may exit before it reads stdin (EPIPE). The exit callback still reports the real outcome,
    // so only other stdin errors reject here.
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

async function readExemptions(root) {
  const staged = await git(["ls-files", "--stage", "--", EXEMPTIONS_FILE], root);
  if (!staged.trim()) return new Set();
  const text = await git(["show", `:${EXEMPTIONS_FILE}`], root);
  return new Set(
    text
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter(Boolean),
  );
}

async function main() {
  const root = await git(["rev-parse", "--show-toplevel"]);
  const cwd = root.replace(/\r?\n$/, "");
  // Raw NUL records preserve filenames and provide the staged blob IDs/modes.
  // Disable rename detection so every destination is checked independently.
  const raw = await git(
    ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", "--diff-filter=ACMT"],
    cwd,
  );
  const records = raw.split("\0");
  const files = [];
  for (let index = 0; index < records.length - 1; index += 2) {
    const [, mode, , oid] = records[index].slice(1).split(" ");
    const name = records[index + 1];
    if (!/^100(644|755)$/.test(mode)) continue;
    const basename = path.posix.basename(name);
    if (LOCK_FILES.has(basename) || /\.(?:generated|gen)\./.test(basename)) continue;
    files.push({ name, oid });
  }
  if (!files.length) return;

  // Query metadata only: a very large file never needs to be loaded into memory.
  const oids = [...new Set(files.map((file) => file.oid))];
  const metadata = await git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    cwd,
    `${oids.join("\n")}\n`,
  );
  const sizes = new Map();
  for (const line of metadata.trim().split("\n")) {
    const [oid, type, bytes] = line.split(" ");
    if (type !== "blob" || !/^\d+$/.test(bytes ?? ""))
      throw new Error(`Invalid staged blob metadata: ${line}`);
    sizes.set(oid, Number(bytes));
  }
  const exemptions = await readExemptions(cwd);
  const oversizedFiles = files.filter(
    (file) => sizes.get(file.oid) > MAX_BYTES && !exemptions.has(file.name),
  );
  if (!oversizedFiles.length) return;
  // Staged blobs identical to the pending upstream commit are not the fork's
  // to split (specs/fork-format-scope.md). The pin is read from the index.
  const pending = await loadPendingUpstream(cwd, "index");
  const identical = await pendingIdenticalPaths(
    cwd,
    oversizedFiles.map((file) => file.name),
    pending,
    "index",
  );
  const candidates = oversizedFiles.filter((file) => !identical.has(file.name));
  if (!candidates.length) return;

  const attributes = await git(
    ["check-attr", "--cached", "-z", "--stdin", "linguist-generated", "linguist-vendored"],
    cwd,
    `${candidates.map((file) => file.name).join("\0")}\0`,
  );
  const fields = attributes.split("\0");
  const excluded = new Set();
  for (let index = 0; index < fields.length - 1; index += 3) {
    if (fields[index + 2] === "true" || fields[index + 2] === "set") excluded.add(fields[index]);
  }
  const oversized = candidates.filter((file) => !excluded.has(file.name));
  if (!oversized.length) return;

  process.stderr.write(
    "Commit blocked: staged files exceed 5000 tokens (20000 bytes; 1 token = 4 bytes).\n",
  );
  for (const file of oversized) {
    const bytes = sizes.get(file.oid);
    process.stderr.write(
      `  ${JSON.stringify(file.name)}: ${bytes} bytes = ${bytes / 4} estimated tokens\n`,
    );
  }
  process.stderr.write(
    [
      "Split each listed file before committing:",
      "1. Extract cohesive components, helpers, types or test groups into separate sibling modules; split documents by section.",
      "2. Update imports/exports and links so behavior stays unchanged. Keep EVERY resulting file at or below 20000 bytes (5000 estimated tokens).",
      "3. Run the relevant checks, then git add -- <original-file> <new-files> and retry the commit.",
      "For genuine generated output or third-party code, declare linguist-generated=true or linguist-vendored=true in .gitattributes and stage that declaration too.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Unable to check staged files: ${error.message}\n`);
  process.exitCode = 1;
}
