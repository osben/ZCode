// Fork F4 D2 (specs/fork-rust-node-helper.md "D2 end-of-turn screenshot", D2-H). Node's
// appendBrowserTurnScreenshot (core/src/runtime/methods/browser-turn-screenshot.ts) is the oracle: list the
// session's tabs, screenshot the active one, answer the image; any broker failure answers {} and logs.
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "../../src/zcode-protocol/server-types.js";
import {
  ForkRustBrowserControl,
  turnScreenshotCancelParamsSchema,
} from "../../src/fork-rust-helper/browser-control.js";

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

type Answer = (command: Record<string, unknown>) => Record<string, unknown> | Error | Promise<Record<string, unknown>>;

function harness(answer: Answer, sessions: string[] = ["parent", "child"], logger?: Logger) {
  const sent: Sent[] = [];
  const context = {
    sessions: new Map(
      sessions.map((id) => [
        id,
        { sessionId: id, workspace: { workspacePath: "/work" }, deliveryKind: "desktop-continuous" },
      ]),
    ),
    requestClient: (
      method: string,
      params: Record<string, unknown>,
      _schema?: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      sent.push({ method, params });
      if (method !== "interaction/browserExecute") return Promise.resolve({});
      const response = answer(params.command as Record<string, unknown>);
      if (response instanceof Error) return Promise.reject(response);
      // As the Host request does: an abort of the call's signal rejects it.
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        options?.signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve(response).then(resolve, reject);
      });
    },
    deps: {},
    logger: undefined,
  } as unknown as ZCodeProtocolAgentServerContext;
  return { sent, control: new ForkRustBrowserControl({ context, logger }) };
}

/** A logger whose calls are recorded, so a test can assert the level and event of a log line. */
function recordingLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
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

  it("cancelling the capture aborts its broker calls, so Main is sent cancelRequest for the screenshot", async () => {
    const { control, sent } = harness((command) => {
      if (command.method === "list") return { ok: true, tabs: [{ tabId: "t1", active: true }] };
      if (command.method === "cancelRequest") return { ok: true };
      return new Promise<Record<string, unknown>>(() => {}); // the screenshot stays in flight until it is aborted
    });
    const answered = control.turnScreenshot(request);
    await vi.waitFor(() => expect(executes(sent)).toHaveLength(2));
    control.cancelTurnScreenshot(request.sessionId, request.turnId);
    await expect(answered).resolves.toEqual({});
    await vi.waitFor(() => expect(executes(sent)).toHaveLength(3));
    const methods = executes(sent).map((call) => (call.params.command as { method: string }).method);
    expect(methods).toEqual(["list", "screenshot", "cancelRequest"]);
  });

  it("logs a capture cancelled with its turn at debug under its own event, not as a failure", async () => {
    const logger = recordingLogger();
    const { control, sent } = harness(
      (command) => {
        if (command.method === "list") return { ok: true, tabs: [{ tabId: "t1", active: true }] };
        if (command.method === "cancelRequest") return { ok: true };
        return new Promise<Record<string, unknown>>(() => {}); // held until the abort reaches it
      },
      ["parent", "child"],
      logger as unknown as Logger,
    );
    const answered = control.turnScreenshot(request);
    await vi.waitFor(() => expect(executes(sent)).toHaveLength(2));
    control.cancelTurnScreenshot(request.sessionId, request.turnId);
    await expect(answered).resolves.toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "Browser turn screenshot cancelled with the turn",
      expect.objectContaining({ event: "fork_rust_helper.browser.turn_screenshot_cancelled" }),
    );
  });
});

describe("helper turn screenshot cancel params (F4 D2 C1)", () => {
  it("accept exactly the turn key", () => {
    expect(turnScreenshotCancelParamsSchema.safeParse({ sessionId: "s1", turnId: "turn-1" }).success).toBe(true);
    expect(turnScreenshotCancelParamsSchema.safeParse({ sessionId: "s1" }).success).toBe(false);
    expect(turnScreenshotCancelParamsSchema.safeParse({ sessionId: " ", turnId: "turn-1" }).success).toBe(false);
  });

  it("refuse the capture's other fields, as the strict wire shape does", () => {
    expect(
      turnScreenshotCancelParamsSchema.safeParse({ sessionId: "s1", turnId: "turn-1", browserId: "iab-1" }).success,
    ).toBe(false);
  });
});
