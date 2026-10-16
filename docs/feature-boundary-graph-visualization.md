# Feature Boundary Graph Visualization

## Goal

Provide a readable view of the `feature-boundary-planner` semantic graph in `@zcode/dev-docs`, replacing the need to inspect a large graph in the conversation area. The page reads `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` directly, allowing developers to trace capability nodes to UI entry points, state owners, services, persistence, and delivery boundaries.

## Product Boundaries

- YAML is the graph's single source of truth. Parse YAML at page-build time; do not maintain a second hand-authored set of node relationships.
- Show the complete semantic graph by default. Support finding nodes by keyword, narrowing edges by relationship level, and zooming, panning, and fitting the canvas to the view.
- After a node is selected, highlight only its first-degree neighbors and show the node type, ID, aliases, documentation, code seeds, invariants, and direct relationships in the detail panel.
- Display endpoints referenced in YAML but not declared in `nodes` as “undeclared endpoints”; do not automatically invent product semantics for them.
- The page is read-only: it must not edit YAML or interpret static reachability as a new product dependency.

## Implementation Constraints

- Use the existing `@xyflow/react` and dev-docs theme tokens, supporting light/dark themes and narrow layouts.
- If graph loading fails, show an explicit error state. Compute layout in the background and show a loading state on first render.
- Node and detail interactions must support keyboard input; expose selection state through `aria-live`.
- Use stable color/text combinations for relationships and node types; never communicate meaning through color alone.

## Verification Evidence

- Unit tests validate the number of nodes/edges after YAML parsing, preservation of undeclared endpoints, and direct-neighbor calculation.
- `@zcode/dev-docs` typecheck, lint, unit tests, and production build must pass.
