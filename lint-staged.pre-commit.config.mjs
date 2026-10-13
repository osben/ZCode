// Pre-commit counterpart of lint-staged.config.mjs, kept in a separate file on
// purpose: scripts/run-affected-unit-tests.mjs reuses the shared config via
// `lint-staged --diff` during pre-push, so tasks added there would also run at
// push time — and a formatter in write mode would rewrite working-tree files
// mid-push. This file is only consumed by .husky/pre-commit.

// Function tasks in lint-staged do NOT get the staged files appended to their
// argv (see getSpawnedTasks.js: "Function tasks are meant to generate the file
// list themselves"), so the file list must be embedded into the command string.
// lint-staged spawns without a shell (argv-parsed via string-argv), which keeps
// the quoting below safe from cmd.exe metacharacter expansion on Windows.

const FORMATTED_EXTENSIONS = ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "json"];

function shellQuote(value) {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

const STAGED_FILES_GLOB = `**/*.{${FORMATTED_EXTENSIONS.join(",")}}`;

export default {
  [STAGED_FILES_GLOB]: (files) =>
    `node scripts/run-pre-commit-checks.mjs ${files.map(shellQuote).join(" ")}`,
};
