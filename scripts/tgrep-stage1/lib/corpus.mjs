// Deterministic corpus generator for the tgrep stage-1 spike (gate D09/G1/G3/G5 evidence).
// The generator is committed so freshness and benchmark numbers reproduce byte-for-byte from
// the seed. It is research scaffolding for the spike, not product code.

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export const CORPUS_DEFAULT_SEED = 20261010;

// Extension mix mirrors a mid-size TypeScript-heavy workspace so glob/type queries are meaningful.
const EXTENSION_POOL = [
  [".ts", 40],
  [".js", 15],
  [".md", 15],
  [".json", 10],
  [".py", 8],
  [".rs", 5],
  [".css", 5],
  [".txt", 2],
];

const WORDS = [
  "import",
  "export",
  "const",
  "return",
  "function",
  "class",
  "interface",
  "async",
  "await",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "throw",
  "try",
  "catch",
  "finally",
  "type",
  "enum",
  "module",
  "service",
  "handler",
  "router",
  "client",
  "server",
  "logger",
  "config",
  "options",
  "params",
  "request",
  "response",
  "session",
  "context",
  "runtime",
  "adapter",
  "provider",
  "registry",
  "listener",
  "value",
  "result",
  "error",
  "status",
  "buffer",
  "stream",
  "packet",
  "token",
  "cursor",
  "index",
  "cache",
];

// Deterministic PRNG (mulberry32) keeps the corpus identical across runs and machines.
export function createCorpusRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickExtension(rand) {
  const total = EXTENSION_POOL.reduce((sum, [, weight]) => sum + weight, 0);
  let ticket = rand() * total;
  for (const [ext, weight] of EXTENSION_POOL) {
    ticket -= weight;
    if (ticket <= 0) return ext;
  }
  return ".ts";
}

function makeLine(rand, lineIndex) {
  const words = [];
  const count = 6 + Math.floor(rand() * 8);
  for (let i = 0; i < count; i += 1) {
    words.push(WORDS[Math.floor(rand() * WORDS.length)]);
  }
  return `// ${String(lineIndex).padStart(4, "0")} ${words.join(" ")} value_${Math.floor(rand() * 100000)}`;
}

/**
 * Generates a committed Git repository with deterministic content.
 *
 * Planted query anchors (counts approximate by design, exact numbers are derived by
 * comparing engines against each other, never asserted from the generator):
 * - `spike_rare_token_42` in exactly one file
 * - `spike_mid_token_7` in ~5% of `.ts` files only
 * - `function`, `LOGGER`, and `error_state`-style tokens spread across many files
 */
export async function generateCorpus({ root, files = 6000, seed = CORPUS_DEFAULT_SEED }) {
  await rm(root, { recursive: true, force: true });
  const rand = createCorpusRandom(seed);
  let bytes = 0;
  const writeRelative = async (relative, content) => {
    const target = join(root, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
    bytes += Buffer.byteLength(content);
  };

  for (let i = 0; i < files; i += 1) {
    const ext = pickExtension(rand);
    const bucket = `src/${String(Math.floor(i / 250)).padStart(3, "0")}`;
    const lines = [];
    const lineCount = 20 + Math.floor(rand() * 100);
    for (let l = 0; l < lineCount; l += 1) {
      lines.push(makeLine(rand, l));
    }
    if (ext === ".ts" && rand() < 0.05) {
      lines.push("// spike_mid_token_7 anchor");
    }
    if (rand() < 0.3) {
      lines.push("// function path helper");
    }
    if (rand() < 0.2) {
      lines.push("// LOGGER observer");
    }
    if (rand() < 0.15) {
      lines.push(`// error_state_${Math.floor(rand() * 100)} code`);
    }
    await writeRelative(
      `${bucket}/mod${String(i).padStart(6, "0")}${ext}`,
      `${lines.join("\n")}\n`,
    );
  }

  // Deterministic anchor files: fixed names and content so tests never depend on the
  // random extension draw above.
  const anchorLines = (label) =>
    Array.from({ length: 40 }, (_, l) => `// ${label} line ${l} value_${1000 + l} payload`)
      .concat(["// function path helper", "// LOGGER observer"])
      .join("\n");
  await writeRelative("anchors/rare.ts", "// spike_rare_token_42 anchor\n");
  await writeRelative("anchors/edit-target.ts", `${anchorLines("edit")}\n`);
  await writeRelative("anchors/sneaky-target.ts", `${anchorLines("sneaky")}\n`);

  await writeRelative(".gitignore", "ignored-gen/\n");
  await writeRelative("ignored-gen/skip.txt", "// ignored_marker_should_not_match spike\n");
  await writeRelative(".hidden-note.txt", "// hidden_marker_should_not_match_by_default spike\n");

  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "spike@zcode.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "zcode-spike"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "spike corpus"], { cwd: root });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

  return { root, files, bytes, seed, revision };
}

/** Adds binary files (NUL bytes) used only by filter-parity observations, not benchmarks. */
export async function addBinaryFixture(root, count = 5) {
  const payload = Buffer.alloc(512);
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = i % 256;
  }
  for (let i = 0; i < count; i += 1) {
    const target = join(root, `bin-fixture/blob${i}.bin`);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, payload);
    await chmod(target, 0o644);
  }
}
