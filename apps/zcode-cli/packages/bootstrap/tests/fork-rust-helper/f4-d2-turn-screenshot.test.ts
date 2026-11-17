// Fork F4 D2 (specs/fork-rust-node-helper.md "D2 end-of-turn screenshot", D2-H). Node's
// appendBrowserTurnScreenshot (core/src/runtime/methods/browser-turn-screenshot.ts) is the oracle: list the
// session's tabs, screenshot the active one, answer the image; any broker failure answers {} and logs.
import { describe, expect, it } from "vitest";
import type { ZCodeProtocolAgentServerContext } from "../../src/zcode-protocol/server-types.js";
import { ForkRustBrowserControl } from "../../src/fork-rust-helper/browser-control.js";

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

type Answer = (command: Record<string, unknown>) => Record<string, unknown> | Error;

function harness(answer: Answer, sessions: string[] = ["parent", "child"]) {
  const sent: Sent[] = [];
  const context = {
    sessions: new Map(
      sessions.map((id) => [
        id,
        { sessionId: id, workspace: { workspacePath: "/work" }, deliveryKind: "desktop-continuous" },
      ]),
    ),
    requestClient: (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method !== "interaction/browserExecute") return Promise.resolve({});
      const response = answer(params.command as Record<string, unknown>);
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
    deps: {},
    logger: undefined,
  } as unknown as ZCodeProtocolAgentServerContext;
  return { sent, control: new ForkRustBrowserControl({ context }) };
}

const request = { sessionId: "parent", turnId: "turn-1", browserId: "iab-1", browserGeneration: 2 };
const image = { base64: "AAAA", mimeType: "image/png" };
const executes = (sent: Sent[]) => sent.filter((call) => call.method === "interaction/browserExecute");

describe("helper turn screenshot (F4 D2-H)", () => {
  it("lists the tabs, then screenshots the active tab and answers the image", async () => {
    const { control, sent } = harness((command) => {
      if (command.method === "list") {
        return { ok: true, tabs: [{ tabId: "t1", active: false }, { tabId: "t2", active: true }] };
      }
      if (command.method === "screenshot") return { ok: true, image };
      return { ok: true };
    });
    await expect(control.turnScreenshot(request)).resolves.toEqual({ image });
    const methods = executes(sent).map((call) => (call.params.command as { method: string }).method);
    expect(methods).toEqual(["list", "screenshot"]);
    expect((executes(sent)[1].params.command as { tabId: string }).tabId).toBe("t2");
  });

  it("answers {} without a screenshot when no tab is active (Node skips with no active tab)", async () => {
    const { control, sent } = harness(() => ({ ok: true, tabs: [{ tabId: "t1", active: false }] }));
    await expect(control.turnScreenshot(request)).resolves.toEqual({});
    expect(executes(sent)).toHaveLength(1);
  });

  it("answers {} when the screenshot is refused, as Node records a capture failure and continues", async () => {
    const { control } = harness((command) =>
      command.method === "list"
        ? { ok: true, tabs: [{ tabId: "t1", active: true }] }
        : { ok: false, error: { code: "unavailable", message: "no page" } },
    );
    await expect(control.turnScreenshot(request)).resolves.toEqual({});
  });

  it("answers {} when the Host request fails, without throwing into the turn", async () => {
    const { control } = harness(() => new Error("Main went away"));
    await expect(control.turnScreenshot(request)).resolves.toEqual({});
  });

  it("uses the child session's broker port for a registered subagent", async () => {
    const { control, sent } = harness(
      (command) => (command.method === "list" ? { ok: true, tabs: [] } : { ok: true }),
      ["parent", "child"],
    );
    control.childSession({ childSessionId: "child", parentSessionId: "parent", tabOwner: "parent" });
    await control.turnScreenshot({ ...request, sessionId: "child" });
    const browserExecute = executes(sent);
    expect(browserExecute).toHaveLength(1);
    // tabOwner "parent": the Host sees the parent's session, as Node's broker routes a subagent's tab (F4-D5).
    expect(browserExecute[0].params.sessionId).toBe("parent");
  });
});
