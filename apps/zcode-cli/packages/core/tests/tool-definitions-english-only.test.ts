import { expect, it } from "vitest";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";

// specs/english-tool-descriptions.md: everything the model sees in a tool definition is English.
// Han, Hiragana, Katakana and Hangul, plus CJK punctuation and fullwidth forms.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

// Only ReplyToChannel documents the Feishu recipient delimiter "、" literally; it is functional, not prose.
const DELIMITER_EXCEPTIONS: Readonly<Record<string, RegExp>> = { ReplyToChannel: /、/g };

it("no built-in tool definition (description, schema, instructions) contains CJK text", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, {
    includeAgent: true,
    includeSkill: true,
    includeSendMessage: true,
    includeRespondToCoordinator: true,
    includeSubmitResult: true,
    submitResultSchema: { type: "object", properties: { answer: { type: "string" } } },
    includeEscalate: true,
    includeWorkflow: true,
    includeAutomation: true,
    includeOffPeak: true,
    includeDynamicWorkflow: true,
    includeNodeRepl: true,
    includeBrowserUse: true,
  });

  const offenders = registry
    .toContracts()
    .map((contract) => ({
      name: contract.name,
      hit: JSON.stringify(contract)
        .replace(DELIMITER_EXCEPTIONS[contract.name] ?? /(?!)/g, "")
        .match(CJK)?.[0],
    }))
    .filter((entry) => entry.hit !== undefined);

  expect(offenders).toEqual([]);
});
