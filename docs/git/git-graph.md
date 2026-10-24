# Git Graph

Git Graph is the read-only commit graph entry in the Git operation dropdown menu, for viewing recent repository commits, branch lanes, merge edges and refs.

## Design Boundaries

- UI consumes structured data through `IGitService.getCommitGraph({ workspacePath, maxCount, skip })` in pages and never calls the Git CLI directly.
- The services/repo layer reads commits, parents, refs, author and time with `git log --all --topo-order --date-order`.
- `layoutGitGraph(commits)` is a pure function: input is topo/date sorted commits; output is row coordinates, lane, edge path and truncation status.
- The SVG renderer only displays nodes, lines, hover, selected and ref chips; a dashed edge to a parent outside the window indicates truncation.
- UI uses semantic tokens from `DESIGN.md`, adds no graphics library, and is compatible with desktop and Web themes.

## Current Limitations

- Loads 50 commits per page by default; "load more commits" reads the next page through `skip`; the repo layer allows at most 200 commits per page.
- The entry is a popup view; no infinite scroll, search, checkout or diff linkage yet.
- An empty repository returns an empty list and UI shows an empty state.
