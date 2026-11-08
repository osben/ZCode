#!/usr/bin/env node
// Fork: stages the zcode-rs agent for packaging (specs/fork-agent-runtime-selection.md, "Packaging").
// Copies the built binary and its license material into packages/desktop/resources/zcode-rs/, which
// electron-builder ships as <resources>/zcode-rs/ when the directory exists. Main resolves the binary
// there (packages/desktop/src/main/fork-agent-runtime/selection.ts).
//
// Usage: node scripts/fork-rust-agent/stage-resources.mjs --binary <path> --crate-licenses <path>
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const target = resolve(repositoryRoot, "packages/desktop/resources/zcode-rs");

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    "crate-licenses": { type: "string" },
  },
});
if (!values.binary || !values["crate-licenses"]) {
  throw new Error("usage: stage-resources.mjs --binary <path> --crate-licenses <path>");
}

const binaryName = basename(values.binary);
if (binaryName !== "zcode-rs" && binaryName !== "zcode-rs.exe") {
  throw new Error(`unexpected binary name: ${binaryName}`);
}
if (!(await stat(values.binary)).isFile()) throw new Error(`not a file: ${values.binary}`);

// zcode-rs is Apache-2.0 like the rest of the repository; the vendored C/C++ notices and the crate
// licenses travel next to the binary.
const files = [
  [values.binary, binaryName],
  [resolve(repositoryRoot, "LICENSE"), "LICENSE"],
  [resolve(repositoryRoot, "NOTICE.md"), "NOTICE.md"],
  [
    resolve(repositoryRoot, "packages/rust-cli/vendor/THIRD-PARTY-NOTICES.txt"),
    "VENDORED-THIRD-PARTY-NOTICES.txt",
  ],
  [values["crate-licenses"], "CRATE-LICENSES.md"],
];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const [from, name] of files) await copyFile(from, resolve(target, name));
console.log(`staged ${files.length} files into ${target}`);
