#!/usr/bin/env -S pnpm exec tsx
/**
 * Node side of the workflow engine goldens (rust-cli crates/workflow, W5a; specs/fork-rust-workflow-engine.md section 9.2).
 *
 * Writes packages/rust-cli/crates/workflow/fixtures/hash-goldens.json from the real Node functions
 * (`canonicalJson` and `inputHash` in apps/zcode-cli/packages/dynamic-workflow/src/engine/hash.ts).
 * Each case is JSON text: the text is parsed with JSON.parse (as the NDJSON boundary does) and the
 * canonical form and hash are recorded. Rust parses the same text with serde_json and must match.
 *
 * Inputs cannot contain lone surrogates: serde_json rejects them, and a Rust `String` cannot hold
 * one. That is a known gap at the boundary, recorded in the spec, not a golden case.
 *
 * Run from the repository root:
 *   pnpm exec tsx scripts/rust-cli/workflow-engine-goldens.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  inputHash,
} from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/hash.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../packages/rust-cli/crates/workflow/fixtures/hash-goldens.json");

const texts: string[] = [
  "null",
  "true",
  "false",
  "0",
  "-0",
  "1.0",
  "1e21",
  "1e+21",
  "1e-7",
  "0.000001",
  "0.1",
  "123456789012345680000",
  "9007199254740993",
  "5e-324",
  "-1.5e300",
  "1.7976931348623157e308",
  '""',
  '"a\\"b\\\\c\\n\\t\\r\\b\\f\\u0001\\u001f\\u007f"',
  '"emoji \\ud83d\\ude00 and 中文 and \\u2028"',
  "[]",
  "{}",
  '[1,"two",null,[true,false],{"k":[]}]',
  '{"b":1,"a":2}',
  '{"\\ue000":1,"\\ud83d\\ude00":2,"a":3,"Z":4}',
  '{"nested":{"z":[{"y":1,"x":2}],"a":null},"m":"x"}',
  '{"create":{"name":"ask","typed":true},"ordinal":1}',
  '["ask#3","instruction with 中文 and emoji 😀 and\\nnewline"]',
  '{"op":"files.grep","args":["needle",{"glob":"**/*.ts"}]}',
];

const cases = texts.map((text) => {
  const value: unknown = JSON.parse(text);
  return { text, canonical: canonicalJson(value), hash: inputHash(value) };
});

writeFileSync(out, `${JSON.stringify({ cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} hash cases to ${out}`);
