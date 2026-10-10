# Sidebar merged status icon

## Behavior

- A task whose branch merge status is `merged` keeps a compact status badge in both the regular and grouped sidebar task rows.
- The badge shows only the Lucide `GitMerge` icon; the localized `taskList.branchMergedTag` message remains its accessible name and hover title.
- The existing merged-state visibility and status priority stay unchanged.

## Acceptance scenarios

- When a regular sidebar task is merged, its status badge contains the Git merge icon and exposes the localized merged label to assistive technology and on hover.
- When a grouped sidebar task is merged, it shows the same icon-only badge and accessible label.
- Non-merged tasks do not render the merged badge.
