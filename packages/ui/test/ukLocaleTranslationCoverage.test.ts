import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import ukUA from "../src/i18n/locales/uk-UA.js";

// English values that stay verbatim in Ukrainian on purpose: product, plan and CLI names,
// API/protocol terms, file names, code identifiers and URL placeholders. Add a value only when
// the English text is such a token and has no Ukrainian form in the product.
const UNTRANSLATED_VALUES = new Set([
  "AGENTS.md",
  "Browser Use",
  "Chat completions",
  "Chat completions (/v1/chat/completions)",
  "Claude CLI",
  "Claude Code",
  "Coding Plan",
  "Codex CLI",
  "Computer Use",
  "Gemini CLI",
  "Kiro CLI",
  "OpenAI Responses",
  "OpenCode CLI",
  "Qoder CN",
  "Qwen Code",
  "Responses (/responses)",
  "Roo Code",
  "SSE (Server-Sent Events)",
  "Start Plan",
  "Start Plan × {count}",
  "Trae CN",
  "ZCode Agent",
  "ZCode MCP",
  "code-reviewer",
  "https://api.example.com/v1",
  "my-command",
  "pr-layered-review",
  "{provider} Coding Plan",
]);

// Keys left in English on purpose until their plural-family conversion lands (tracked by ISSUE-046).
const UNTRANSLATED_KEYS = new Set(["archives.deleteTitle"]);

const PLURAL_CATEGORY = /\.(?:zero|one|two|few|many|other)$/;

// Phrase-like means at least two words of letters once placeholders such as {count} are removed.
function isPhraseLike(english: string): boolean {
  const words = english.replace(/\{[^}]*\}/g, " ").match(/\p{L}{2,}/gu) ?? [];
  return words.length >= 2;
}

// Ukrainian plural forms such as `.few` / `.many` have no English key of their own, so they are
// compared against the English `.other` form of the same family.
function englishReference(key: string): string | undefined {
  const direct = enUS[key];
  if (direct !== undefined) return direct;
  if (!PLURAL_CATEGORY.test(key)) return undefined;
  const base = key.replace(PLURAL_CATEGORY, "");
  return enUS[`${base}.one`] === undefined ? undefined : enUS[`${base}.other`];
}

describe("uk-UA translation coverage", () => {
  it("phrase-like values are translated unless the English is allowlisted", () => {
    const untranslated: string[] = [];
    for (const [key, uk] of Object.entries(ukUA)) {
      const english = englishReference(key);
      if (english === undefined || uk !== english) continue;
      if (!isPhraseLike(english)) continue;
      if (UNTRANSLATED_VALUES.has(english) || UNTRANSLATED_KEYS.has(key)) continue;
      untranslated.push(`${key}: ${JSON.stringify(english)}`);
    }
    expect(
      untranslated,
      "uk-UA values identical to English: translate them or allowlist the brand/technical token",
    ).toEqual([]);
  });

  it("allowlist entries are still used so stale exceptions fail", () => {
    const englishValues = new Set(Object.values(enUS));
    const staleValues = [...UNTRANSLATED_VALUES].filter((value) => !englishValues.has(value));
    expect(staleValues, "UNTRANSLATED_VALUES has entries no English string uses").toEqual([]);

    const staleKeys = [...UNTRANSLATED_KEYS].filter(
      (key) => enUS[key] === undefined || ukUA[key] !== enUS[key],
    );
    expect(staleKeys, "UNTRANSLATED_KEYS has keys that are not identical to English").toEqual([]);
  });
});
