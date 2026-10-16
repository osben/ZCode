# Monitoring Documentation Index

This directory retains App/RUM, Conversation business events, resource monitoring, product-specific telemetry, and test monitoring.

The CLI Agent OpenTelemetry execution chain has been independently moved to
[`docs/trace/`](../trace/README.md), no longer mixed with other monitoring documentation.

## App, Renderer & Process

- [Performance Monitoring](./performance-monitoring.md)
- [Performance Telemetry Event Dictionary](./performance-telemetry-catalog.md)
- [ARMS Electron Monitoring](./arms-browser-monitoring.md)
- [Agent Process Crash ARMS Reporting](./agent-process-crash-arms.md)
- [Full-Process CPU / Memory Telemetry](./process-resource-telemetry.md)
- [Full-Process Resource Dashboard & Queries](./dashboards/process-resource-dashboard.md)
- [MCP Process Lifecycle ARMS Reporting](./mcp-process-arms-telemetry.md)
- [Process Memory Local Diagnostic Log](./memory-diagnostics-log.md)

## Conversation & Business Events

- [V4 Conversation Telemetry Compatibility Spec](./conversation-telemetry-v4.md)
- [Business Quality Monitoring](./business-monitoring.md)
- [Agent Step Real Model & Token Attribution](./agent-step-model-token-attribution.md)

## Product Specials

- [Plan Usage ARMS Custom Event](./plan-usage-arms-telemetry.md)
- [Remote Usage Telemetry V1](./remote-usage-telemetry-v1.md)
- [Remote Workspace Connection ARMS Custom Event](./remote-usage-arms-telemetry.md)
- [Off-Peak Task Telemetry V1](./off-peak-task-telemetry-v1.md)
- [Session First Open ARMS Telemetry](./session-open-telemetry.md)
- [Automated Task / Off-Peak Task Message Telemetry](./automation-message-telemetry.md)

## Engineering Quality

- [E2E Metrics Bitable Dashboard](./e2e-metrics-bitable-dashboard.md)

All documentation in this directory is responsible for its own monitoring channel or product feature, and must not redefine the CLI Agent Trace Span, Attribute, Event, Metric, privacy, or statistical scope. Related changes must be uniformly updated
[`docs/trace/cli-agent-telemetry.md`](../trace/cli-agent-telemetry.md).
