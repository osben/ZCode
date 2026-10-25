import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Engine-added text in a user message.
 *
 * Every ask received by a dwf subagent = the instruction body written by the script + an engine-appended epilogue (result criteria, the `submit_result`
 * JSON Schema); the entire nudge turn is engine text. Readers opening a subagent transcript want to know “what the script asked it to
 * do”; the epilogue is repetitive technical boilerplate, so place it in a collapsed-by-default disclosure but **do not remove it**: debugging needs to confirm
 * exactly what the subagent was told. The engine marks the boundary on the row as `epilogueStart`; this component only splits and collapses it.
 */

/** Split the row into body and epilogue. Out-of-bounds or missing → no epilogue: prefer showing too much to hiding body text. */
export function splitUserInputEpilogue(
  text: string,
  epilogueStart: number | undefined,
): { body: string; epilogue?: string } {
  if (epilogueStart === undefined || epilogueStart < 0 || epilogueStart > text.length) {
    return { body: text };
  }
  return { body: text.slice(0, epilogueStart), epilogue: text.slice(epilogueStart) };
}

/**
 * Remove blank lines and the `---` separator at the start of the epilogue: in the original text that divider means “the body ends here,” and the disclosure itself
 * already expresses that boundary, so drawing it again would be noise. Preserve the second `---` between paragraphs (between the quality epilogue and schema epilogue).
 */
function trimEpilogueLead(text: string): string {
  return text.replace(/^\s*(?:---[ \t]*\n)?/u, "").trimEnd();
}

export function ConversationUserInputEpilogue({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const label = intl.formatMessage({ id: "chat.userInput.epilogue.label" });
  return (
    <div data-v4-user-input-epilogue="true" className="flex min-w-0 flex-col gap-1">
      <button
        aria-expanded={open}
        className="flex items-center gap-1 self-start rounded-md text-ui-xs text-foreground-subtlest transition-colors hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
        )}
        {label}
      </button>
      {open ? (
        // The epilogue contains an indented JSON Schema; render it as preformatted monospace in a secondary color because it is reference material, not message body text.
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle"
          data-v4-user-input-epilogue-body="true"
        >
          {trimEpilogueLead(text)}
        </pre>
      ) : null}
    </div>
  );
}
