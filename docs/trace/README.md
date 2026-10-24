# CLI Agent Trace

Defines the OpenTelemetry execution chain of the internal Agent in `apps/zcode-cli`. Two tiers: the core
spec defines stable design, boundaries and integration; the references expand low-level concepts, full
fields, and runtime and operations detail.

## Document structure

| Tier      | Document                                                                                  | Content                                                                          |
| --------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Core spec | [CLI Agent Telemetry design and development spec](./cli-agent-telemetry.md)               | Data model, topology, principles, integration, privacy constraints, queries      |
| Reference | [OpenTelemetry concepts and ZCode choices](./reference/otel-concepts.md)                  | Resource, Context, SpanContext, Parent, Link, Event, ...                         |
| Reference | [Span, Attribute, Event and Metric dictionary](./reference/schema-reference.md)           | Full fields, enums, missing semantics, compatibility projection, events, metrics |
| Reference | [Runtime, privacy, performance and ARMS reference](./reference/runtime-and-operations.md) | Runtime lifecycle, propagation, sanitizing, capacity, tests, queries, Dashboards |

The core spec and references together describe the current implementation: design principles and
business integration follow the core spec; field definitions, runtime behavior and platform statistic
definitions follow the matching reference; method signatures and type constraints follow the TypeScript
Contracts.

## Adjacent but independent local observability

- [Desktop Renderer user action Trace](./desktop-renderer-user-action-trace.md)
- [CLI local Usage Observability](../../apps/zcode-cli/docs/design/v2/usage-observability.md)
- [CLI local Debug Observability](../../apps/zcode-cli/docs/design/v2/debug-observability.md)

Desktop Renderer Trace records only Desktop UI semantic actions and does not propagate to the CLI. The
Usage and Debug documents stay in the CLI package and describe the local SQLite fact source and local
debugging facilities. They are not part of the CLI Agent ARMS Trace Schema and can be used for Trace
reconciliation and fault diagnosis.

## Historical designs

For traceability only; never a basis for new Spans, Attributes, Events, Metrics, queries or dashboards:

- [V1 Model API observability design](./archive/model-api-observability-v1.md)
- [V2 Turn Trace observability design](./archive/turn-trace-observability-v2.md)
- [V4 to V5 upgrade design](./archive/telemetry-v4-to-v5-upgrade-design.md)

## Maintenance rules

1. Update the core spec when overall principles, integration interfaces or system boundaries change.
2. Adding or changing a Span, Attribute, Event, Metric, enum, compatibility alias, privacy rule or
   statistic definition must update the matching reference; the full field dictionary is maintained in
   step with code changes.
3. Phase reviews and migration plans move to `archive/` when done; no multiple versions in the main
   directory.
4. Code, tests, ARMS queries and Dashboards must not depend on archived documents.
