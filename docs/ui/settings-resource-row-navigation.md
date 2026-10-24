# Settings Resource List Row Navigation

## Scope

The four resource lists Commands, Subagents, MCP Servers and Hooks in Settings use the whole row as the edit
entry and no longer show a separate edit icon button. The project rows and file rows of Memory and the detail
entry of Skills follow the same list drill-down interaction.

## Interaction Constraints

1. Only ZCode-managed editable resource rows can open the edit page; built-in, plugin-managed and compatibility
   sources stay read-only.
2. Clicking a non-action area of an editable row with the mouse opens the matching edit page. An editable row is
   focusable and opens the edit page with `Enter` and `Space`.
3. In-row switches, delete, authorization, model selection and similar controls stay independent; their click
   or keyboard operation must not trigger row navigation.
4. An editable row explicitly uses `cursor-default` to keep an ordinary arrow cursor and uniformly
   `hover:bg-hover` feedback; a read-only row does not pose as a clickable entry.
5. Desktop and mobile Web use the same row interaction and do not rely on hover to discover the entry.
6. All drillable Memory project rows and file rows use the same ordinary arrow cursor as other resource rows.
   The main project area and file rows of Memory use `div[role="button"][tabindex="0"]` and reuse the resource
   row's Enter / Space keyboard activation; the File Tree on the right of a project row stays an independent
   Button.

## Delete Entry on the Edit Page

- The existing edit pages of Command, Subagent, MCP Server and Hook uniformly show a delete entry at the bottom
  of the form; the create page does not.
- The delete entry follows Subagent: on the left `Button variant="link" size="lg"` with
  `px-0 text-destructive hover:text-destructive` and `Trash2 size-3.5`; the Save, Cancel group stays
  right-aligned.
- List rows no longer repeat a delete button. Delete still goes through each resource's existing confirm
  dialog and returns to the list on success.

## Subagent Row Info

Subagents are already grouped as User, Plugin, Built-in, so rows no longer repeat a scope label. Rows keep
showing the model (non-built-in items), tools, description, path and the matching actions.
