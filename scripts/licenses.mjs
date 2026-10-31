#!/usr/bin/env node
/* eslint-disable max-lines -- Unified third-party license inventory, notice generation, and gate script; keep the data table and validation logic together. */
// Unified third-party license inventory, notice generation, and gate script.
//
// Usage:
//   node scripts/licenses.mjs notices   Generate THIRD-PARTY-NOTICES.md (exact versions, original copyright, and license text)
//   node scripts/licenses.mjs check     Manual gate: exit with code 1 if a package is not allowlisted or its license is unknown
//
// Data sources:
// - Installed inventory = recursive contents of all workspace node_modules, including nested versions and symlinks.
// - Notice generation: third-party-npm.mjs collects actual license files for exact production dependency versions.
// - Production status is determined by exact versions in the lockfile's production graph.
// - Commercial/semi-open checks apply to all installed packages (prod + dev).
import { generateThirdPartyNotices } from "./generate-third-party-notices.mjs";
import { readVerifiedNotices } from "./third-party-notices.mjs";
import {
  isAllowedLicenseIdentifier,
  isReviewedLegacyLicense,
  legacyLicenseIdentifier,
} from "./license-identifiers.mjs";
import { readFile } from "node:fs/promises";
import {
  readWorkspaceProductionGraph,
  scanInstalledPackages,
  missingProductionPackages,
} from "./third-party-npm.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "notices";
if (command === "notices") {
  await generateThirdPartyNotices(ROOT);
  process.exit(0);
}

// The license gate and notice generation share the workspace graph and recursive scan; production scope is not guessed from package names.
const { required, projects } = await readWorkspaceProductionGraph(ROOT);
const ownNames = new Set(projects.map((project) => project.name));
const installed = new Map();
const MANUAL_LICENSE = {
  "exif-parser": "MIT", // LICENSE.md in the package
  khroma: "MIT", // License file in the package
  semaphore: "MIT", // License section in the package README
  "css-value": "MIT", // License section in the package Readme
  "@fig/autocomplete-helpers": "MIT", // LICENSE in the package
  // react-scan dev dependency chain; license field missing, the in-package LICENSE is Aiden Bai's standard MIT.
  "@react-grab/cli": "MIT",
};
function normLicense(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normLicense).join(" OR ");
  return value?.type?.trim() || "(missing)";
}
const scanned = await scanInstalledPackages(ROOT, projects);
missingProductionPackages(required, scanned);
for (const [key, { pkg }] of scanned) {
  if (ownNames.has(pkg.name)) continue;
  installed.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: normLicense(
      pkg.license ?? pkg.licenses ?? legacyLicenseIdentifier(pkg) ?? MANUAL_LICENSE[pkg.name],
    ),
    isProd: required.has(key),
  });
}
// ---------- Categories ----------
function classify(raw) {
  const s = raw.replace(/[()]/g, " ").trim();
  if (s === "(missing)" || s === "missing" || s === "") return "missing";
  if (/^UNLICENSED|SEE LICEN[CS]E IN|UNKNOWN|N\/A$/i.test(s)) return "unresolved";
  const or = s
    .split(/\s+OR\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (or.length > 1 && or.some((x) => isAllowedLicenseIdentifier(x))) return "green";
  const and = s
    .split(/\s+AND\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (and.length > 1 && and.every((x) => isAllowedLicenseIdentifier(x))) return "green";
  const t = or[0] || and[0] || s;
  if (/\bAGPL/i.test(t)) return "red-agpl";
  if (/\bLGPL/i.test(t)) return "yellow-lgpl";
  if (/\bGPL/i.test(t)) return "red-gpl";
  if (/^(MPL|EPL|CDDL)/i.test(t)) return "yellow-weak";
  if (/^(BUSL|BSL|Elastic|SSPL|PolyForm|FSL|CAL-1)/i.test(t)) return "red-semiopen";
  if (/^CC-BY-NC/i.test(t)) return "red-nc";
  if (/^CC-BY-(ND|SA)/i.test(t)) return "yellow-cc";
  return isAllowedLicenseIdentifier(t) ? "green" : "review";
}
for (const r of installed.values()) r.bucket = classify(r.license);

// ---------- Build-tool license identifier review (does not waive binary distribution obligations) ----------
const WEAK_ALLOW = [
  [/^lightningcss/, "当前仅构建依赖；进入生产图时需重新核对 MPL 源码提供义务"],
  // react-scan dev dependency chain. The license field says SEE LICENSE IN LICENSE; the package
  // actually ships a Modified MIT: MIT plus two use restrictions — "no ML training data" and
  // "no reselling as a paid hosting service". Currently runs only as a dev-mode diagnostic tool
  // locally/in CI, is not distributed with the product and falls under no restricted use;
  // re-review before it enters the production graph.
  [
    /react-doctor$/,
    "仅开发态 react-scan 诊断工具；Modified MIT 的用途限制不影响内部使用，不随产品分发",
  ],
];
// ---------- Per-package review of production dependencies, recorded by package name and license category; block again if a license changes ----------
const PROD_REVIEWED = [
  [
    /^@img\/sharp-(libvips-|win32-)/,
    "yellow-lgpl",
    "libvips 以独立、可替换的共享库随 sharp 分发，仅真实 Computer Use 截图使用；声明附 LGPL-3.0 原文",
  ],
  [
    /^elkjs$/,
    "yellow-weak",
    "仅内部开发文档站 apps/dev-docs 使用，不随产品分发、不部署；按 EPL-2.0 使用",
  ],
];
function weakAllowReason(r) {
  if (r.isProd) {
    for (const [re, bucket, why] of PROD_REVIEWED)
      if (re.test(r.name) && r.bucket === bucket) return why;
    return null;
  }
  for (const [re, why] of WEAK_ALLOW) if (re.test(r.name)) return why;
  return null;
}

if (command === "check") {
  const bad = [];
  for (const r of installed.values()) {
    if (r.bucket === "green" || isReviewedLegacyLicense(r)) continue;
    // Build dependencies with a registered WEAK_ALLOW review verdict may sit in the
    // missing/unresolved buckets: their license fields are often absent or say
    // SEE LICENSE IN <file>, so they cannot be auto-bucketed into yellow; the manual review
    // record itself is the pass verdict.
    if (!r.isProd && weakAllowReason(r)) continue;
    if (r.bucket.startsWith("yellow") && weakAllowReason(r)) continue;
    bad.push(r);
  }
  if (bad.length) {
    console.error(`✗ license 检查失败：${bad.length} 个包超出 allowlist：`);
    for (const r of bad.sort((a, b) => a.name.localeCompare(b.name)))
      console.error(`  [${r.bucket}] ${r.name}@${r.version} → ${r.license}`);
    console.error(
      "\n处置：替换依赖，或在 scripts/licenses.mjs 的 WEAK_ALLOW（构建依赖）/ PROD_REVIEWED（生产依赖）登记人工复核结论。",
    );
    process.exit(1);
  }
  await readVerifiedNotices(ROOT, { requireComplete: process.argv.includes("--strict") });
  const reviewRequired =
    JSON.parse(await readFile(path.join(ROOT, "third-party/inventory.json"), "utf8"))
      .reviewRequired ?? [];
  if (reviewRequired.length)
    console.warn(
      `待补齐/核验材料 ${reviewRequired.length} 项；发布前运行 node scripts/licenses.mjs check --strict，不得将基础检查通过视为合规完成。`,
    );
  const n = installed.size;
  console.log(
    `✓ 许可标识与声明新鲜度检查通过：${n} 个实装包（构建依赖复核 ${[...installed.values()].filter((r) => r.bucket.startsWith("yellow")).length} 项）；材料限制见 third-party/README.md`,
  );
} else {
  console.error("用法: node scripts/licenses.mjs [notices|check]");
  process.exit(2);
}
