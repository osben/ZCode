#!/usr/bin/env node
// Usage: node build-link.mjs <project-dir> <plan-file>
// Prints a zcode://task/new link; both paths must be absolute and the plan must live inside the project.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

const [projectDir, planFile] = process.argv.slice(2);
if (!projectDir || !planFile || !isAbsolute(projectDir) || !isAbsolute(planFile)) {
  console.error("usage: build-link.mjs <absolute-project-dir> <absolute-plan-file>");
  process.exit(2);
}
if (!statSync(projectDir).isDirectory() || !statSync(planFile).isFile()) {
  console.error("project must be a directory and plan a regular file");
  process.exit(2);
}
const rel = relative(realpathSync(projectDir), realpathSync(planFile));
if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
  console.error("plan file must be inside the project directory");
  process.exit(2);
}
const url = `zcode://task/new?path=${encodeURIComponent(projectDir)}&promptFile=${encodeURIComponent(planFile)}`;
console.log(url);
