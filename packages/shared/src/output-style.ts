export interface OutputStyle {
  id: string;
  name: string;
  description: string;
  /** Effective prompt text: the override file's body when one exists, otherwise the built-in constant. */
  content: string;
  isBuiltIn: boolean;
  /** True when a file with this built-in id overrides the code constant (delete the file to restore it). */
  isOverridden?: boolean;
  enabled: boolean;
  filePath?: string; // File path, used to open the file in edit mode
}

export interface OutputStyleConfig {
  name: string;
  description: string;
  content: string;
  enabled?: boolean;
}

export type OutputStyleGenerationStatus = "idle" | "generating" | "completed" | "error";

/**
 * Built-in style metadata and default prompt text. The constants are the source of truth:
 * when no override file exists for an id, this is the effective prompt shown to the model
 * (and to the settings UI). `default` has an empty prompt on purpose — it means "no output
 * style section", keeping the stock system prompt byte-identical.
 */
export const BUILT_IN_OUTPUT_STYLES: readonly {
  id: string;
  name: string;
  description: string;
  prompt: string;
}[] = [
  {
    id: "default",
    name: "Default",
    description: "Completes coding tasks efficiently and provides concise responses",
    prompt: "",
  },
  {
    id: "explanatory",
    name: "Explanatory",
    description: "Explains implementation choices and codebase patterns",
    prompt: [
      "While completing the task, explain the implementation choices you make and the patterns you follow.",
      "",
      "- Before writing code, briefly state what approach you are taking and why it fits this codebase.",
      "- When you touch an existing pattern, convention, or abstraction, name it and point to where it is defined.",
      "- After finishing, summarize what changed and why, referencing the files and concepts involved.",
      "- Prefer clarity over brevity in your final response: the user wants to understand the work, not just see it done.",
    ].join("\n"),
  },
  {
    id: "learning",
    name: "Learning",
    description: "Pauses and asks you to write small pieces of code for hands-on practice",
    prompt: [
      "You are mentoring the user; they want hands-on practice, not a completed implementation.",
      "",
      "- Do the exploration, design, and scaffolding yourself, but pause before writing the interesting parts of the code.",
      "- When you reach such a part, stop and ask the user to write it: state exactly what is needed, the file and location, and any constraints.",
      "- Keep the requested pieces small and self-contained; review what the user writes before continuing, and give concrete feedback rather than rewriting it silently.",
      "- If the user asks you to just do it, comply for that piece and resume pausing at the next one.",
    ].join("\n"),
  },
];

export function builtInOutputStylePrompt(id: string): string | undefined {
  return BUILT_IN_OUTPUT_STYLES.find((style) => style.id === id)?.prompt;
}

/**
 * Parse a markdown output-style file: leading `name:` / `description:` header lines followed
 * by the prompt body. Shared by the settings service (listing) and the CLI bootstrap loader
 * (effective prompt) so both agree on the format.
 */
export function parseOutputStyleFile(
  content: string,
  filename?: string,
): { name: string; description: string; prompt: string } {
  const lines = content.split(/\r?\n/);
  let index = 0;
  let name = "";
  let description = "";
  while (index < lines.length) {
    const line = lines[index]!;
    if (/^name:\s*/.test(line)) {
      name = line.replace(/^name:\s*/, "").trim();
    } else if (/^description:\s*/.test(line)) {
      description = line.replace(/^description:\s*/, "").trim();
    } else {
      break;
    }
    index += 1;
  }
  // Skip blank separator lines between the header block and the prompt body.
  while (index < lines.length && lines[index]!.trim() === "") {
    index += 1;
  }
  if (!name && filename) {
    name = filename.replace(/\.md$/, "");
  }
  return {
    name: name || "Custom Style",
    description,
    prompt: lines.slice(index).join("\n").trim(),
  };
}
