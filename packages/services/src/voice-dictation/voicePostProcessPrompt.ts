// Prompt handling for dictation post-processing. Pure (no Node APIs): the settings UI and the Host
// share this module, so the default prompt and the substitution rule have a single definition.

/** The only prompt variable: replaced by the raw transcript. */
export const POST_PROCESS_TEXT_VARIABLE = "{{text}}";

export const POST_PROCESS_PROMPT_MAX_LENGTH = 4000;

export const DEFAULT_POST_PROCESS_PROMPT = [
  "Fix punctuation, capitalization, and obvious speech-recognition mistakes in the text below.",
  "Remove filler words and false starts.",
  "Keep the text in its original language and never translate it.",
  "Do not add, explain, or answer anything; return only the corrected text.",
  "",
  POST_PROCESS_TEXT_VARIABLE,
].join("\n");

/**
 * Builds the final model prompt: every `{{text}}` becomes the transcript (inserted literally, so `$&`
 * and friends in speech are not treated as replacement patterns). A prompt without the variable gets
 * the transcript appended on a new line; a blank prompt falls back to the default.
 */
export function applyPostProcessPrompt(prompt: string, text: string): string {
  const effective = prompt.trim() ? prompt : DEFAULT_POST_PROCESS_PROMPT;
  if (!effective.includes(POST_PROCESS_TEXT_VARIABLE)) {
    return `${effective.trimEnd()}\n${text}`;
  }
  return effective.split(POST_PROCESS_TEXT_VARIABLE).join(text);
}
