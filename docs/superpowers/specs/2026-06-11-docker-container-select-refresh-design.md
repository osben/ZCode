# Docker Container Select Refresh Design

The Docker remote connection dialog loads running containers once when the Docker settings step opens and held them for the dialog's lifetime, so the "Choose a running container" dropdown could show stale data. The list now refreshes when the dropdown opens.

Behavior:

- The Docker settings step keeps its first lazy availability/container load on open.
- Opening the dropdown triggers one refresh against the platform Docker APIs; closing does not. A refresh already in flight absorbs further open events (no second Docker command).
- Success replaces the list and reconciles the selection: a previously selected container no longer running is cleared, so the trigger shows the empty-state hint instead of a stale name.
- Failure keeps the previous list and surfaces the existing remote options load error banner.
- If Docker reports unavailable, the list is cleared (no daemon-backed list exists).
- The chooser uses the common `Popover + Command` searchable-dropdown pattern (not Radix `Select`), shows a loading indicator in the trigger and a loading row in the menu while refreshing, and a short grey "no running containers" hint when empty or unavailable.
- A separate manual "Container" input below the chooser covers incomplete lists or unavailable detection. Manual input and dropdown selection are independent state: choosing an item does not fill the input, typing does not change the selection. When the manual input is empty it shows a localized grey helper text about entering a container name or ID.

Connect resolution: non-empty manual input wins over the dropdown selection; empty manual input falls back to the selected container.

Boundaries: UI components never call Docker/platform APIs — `useRemoteConnectionForm` owns platform access and state; `RemoteConnectionFields` only reports that the select opened. Dropdown empty-state and helper texts are localized in `zh-CN` and `en-US`.

Verification: unit tests for refresh-on-open only, error reporting without throwing, stale selection cleared after refresh, `Popover + Command` rendering with loading and empty hints, manual input independence and helper text, and connect target preference (manual over dropdown, fallback when empty).
