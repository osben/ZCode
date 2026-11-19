// Fork (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers (F7)", PR 4): the Node half of the resource-
// subscription conformance. The same request sequence runs in Rust (protocol-zcode `fork/mcp_ui_rust/resource_conformance_tests.rs`)
// against the owner's methods. Here it runs against Node's own handlers (`createMcpUiHandlers`), the adapter's
// subscription registry (`McpResourceSubscriptionRegistry`), the instances (`mcpUiInstances`) and the notification
// routing (`routeMcpServerNotification`). The adapter's subscribe and unsubscribe glue is the runner's access object
// (the same few lines as `McpPort.subscribeResource` / `unsubscribeResource`). Every step's outcome must match.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import { McpResourceSubscriptionRegistry } from "../../../adapters/src/mcp/resource-subscriptions.js";
import {
  createMcpUiHandlers,
  mcpUiInstances,
  routeMcpServerNotification,
} from "../../src/zcode-protocol/mcp-ui/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../../../../packages/rust-cli/crates/protocol-zcode/tests/fixtures/mcp_ui_resource_subscriptions_conformance.json",
    import.meta.url,
  ),
);

interface Step {
  op: string;
  as?: string;
  session?: string;
  scope?: string;
  lease?: string;
  uri?: string;
  scopeOverride?: string;
  expect: string;
}

interface Fixture {
  server: { name: string; identity: string; generation: number };
  steps: Step[];
}

interface Lease {
  runtimeId: string;
  generation: number;
  token: string;
  appIdentity: string;
}

interface OpenLease {
  session: string;
  lease: Lease;
  closed: boolean;
}

const delivered = (sessions: string[]) => (sessions.length === 0 ? "none" : sessions.join(","));

async function runSequence(fixture: Fixture): Promise<string[]> {
  const serverName = fixture.server.name;
  let current = { identity: fixture.server.identity, generation: fixture.server.generation };
  const registry = new McpResourceSubscriptionRegistry();
  const serverRequests = { subscribe: 0, unsubscribe: 0 };
  const leases = new Map<string, OpenLease>();
  const sessions = new Map<string, unknown>();
  const events: Array<{ sessionId: string; type: string }> = [];
  const context = {
    sessions,
    v4Gateway: {
      ingest: (sessionId: string, event: { type: string }) => {
        events.push({ sessionId, type: event.type });
      },
    },
  } as never;

  // The adapter's subscribe and unsubscribe glue, as `McpPort` runs it on the server's connection.
  const access = {
    hasMcpServer: async (name: string) => name === serverName,
    subscribeResourceForUi: async (name: string, uri: string, key: string) => {
      if (registry.add(name, uri, key).first) serverRequests.subscribe += 1;
    },
    unsubscribeResourceForUi: async (name: string, uri: string, key: string) => {
      if (registry.remove(name, uri, key)?.last) serverRequests.unsubscribe += 1;
    },
  } as never;
  const handlers = createMcpUiHandlers();
  const dropPrefix = (prefix: string) => {
    const released = registry.removeByPrefix(prefix);
    serverRequests.unsubscribe += released.length;
    return released.length;
  };
  const sessionDeltas = (from: number, type: string) =>
    [
      ...new Set(
        events
          .slice(from)
          .filter((e) => e.type === type)
          .map((e) => e.sessionId),
      ),
    ].sort();

  const subscriberParams = (step: Step, open: OpenLease) => ({
    workspace: { workspacePath: "/w", workspaceKey: "/w" },
    sessionId: open.session,
    pluginId: "p",
    serverName,
    instance: open.lease,
    scopeId: step.scopeOverride ?? open.lease.token,
    generation: open.lease.generation,
    uri: step.uri ?? "",
  });
  const openOf = (step: Step): OpenLease => {
    const open = leases.get(step.lease ?? "");
    if (!open) throw new Error(`unknown lease ${step.lease}`);
    return open;
  };
  const classify = (error: unknown) => {
    const message = (error as Error).message;
    return message.includes("Invalid MCP App subscription binding")
      ? "refused:binding"
      : `error:${message}`;
  };

  const run = async (step: Step): Promise<string> => {
    switch (step.op) {
      case "openPanel": {
        const session = step.session ?? "";
        sessions.set(session, {
          app: {
            getMcpAppConnectionSnapshot: () => current,
            getPluginReferenceCatalog: () => ({ plugins: [] }),
          },
          traceContext: { traceId: "trace" },
        });
        const lease = mcpUiInstances.open(
          {
            workspace: "/w",
            sessionId: session,
            pluginId: "p",
            serverName,
            scopeId: step.scope ?? "",
            resourceUri: "ui://a",
            ownerWebContentsId: 7,
          } as never,
          current,
        ) as unknown as Lease;
        leases.set(step.as ?? "", { session, lease, closed: false });
        return "opened";
      }
      case "subscribe": {
        const open = openOf(step);
        try {
          await handlers.subscribeResource(access, subscriberParams(step, open) as never);
          return "subscribed";
        } catch (error) {
          return classify(error);
        }
      }
      case "unsubscribe": {
        const open = openOf(step);
        await handlers.unsubscribeResource(access, subscriberParams(step, open) as never);
        return "unsubscribed";
      }
      case "serverRequests":
        return `server:subscribe=${serverRequests.subscribe},unsubscribe=${serverRequests.unsubscribe}`;
      case "notifyUpdated": {
        const uri = step.uri ?? "";
        const mark = events.length;
        routeMcpServerNotification(context, {
          kind: "resourceUpdated",
          serverName,
          uri,
          subscribers: registry.subscribers(serverName, uri),
        } as never);
        return `delivered:${delivered(sessionDeltas(mark, SessionEventType.PluginUiResourceUpdated))}`;
      }
      case "notifyListChanged": {
        const mark = events.length;
        routeMcpServerNotification(context, {
          kind: "resourceListChanged",
          serverName,
          subscribers: registry.allSubscribers(serverName),
        } as never);
        return `delivered:${delivered(sessionDeltas(mark, SessionEventType.PluginUiResourceListChanged))}`;
      }
      case "closePanel": {
        const open = openOf(step);
        const closed = mcpUiInstances.close(open.lease as never);
        if (!closed) return "not-closed";
        open.closed = true;
        dropPrefix(`${open.session}|${open.lease.token}|`);
        return "closed";
      }
      case "reconnect": {
        current = { identity: current.identity, generation: current.generation + 1 };
        const revoked: string[] = [];
        for (const open of leases.values()) {
          if (open.closed) continue;
          if (mcpUiInstances.close(open.lease as never)) {
            open.closed = true;
            dropPrefix(`${open.session}|${open.lease.token}|`);
            revoked.push(open.session);
          }
        }
        return `revoked:${delivered(revoked.sort())}`;
      }
      default:
        return `unknown op ${step.op}`;
    }
  };

  const outcomes: string[] = [];
  for (const step of fixture.steps) outcomes.push(await run(step));
  return outcomes;
}

describe("MCP App resource subscriptions: the Rust owner's conformance fixture", () => {
  it("runs every step with the same outcome as the Rust owner", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
    const outcomes = await runSequence(fixture);
    expect(outcomes).toEqual(fixture.steps.map((step) => step.expect));
  });
});
