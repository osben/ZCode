import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startRelay, type RelayHarness } from "./support/relayHarness.js";

const cleanup: RelayHarness[] = [];
afterEach(async () => {
  for (const harness of cleanup.splice(0)) await harness.close();
  vi.restoreAllMocks();
});

async function paired(harness: RelayHarness, bearer: string) {
  const { device_sid: sid } = await harness.register(bearer);
  const dev = await harness.connect(bearer, "device");
  dev.send({ type: "auth_init", device_sid: sid });
  await dev.next("auth_ack");
  const term = await harness.connect(bearer, "terminal");
  term.send({ type: "auth_init", device_sid: sid });
  await term.next("auth_ack");
  await dev.next("pair_status_ack");
  return { dev, term };
}

/**
 * Holds back only the write-completion callbacks of relayed data frames, so the relay's
 * outbound accounting stays reserved until the test releases each one.
 */
function delayDataWriteCompletions() {
  const original = WebSocket.prototype.send;
  const complete: Array<() => void> = [];
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(
    function (this: WebSocket, data, options, callback) {
      const done = typeof options === "function" ? options : callback;
      if (done && typeof data === "string" && JSON.parse(data).type === "data") {
        original.call(this, data, {});
        complete.push(() => done());
      } else {
        original.call(this, data, options as never, callback as never);
      }
    },
  );
  return complete;
}

const frame = { type: "data", payload: "x".repeat(3000) };

it("bounds all pending relay writes and releases closed sockets without double-releasing late callbacks", async () => {
  // Budgets: one relayed frame is about 3 KB on the wire, so two pending frames fit and a third does not.
  const harness = await startRelay({
    maxBufferedBytes: 8000,
    maxTotalBufferedBytes: 7000,
  });
  cleanup.push(harness);
  const bearer = await harness.relayJwt();
  const a = await paired(harness, bearer);
  const b = await paired(harness, bearer);
  const c = await paired(harness, bearer);
  const d = await paired(harness, bearer);
  const e = await paired(harness, bearer);
  const complete = delayDataWriteCompletions();

  a.term.send(frame);
  expect(await a.dev.next("data")).toMatchObject({ payload: frame.payload });
  b.term.send(frame);
  expect(await b.dev.next("data")).toMatchObject({ payload: frame.payload });

  // Aggregate budget exhausted: the relay closes the receiving device socket with 1013.
  const cClosed = c.dev.closedWith();
  c.term.send(frame);
  expect(await cClosed).toBe(1013);

  // Closing a's device releases its pending frame; the terminal's waiting status is the barrier.
  const aClosed = a.dev.closedWith();
  a.dev.terminate();
  await aClosed;
  expect(await a.term.next("pair_status_ack")).toMatchObject({
    pair_status: "waiting",
  });

  d.term.send(frame);
  expect(await d.dev.next("data")).toMatchObject({ payload: frame.payload });

  // a's late write callback must not release anything a second time: the budget stays full.
  complete[0]!();
  e.term.send(frame);
  const eClosed = e.dev.closedWith();
  expect(await eClosed).toBe(1013);

  // Releasing b's and d's callbacks frees the budget again.
  complete[1]!();
  complete[2]!();
  d.term.send(frame);
  expect(await d.dev.next("data")).toMatchObject({ payload: frame.payload });

  for (const pair of [a, b, c, d, e]) {
    pair.term.terminate();
    pair.dev.terminate();
  }
});

it("enforces the per-socket budget independently of the aggregate budget", async () => {
  const harness = await startRelay({
    maxBufferedBytes: 4000,
    maxTotalBufferedBytes: 12000,
  });
  cleanup.push(harness);
  const bearer = await harness.relayJwt();
  const a = await paired(harness, bearer);
  const b = await paired(harness, bearer);
  delayDataWriteCompletions();

  a.term.send(frame);
  expect(await a.dev.next("data")).toMatchObject({ payload: frame.payload });
  const closed = a.dev.closedWith();
  a.term.send(frame);
  expect(await closed).toBe(1013);

  b.term.send(frame);
  expect(await b.dev.next("data")).toMatchObject({ payload: frame.payload });
  a.term.terminate();
  b.term.terminate();
  b.dev.terminate();
});
