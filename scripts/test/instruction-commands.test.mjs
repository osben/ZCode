import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  allowlist,
  buildContext,
  checkFiles,
  collectScope,
  extractCommands,
  resolveCommand,
} from "../check-instruction-commands.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function put(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function fixtureContext(root, existingFiles) {
  return buildContext(root, {
    packagePaths: ["package.json", "nested/package.json", "packages/ui/package.json"],
    workspacePaths: ["nested/pnpm-workspace.yaml"],
    fileExists: (absolutePath) => existingFiles.has(absolutePath),
  });
}

// Mirrors the repository layout the contract cares about: a root manifest, a
// nested workspace package and a plain workspace package.
function fixtureTree(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruction-commands-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture-root",
      scripts: { test: "node --test", build: "echo build", lint: "echo lint" },
      devDependencies: { vitest: "^4.0.0" },
    }),
  );
  put(
    root,
    "nested/package.json",
    JSON.stringify({ name: "nested-cli", scripts: { check: "echo check" } }),
  );
  put(root, "nested/pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put(
    root,
    "packages/ui/package.json",
    JSON.stringify({ name: "@fixture/ui", scripts: { typecheck: "tsc" } }),
  );
  return root;
}

test("extractCommands collects fence lines and inline spans, splitting on shell separators", () => {
  const markdown = [
    "Run `pnpm typecheck` and `pnpm install || pnpm i`.",
    "",
    "```bash",
    "$ FOO=1 pnpm lint",
    "pnpm run build && pnpm test;",
    "```",
    "",
    "~~~",
    "pnpm fmt:check",
    "~~~",
  ].join("\n");
  assert.deepEqual(
    extractCommands(markdown).map(({ command }) => command),
    [
      "pnpm typecheck",
      "pnpm install",
      "pnpm i",
      "pnpm lint",
      "pnpm run build",
      "pnpm test",
      "pnpm fmt:check",
    ],
  );
});

test("extractCommands skips placeholders, non-command text and cd segments", () => {
  const markdown = [
    "- `pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/<file>`",
    "- `git push` and `echo $HOME`",
    "- `pnpm audit:conversation-session-coverage`",
    "",
    "```bash",
    "cd packages/ui && node --import tsx --test test/locale.test.ts",
    "pnpm --filter @zcode/core... run build",
    "```",
  ].join("\n");
  const extracted = extractCommands(markdown);
  assert.deepEqual(
    extracted.map(({ command, cwd }) => ({ command, cwd })),
    [
      { command: "pnpm audit:conversation-session-coverage", cwd: "" },
      { command: "node --import tsx --test test/locale.test.ts", cwd: "packages/ui" },
      { command: "pnpm --filter @zcode/core... run build", cwd: "" },
    ],
  );
});

test("resolveCommand fails a missing root script naming file and command", (t) => {
  const ctx = fixtureContext(fixtureTree(t), new Set());
  const result = resolveCommand("pnpm release:forker", ctx, "");
  assert.equal(result.ok, false);
  assert.match(result.reason, /release:forker/u);
});

test("resolveCommand fails an unknown --filter target", (t) => {
  const ctx = fixtureContext(fixtureTree(t), new Set());
  const result = resolveCommand("pnpm --filter @ghost/pkg build", ctx, "");
  assert.equal(result.ok, false);
  assert.match(result.reason, /@ghost\/pkg/u);
});

test("resolveCommand rejects --dir into a nested workspace and suggests --filter", (t) => {
  const ctx = fixtureContext(fixtureTree(t), new Set());
  const result = resolveCommand("pnpm --dir nested lint", ctx, "");
  assert.equal(result.ok, false);
  assert.match(result.reason, /nested pnpm workspace nested/u);
  assert.match(result.suggestion, /--filter nested-cli/u);
});

test("resolveCommand accepts --dir into a plain package directory", (t) => {
  const ctx = fixtureContext(fixtureTree(t), new Set());
  assert.deepEqual(resolveCommand("pnpm --dir packages/ui typecheck", ctx, ""), { ok: true });
});

test("resolveCommand passes dependency binaries, built-ins and exec", (t) => {
  const ctx = fixtureContext(fixtureTree(t), new Set());
  assert.deepEqual(resolveCommand("pnpm vitest run", ctx, ""), { ok: true });
  assert.deepEqual(resolveCommand("pnpm install", ctx, ""), { ok: true });
  assert.deepEqual(resolveCommand("pnpm pkg set x=y", ctx, ""), { ok: true });
  assert.deepEqual(resolveCommand("pnpm -r build", ctx, ""), { ok: true });
  assert.deepEqual(
    resolveCommand("pnpm --filter nested-cli exec vitest run tests/x.test.ts", ctx, ""),
    { ok: true },
  );
});

test("resolveCommand resolves bare scripts against the owning package and the root", (t) => {
  const ctx = fixtureContext(fixtureTree(t), new Set());
  // check exists only in nested; test exists only in the root; both resolve.
  assert.deepEqual(resolveCommand("pnpm check", ctx, "nested"), { ok: true });
  assert.deepEqual(resolveCommand("pnpm test", ctx, "nested"), { ok: true });
  const missing = resolveCommand("pnpm check", ctx, "");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no script or dependency named "check"/u);
});

test("resolveCommand checks node entry files against the repo root and owning package", (t) => {
  const root = fixtureTree(t);
  const existing = new Set([join(root, "packages/ui/scripts/real.mjs"), join(root, "tools/x.mjs")]);
  const ctx = fixtureContext(root, existing);
  assert.deepEqual(resolveCommand("node packages/ui/scripts/real.mjs", ctx, "packages/ui"), {
    ok: true,
  });
  assert.deepEqual(resolveCommand("node tools/x.mjs", ctx, ""), { ok: true });
  assert.deepEqual(resolveCommand('node -e "1"', ctx, ""), { ok: true });
  const missing = resolveCommand("node scripts/missing.mjs", ctx, "");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /scripts\/missing\.mjs/u);
});

test("a negative markdown fixture yields exactly the four contract violations", () => {
  const root = fixtureTree(test);
  put(
    root,
    "specs/plan.md",
    [
      "# Plan",
      "",
      "Valid: `pnpm test`, `pnpm vitest run`, `pnpm install`, `pnpm pkg set x=y`,",
      "`pnpm --filter @fixture/ui typecheck` and `pnpm --dir packages/ui typecheck`.",
      "",
      "```bash",
      "pnpm release:forker",
      "pnpm --filter @ghost/pkg build",
      "pnpm --dir nested lint",
      "node scripts/missing.mjs",
      "```",
      "",
    ].join("\n"),
  );
  const ctx = fixtureContext(root, new Set());
  const { violations, stale } = checkFiles(ctx, ["specs/plan.md"], new Set());
  assert.equal(stale.length, 0);
  assert.deepEqual(
    violations.map(({ command }) => command),
    [
      "pnpm release:forker",
      "pnpm --filter @ghost/pkg build",
      "pnpm --dir nested lint",
      "node scripts/missing.mjs",
    ],
  );
  assert.equal(violations[0].line, 7);
});

test("a stale allowlist entry is reported as a violation of its own", () => {
  const root = fixtureTree(test);
  put(root, "specs/plan.md", "All good: `pnpm test`\n");
  const ctx = fixtureContext(root, new Set());
  const { violations, stale } = checkFiles(
    ctx,
    ["specs/plan.md"],
    new Set(["specs/plan.md::pnpm release:forker"]),
  );
  assert.equal(violations.length, 0);
  assert.deepEqual(stale, ["specs/plan.md::pnpm release:forker"]);
});

test("real repository: scope is non-empty, vendored skills excluded", () => {
  const files = collectScope(repoRoot);
  assert.ok(files.length > 100, `expected a broad scope, got ${files.length}`);
  assert.ok(files.includes("AGENTS.md"));
  assert.ok(files.includes("apps/zcode-cli/AGENTS.md"));
  assert.ok(files.some((path) => path.startsWith("specs/")));
  assert.ok(files.some((path) => path.startsWith("apps/zcode-cli/docs/design/v2/")));
  for (const path of files) {
    assert.ok(!/react-best-practices|vercel-react/u.test(path), path);
    assert.ok(!/^apps\/zcode-cli\/packages\/[^/]+\/skills\//u.test(path), path);
    assert.ok(!path.startsWith("docs/"), path);
  }
});

// The integration target is zero violations. Until the integrator rewrites the
// two nested-workspace citations in apps/zcode-cli/AGENTS.md (tracked in the
// same change series), those are the only permitted violations.
test("real repository: no violations beyond the known nested-workspace citations", () => {
  const ctx = buildContext(repoRoot);
  const files = collectScope(repoRoot);
  const { violations, stale } = checkFiles(ctx, files, allowlist);
  assert.equal(stale.length, 0);
  const known = new Set(["pnpm --dir apps/zcode-cli typecheck", "pnpm --dir apps/zcode-cli lint"]);
  for (const violation of violations) {
    assert.equal(violation.path, "apps/zcode-cli/AGENTS.md", violation.command);
    assert.ok(known.has(violation.command), violation.command);
  }
});
