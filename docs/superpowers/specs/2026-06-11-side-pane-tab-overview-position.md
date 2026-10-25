# Side Pane Tab Overview Entry Position

The side pane tab overview entry — search across open tabs and recently closed tabs — sits on the left of the side pane tabs as the leading tab-navigation control, with the `ChevronsDownIcon` icon ("expand/view tab list" semantics), not in the right-side tool area next to the "new tab" button.

Rules:

- Search, switch, close, and reopen-recently-closed behavior is unchanged.
- When the tabs overflow horizontally, the gradient mask shows only on the side that can still scroll, based on current scroll position.
- Tab data structure, the new-tab menu contents, and mobile side pane layout semantics are unchanged.
- The entry keeps the existing i18n copy (`sidePane.tabOverview`, `sidePane.searchTabs`).
