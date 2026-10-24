# Provider-visible content assembly

## Scope

Adjusts existing ZCode model-visible surfaces: the long communication section in first-turn non-tool-search
trajectories, the shared act-don't-rederive section, the autonomy appendix on the target branch, the
Harness MCS description, and one wording change for research/exploration in EnterPlanMode. It also fixes
the exact text and separators of the request-level user context and the text-attachment reminder. Agent
provider content is out of scope.

## Assembly constraints

- Existing ZCode prompt characters are not modified; the original text stays in `default`.
- New content lives in `additional`, is loaded unconditionally, and has no model or provider checks.
- Communication comes before action caution.
- Communication, action caution and the stable `# Harness` are independent of the output style's
  `keepCodingInstructions`. Target assembly uses that field only for the separate doing-tasks coding
  instructions. ZCode has no such separate section today, so `keepCodingInstructions: false` must not
  remove any `# Harness` content.
- The active output style is assembled strictly as `# Output Style: <name>\n<prompt>`, with no blank line
  between title and body.
- After context management, assemble act-don't-rederive, then the four autonomy appendix paragraphs; git
  context (if present) stays after them.
- The EnterPlanMode input schema stays a strict empty object; only the research/exploration sentence
  changes, to `use the Agent tool instead`.
- The final `IMPORTANT:` paragraph of the request-level user context keeps its six leading spaces.
- The synthetic Read reminder body for one text attachment joins lines with a single newline; different
  attachments in the same MCS turn are still joined with a blank line. Live and resume use the same
  assembly rules.

## Exact-word baseline

- Communication uses the long text; it reuses the existing code-style sentence, which appears once.
- act-don't-rederive is 277 characters with no trailing period.
- The autonomy appendix is 1354 characters in four paragraphs.
- Harness uses the mid-conversation system turn wording and no longer describes tag injection into
  messages or tool results.
- A text attachment truncated at the default limit says `first 2000 lines` and tells the model to keep
  reading the file on demand.

## Non-goals

- No change to betas, product-specific content, deferred tools, the Agent provider catalog, or how system
  blocks are merged.
- No other dynamic sections, runtime switches or fallbacks.

## Acceptance

- Unit tests check exact wording, single occurrence and relative order.
- A unit test covers an active output style with `keepCodingInstructions: false` and confirms the stable
  `# Harness`, communication and action caution are still present.
- A unit test checks exactly one newline between the output-style title and body.
- Runtime tests check the final first-turn provider-visible request, not only intermediate sections.
- Attachment and resume tests check single newline for the same attachment, blank line between different
  attachments, the truncation text, and consistency after resume.
- `prompt-trajectory` runs the full runtime/proxy/derive chain with a mock provider, covering MCS, memory,
  request-level context and attachments; the generated trajectory is checked against this scope and the
  exact-word baseline.
