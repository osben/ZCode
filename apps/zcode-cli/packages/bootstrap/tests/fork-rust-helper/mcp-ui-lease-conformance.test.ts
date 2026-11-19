// Fork (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers (F7)", PRs 1-2): the Node half of the lease and
// sampling conformance. The same request sequence runs in Rust (protocol-zcode `fork/mcp_ui_lease_conformance_tests.rs`)
// against the lease registry and the sampling ledger; here it runs against `McpUiInstances` and `McpUiSamplingCalls`,
// and every step must give the same outcome.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpUiInstances, McpUiSamplingCalls } from "../../src/zcode-protocol/mcp-ui/contract.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../../../../packages/rust-cli/crates/protocol-zcode/tests/fixtures/mcp_ui_lease_conformance.json",
    import.meta.url,
  ),
);

interface Connection {
  identity: string;
  generation: number;
}

interface Step {
  op: string;
  as?: string;
  lease?: string;
  session?: string;
  server?: string;
  scope?: string;
  source?: "current" | Connection;
  call?: string;
  onlyIfIdle?: boolean;
  operation?: string;
  run?: "hold" | "reply";
  sample?: string;
  expect: string;
}

interface Fixture {
  server: { name: string; identity: string; generation: number };
  steps: Step[];
}

const UNAUTHORIZED = "MCP App instance is no longer authorized";
const STARTED = "started";

/** How a sampling settled: its value, or the message of its error. */
type Settled = { done: unknown } | { failed: string };

/** The outcome word of a sampling error, by the texts Node's ledger uses (the same words as the Rust runner). */
function classify(message: string): string {
  if (message.includes("Duplicate")) return "duplicate";
  if (message.includes("busy")) return "busy";
  if (message.includes("limit")) return "limit";
  if (message.includes(UNAUTHORIZED)) return "unauthorized";
  if (message.includes("timed out")) return "timedOut";
  if (message.includes("cancelled")) return "cancelled";
  return "error";
}

function classifySettled(settled: Settled): string {
  return "done" in settled ? "done" : classify(settled.failed);
}

function settle(promise: Promise<unknown>): Promise<Settled> {
  return promise.then(
    (done): Settled => ({ done }),
    (error: Error): Settled => ({ failed: error.message }),
  );
}

/** Resolves once the synchronous admission and any settled run have had their turn. */
function flushed(): Promise<typeof STARTED> {
  return new Promise((resolve) => setImmediate(() => resolve(STARTED)));
}

async function runSequence(fixture: Fixture): Promise<string[]> {
  const instances = new McpUiInstances();
  const calls = new McpUiSamplingCalls();
  const serverName = fixture.server.name;
  let current: Connection = {
    identity: fixture.server.identity,
    generation: fixture.server.generation,
  };
  // alias -> lease, in the order the fixture named them.
  const leases = new Map<string, ReturnType<McpUiInstances["open"]>>();
  const pins = new Map<string, { release(): void }>();
  // alias -> the settlement of a sampling that was still running when its step ended.
  const samples = new Map<string, Promise<Settled>>();
  const sessions = [...new Set(fixture.steps.map((step) => step.session).filter(Boolean))] as string[];

  const leaseOf = (step: Step) => {
    const lease = leases.get(step.lease ?? "");
    if (!lease) throw new Error(`unknown lease alias ${step.lease}`);
    return lease;
  };
  const sourceOf = (step: Step): Connection =>
    step.source === "current" || step.source === undefined ? current : step.source;
  const scopeOf = (step: Step) => ({
    sessionId: step.session ?? "",
    pluginId: "p",
    serverName: step.server ?? serverName,
    workspace: { workspacePath: "/w" },
  });
  const isLive = (lease: ReturnType<McpUiInstances["open"]>) => instances.find(lease.token) !== undefined;

  const run = async (step: Step): Promise<string> => {
    switch (step.op) {
      case "open": {
        const session = step.session ?? "";
        const lease = instances.open(
          {
            workspace: "/w",
            sessionId: session,
            pluginId: "p",
            serverName: step.server ?? serverName,
            scopeId: step.scope ?? "",
            resourceUri: "ui://a",
            ownerWebContentsId: 7,
          },
          sourceOf(step),
        );
        const reused = [...leases.values()].some((known) => known.token === lease.token);
        leases.set(step.as ?? "", lease);
        return reused ? "reused" : "opened";
      }
      case "validate": {
        const lease = leaseOf(step);
        try {
          instances.validate(lease, scopeOf(step), sourceOf(step));
          return "ok";
        } catch (error) {
          expect((error as Error).message).toBe(UNAUTHORIZED);
          return "unauthorized";
        }
      }
      case "retain": {
        const lease = leaseOf(step);
        try {
          const pin = instances.retain(lease.token, step.call ?? "");
          pins.set(step.call ?? "", pin);
          return "pinned";
        } catch (error) {
          expect((error as Error).message).toBe(UNAUTHORIZED);
          return "unauthorized";
        }
      }
      case "release": {
        pins.get(step.call ?? "")?.release();
        return "ok";
      }
      case "busy":
        return instances.isBusy(leaseOf(step)) ? "busy" : "idle";
      case "close": {
        const lease = leaseOf(step);
        // Node closeMcpUiInstance: a busy panel under onlyIfIdle is kept open.
        if (step.onlyIfIdle && instances.isBusy(lease)) return "not-closed";
        return instances.close(lease) ? "closed" : "not-closed";
      }
      case "reconnect": {
        current = { ...current, generation: current.generation + 1 };
        // Node: onAppConnectionInvalidated closes the server's leases in each session; closing a lease aborts its
        // cancel signal, which cancels its sampling operations.
        const revoked: string[] = [];
        for (const session of sessions) {
          for (const [alias, lease] of leases) {
            const record = instances.find(lease.token);
            if (record?.binding.sessionId === session && record.binding.serverName === serverName) {
              instances.close(lease);
              revoked.push(alias);
            }
          }
        }
        return `revoked:${revoked.sort().join(",")}`;
      }
      case "closeSession": {
        const session = step.session ?? "";
        const live = [...leases].filter(([, lease]) => isLive(lease));
        instances.closeSession(session);
        const closed = live.filter(([, lease]) => !isLive(lease)).map(([alias]) => alias);
        return `closedSession:${closed.sort().join(",")}`;
      }
      case "sample": {
        const lease = leaseOf(step);
        let cancel: AbortSignal;
        try {
          cancel = instances.validate(lease, scopeOf(step), sourceOf(step)).cancel.signal;
        } catch (error) {
          expect((error as Error).message).toBe(UNAUTHORIZED);
          return "unauthorized";
        }
        const hold = step.run === "hold";
        const pending = calls.execute(
          { token: lease.token, sessionId: step.session ?? "", signal: cancel },
          step.operation ?? "",
          async () => {
            if (hold) await new Promise<never>(() => {});
            return "reply";
          },
        );
        const settled = settle(pending);
        const first = await Promise.race([settled, flushed()]);
        if (first === STARTED) {
          samples.set(step.as ?? "", settled);
          return STARTED;
        }
        samples.set(step.as ?? "", Promise.resolve(first));
        return classifySettled(first);
      }
      case "cancelSample": {
        const lease = leaseOf(step);
        let cancel: AbortSignal;
        try {
          cancel = instances.validate(lease, scopeOf(step), sourceOf(step)).cancel.signal;
        } catch (error) {
          expect((error as Error).message).toBe(UNAUTHORIZED);
          return "unauthorized";
        }
        try {
          const { cancelled } = calls.cancel(
            { token: lease.token, sessionId: step.session ?? "", signal: cancel },
            step.operation ?? "",
          );
          return cancelled ? "cancelled" : "not-cancelled";
        } catch (error) {
          return classify((error as Error).message);
        }
      }
      case "collect": {
        const settled = samples.get(step.sample ?? "");
        if (!settled) throw new Error(`no running sample ${step.sample}`);
        return classifySettled(await settled);
      }
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  };

  const actual: string[] = [];
  for (const step of fixture.steps) actual.push(await run(step));
  return actual;
}

describe("MCP App lease and sampling conformance (Node half)", () => {
  it("McpUiInstances and McpUiSamplingCalls match every expected outcome of the shared fixture", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
    const actual = await runSequence(fixture);
    const expected = fixture.steps.map((step) => step.expect);
    const mismatches = expected
      .map((want, index) => ({ index, want, got: actual[index] }))
      .filter(({ want, got }) => want !== got);
    expect(mismatches).toEqual([]);
  });
});
