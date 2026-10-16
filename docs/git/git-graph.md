# Git Graph

Git Graph is the read-only commit graph entry in Git operation dropdown menu, used to view recent repository commits, branch lanes, merge edges and refs.

## Design Boundaries

- UI consumes structured data through `IGitService.getCommitGraph({ workspacePath, maxCount, skip })` in pagination, does not directly call Git CLI.
- services/repo layer uses `git log --all --topo-order --date-order` to read commits, parents, refs, author and time.
- `layoutGitGraph(commits)` is a pure function, takes topo/date sorted commits as input, outputs row coordinates, lane, edge path and truncation status.
- SVG renderer only responsible for displaying nodes, lines, hover, selected, ref chip; window external parent uses dashed edge to indicate truncation.
- UI uses semantic tokens from `DESIGN.md`, avoids adding new graphical libraries, compatible with desktop and Web themes.

## Current Limitations

- Default loads 50 commits per page, after clicking "load more commits" reads next page through `skip`; repo layer single page maximum allows 200 commits.
- Current entry is popup view, not doing infinite scroll, search, checkout or diff linkage yet.
- Empty repository returns empty list, UI displays empty state.
