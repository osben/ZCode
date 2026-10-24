# Settings Form Layout

## Background

New and edit forms in Settings keep a light card boundary without a card background color. Radius, border and
padding keep providing form grouping, and the transparent background avoids a too heavy nesting level when
entering a form from a list, keeping desktop and Web at a consistent information density.

## Spec

1. The form root uses a natural `space-y-*` vertical layout with the `rounded-xl border border-border p-4`
   card boundary but no `bg-card` background; Subagent, MCP Server, Command and Hook forms all obey this.
2. Description text under the form title uses `text-ui-base text-foreground-subtle`.
3. The new/edit pages of Automations scheduled and idle-time tasks show a content title and subtitle after the
   breadcrumb: the title uses `text-ui-xl font-semibold text-foreground`, the subtitle the helper style above;
   the title switches with the new/edit state and the task name does not replace the page action title.
4. Field labels use `text-ui-base font-medium text-foreground-subtle`.
5. Ordinary fields use the existing `Input` / `Textarea` / `Select` components with `size="lg"`.
6. The Model picker of the Subagent form, though reusing the toolbar `ModelConfigSelect`, must use
   `bg-clip-border` on its trigger to override Button's base `bg-clip-padding`, keeping the same input
   background boundary as an ordinary Select.
7. Multi-line fields uniformly use the shared Settings Textarea, applying
   `rounded-lg border border-input-border bg-input px-2 py-2` directly on the textarea root with no wrapper
   added only for visual style.
8. `SelectTrigger` does not use `bg-clip-padding`, avoiding an extra background-clipping layer in a
   transparent card.
9. The Hook Runner uses a `size="lg"` Select consistent with Scope and Event; `process` and `command` stay
   mutually exclusive execution modes and keep driving the Args or Shell/Async fields below.
10. New/edit resource forms reuse a unified action bar: Delete appears only in edit state and sits on the
    left; Save and Cancel sit on the right in the fixed order Save -> Cancel. Narrow screens may stack the bar
    vertically but Save and Cancel stay right-aligned. Field hints sit above the action area and do not use the
    buttons' horizontal start.
11. The Hook form's first row shows Scope, Event, Runner side by side on desktop, falling back to a single
    column on narrow screens; Matcher and Command form a two-column execution config. Timeout, Status message
    and Custom JSON go into a default-collapsed Advanced area, lowering the first-screen height.
12. The User / Workspace tabs of the Hook list share a row with the new-session-effective hint, which follows
    right after the tabs and does not stick to the container's right side; narrow screens may wrap. The hint
    is ordinary helper text, with no card background, border, radius or whole-block padding.
13. Hook resources use the `Anchor` icon uniformly in the settings sidebar, list items and plugin capability
    details; a real Webhook channel still uses the `Webhook` icon.
14. Name and scope are shown as the main identity info of one row: the name field keeps a regular form width
    and does not fill the row; scope uses the inline label + `SelectTrigger size="lg"` style of the model
    settings "connection mode", stuck to the right, with the dropdown trigger at its natural text width and
    wrapping naturally on narrow screens.
15. Short identity fields in resource forms keep the same width, e.g. MCP server "Name" and "Type" and the
    command "Name" all use `w-48`.
16. The primary action area at the bottom is right-aligned, Cancel uses `ghost` and Save `default`; the
    primary action text of new and edit is uniformly "保存" (Save), never mixing "添加" or "创建".
17. The Save button is enabled whenever the form is valid: required fields, name format, model selection and
    JSON config all take part in immediate validity; it stays disabled while a save request is in flight to
    avoid duplicate submits. Specific error messages are still shown by submit validation or field
    interaction.
18. The action area in the header of resource lists such as Skills, MCP servers and Commands puts the "New"
    button first, then auxiliary actions such as import, open directory and refresh.
19. The back-to-list button uses `variant="link" size="sm"` with a left-arrow icon, default
    `text-foreground-subtle`, hover `text-foreground` with no underline, with `-ml-2` offsetting the visual
    indent so the text aligns with the left edge of the form content.
20. The form/JSON mode switch sits on the right of the title row, reusing the usage-stats range switch style:
    an outer `h-8 rounded-lg border border-border bg-background p-1`, with the selected item using
    `data-active:bg-secondary data-active:text-foreground`.
21. The type dropdown for a new MCP server temporarily does not show `Streamable HTTP`, since this transport
    type needs Agent-side support before being opened.

## Current Coverage

Model settings: new model provider; MCP servers, Commands, Subagent, Hook (user or workspace): new/edit;
Automations: new/edit of scheduled and idle-time tasks.
