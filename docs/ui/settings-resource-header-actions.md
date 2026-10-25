# Settings Resource Header Actions

The top right of the list group of Memory, Subagents, Plugins, MCPs, Skills, Commands and Hooks shows
the same actions:

```text
[ … ]     [↻]      [New]
 outline   outline   default
  ├─ Import
  └─ Export
```

1. Refresh is a fixed `size="icon-md"` icon button with a Tooltip and an accessible name.
2. Import and Export live in a `size="icon-md"` more-actions menu.
3. An action with no implementation (no callback passed) is not rendered; when neither Import nor Export
   is implemented, the more-actions button is not rendered.
4. An implemented action restricted by the current Scope or environment shows disabled through the
   `*Disabled` props.
5. New is fixed at `size="default"`, `rounded-lg`; the order cannot change.
6. Existing capabilities keep calling each resource's own service/store; data submission logic is not
   shared.
7. Unimplemented capabilities must be hidden; binding an empty `onClick` is forbidden. A later
   implementation only passes the callback to the shared button group.
8. Large guide buttons in empty states are out of scope and follow resource semantics.
9. Desktop, Web and mobile widths use the same button order; the container may wrap.

## Current Capability Matrix

| Resource  | Refresh               | Import      | Export      | New         |
| --------- | --------------------- | ----------- | ----------- | ----------- |
| Memory    | implemented           | placeholder | placeholder | placeholder |
| Subagents | existing data refresh | placeholder | placeholder | implemented |
| Plugins   | existing reload entry | placeholder | placeholder | implemented |
| MCPs      | implemented           | implemented | placeholder | implemented |
| Skills    | existing data refresh | implemented | placeholder | implemented |
| Commands  | existing data refresh | implemented | placeholder | implemented |
| Hooks     | existing reload entry | placeholder | placeholder | implemented |
