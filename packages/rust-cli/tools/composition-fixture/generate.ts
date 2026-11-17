// Generates crates/query/tests/fixtures/composition_projection.json from Node's own code.
//
// The sizing rule is Node's classifier (apps/zcode-cli/packages/core/src/runtime/context-composition/classifier.ts,
// the message loop): each message is sized as `stringifyForEstimation({role, content, toolCalls, toolCallId, toolName})`
// and its tokens are `estimateTokens` of that string.
//
// The two functions are loaded verbatim from their repository sources. Importing the modules themselves pulls in the
// whole core package (it needs a full workspace build), so this script cuts out the exact text of each function and
// the divisor constant from `packages/shared/src/usage-stats.ts`, strips the types with Node's own
// `module.stripTypeScriptTypes`, and runs the result. The function bodies are not retyped.
//
// Run from the repository root:
//   node packages/rust-cli/tools/composition-fixture/generate.ts
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../", import.meta.url);

function verbatimFunction(path: string, name: string): string {
  const source = readFileSync(new URL(path, root), "utf8");
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`end of ${name} not found in ${path}`);
  return source.slice(start, end + 3).replace(`export function ${name}`, `function ${name}`);
}

const divisorSource = readFileSync(new URL("packages/shared/src/usage-stats.ts", root), "utf8");
const divisor = /export const ESTIMATED_TOKEN_CHAR_DIVISOR = (\d+);/.exec(divisorSource);
if (!divisor) throw new Error("ESTIMATED_TOKEN_CHAR_DIVISOR not found");

const moduleSource = [
  `const ESTIMATED_TOKEN_CHAR_DIVISOR = ${divisor[1]};`,
  verbatimFunction(
    "apps/zcode-cli/packages/core/src/runtime/helpers/tool-result.ts",
    "stringifyForEstimation",
  ),
  verbatimFunction("apps/zcode-cli/packages/core/src/context/utils.ts", "estimateTokens"),
  "export { stringifyForEstimation, estimateTokens };",
].join("\n\n");
const js = stripTypeScriptTypes(moduleSource);
const { stringifyForEstimation, estimateTokens } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

interface NodeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

// Each case is one ModelInputMessage as Node's classifier receives it. The Rust test builds the equivalent wire
// message by hand, keyed by `name`.
const cases: Array<{ name: string; message: NodeMessage }> = [
  { name: "user_text", message: { role: "user", content: "hello" } },
  {
    name: "user_two_text_blocks",
    message: {
      role: "user",
      content: [
        { type: "text", text: "第一段 abc" },
        { type: "text", text: "second" },
      ],
    },
  },
  {
    name: "assistant_text_and_tool_call",
    message: {
      role: "assistant",
      content: "Let me check.",
      toolCalls: [{ id: "toolu_1", name: "Read", input: { file_path: "/a/b.ts" } }],
    },
  },
  {
    name: "assistant_tool_calls_only",
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "toolu_2", name: "Bash", input: { command: "ls -la" } },
        { id: "toolu_3", name: "Grep", input: { pattern: 'a"b', path: "x" } },
      ],
    },
  },
  {
    name: "tool_result_text",
    message: {
      role: "tool",
      content: "file body 中文 text\nline two",
      toolCallId: "toolu_1",
      toolName: "Read",
      isError: false,
    },
  },
  {
    name: "tool_result_error",
    message: {
      role: "tool",
      content: "Exit code 1",
      toolCallId: "toolu_2",
      toolName: "Bash",
      isError: true,
    },
  },
  {
    name: "system_text",
    message: { role: "system", content: "You are a helpful agent." },
  },
  {
    name: "escapes_and_non_bmp",
    message: { role: "user", content: "a\"b\\c\nd\u0001 😀 中" },
  },
];

const projected = cases.map(({ name, message }) => {
  // The classifier's literal (message loop): undefined fields are dropped by JSON.stringify.
  const content: string = stringifyForEstimation({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
  });
  return {
    name,
    message,
    projected: content,
    chars: content.length,
    tokens: estimateTokens(content) as number,
  };
});

const out = {
  generator: "packages/rust-cli/tools/composition-fixture/generate.ts",
  source:
    "apps/zcode-cli/packages/core/src/runtime/context-composition/classifier.ts (message loop); helpers/tool-result.ts stringifyForEstimation; context/utils.ts estimateTokens; shared usage-stats.ts divisor",
  cases: projected,
};

const target = fileURLToPath(
  new URL("../../crates/query/tests/fixtures/composition_projection.json", import.meta.url),
);
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${projected.length} cases to ${target}`);
