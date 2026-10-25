# Mention Node Tokens

> Current state: the input nodes and the V4 conversation user-message echo share these tokens.

`packages/ui/src/styles.css` has a set of theme tokens dedicated to prompt mention nodes:

- `--color-file-node`, `--color-file-node-hover`, `--color-file-node-foreground`
- `--color-skill-node`, `--color-skill-node-hover`, `--color-skill-node-foreground`
- `--color-command-node`, `--color-command-node-hover`, `--color-command-node-foreground`

Purpose:

- Unify the mention nodes in the prompt input and the echo style in `UserPrompt`.
- Let Zai Light / Zai Dark tune node colors separately; default light / dark remain only as the fallback
  token base.
- Avoid hard-coding `sky/violet/primary` Tailwind atomic colors in components.
- A mention node is a structured visual label, not a clickable control; input and message echo both use
  `cursor-default`.
- The command mention node's icon semantics stay stable: `/goal` uses target, `/compact` uses scroll-text,
  ordinary/custom slash commands use `square-slash`; color still goes through the command node token.

## V4 UserPrompt Echo Rules

The V4 conversation `userInput.text` keeps the raw mention markdown sent to the Agent; the display layer
restores structured labels with the old `UserMessage` semantics and must not expose internal paths or
session ids in the user bubble:

- `[$skill](.../SKILL.md)` and the old `$skill`: wand icon + readable skill name, `SKILL.md` path hidden.
- `[#title](#sess_xxx)` and bare `#sess_xxx`: conversation icon + title or session id; the session id in
  the markdown target is not repeated.
- `[filename](path)` and directory links: Material icon + label by file/directory type, markdown
  destination hidden.
- `@subagent`: Bot icon + subagent name.
- `/goal`, `/compact` and other slash commands: Goal, ScrollText and SquareSlash icons respectively.
- A leading `/goal` / `/target` that the send entry recognized as a goal control command is restored in the
  read-only user bubble as a `goal` / `target` mention label without `/`; the command node in the input
  keeps the original slash-command semantics.

`/goal` stays bound by the V4 command intent boundary: the `/` is omitted in the command label only when
the send entry recognized a goal control command; if it degraded to an ordinary prompt because of ordinary
attachments or hidden context, the original text must be kept and the semantics must not be re-guessed from
the text prefix. Copy and inline edit keep using the raw `userInput.text`; mention labels affect only
read-only display.

Code entry points:

- Theme variables: `packages/ui/src/styles.css`
- Mention style reuse: `packages/ui/src/mentions/mentionChip.ts`
- Command node icons and input node: `packages/ui/src/mentions/nodes/PromptMentionNode.ts`
- V4 user-message echo: `packages/ui/src/v4/ConversationRowView.tsx`

To adjust node colors later, change tokens first rather than atomic classes in components.
