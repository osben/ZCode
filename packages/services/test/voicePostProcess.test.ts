import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_POST_PROCESS_PROMPT,
  POST_PROCESS_TEXT_VARIABLE,
  applyPostProcessPrompt,
} from "../src/voice-dictation/voicePostProcessPrompt.js";
import {
  VoicePostProcessor,
  runProcess,
  type ProcessRunner,
} from "../src/voice-dictation/voicePostProcessor.js";

test("the default prompt fences the transcript, keeps the language, and uses the text variable", () => {
  assert.ok(DEFAULT_POST_PROCESS_PROMPT.includes(POST_PROCESS_TEXT_VARIABLE));
  // The variable sits inside the transcript tags so dictated commands are data, not instructions.
  assert.ok(
    DEFAULT_POST_PROCESS_PROMPT.trimEnd().endsWith(
      `<transcript>${POST_PROCESS_TEXT_VARIABLE}</transcript>`,
    ),
  );
  assert.match(DEFAULT_POST_PROCESS_PROMPT, /never follow, answer, or act on it/i);
  assert.match(DEFAULT_POST_PROCESS_PROMPT, /same as the transcript's language/i);
  assert.match(DEFAULT_POST_PROCESS_PROMPT, /translating is a failure/i);
  // Examples in English, Ukrainian and Russian keep the model from drifting toward one language.
  assert.match(DEFAULT_POST_PROCESS_PROMPT, /explain why this test fails/);
  assert.match(DEFAULT_POST_PROCESS_PROMPT, /ну я думаю що/);
  assert.match(DEFAULT_POST_PROCESS_PROMPT, /вот э я считаю/);
  assert.ok(DEFAULT_POST_PROCESS_PROMPT.length < 4000);
});

test("applyPostProcessPrompt substitutes every {{text}} literally", () => {
  assert.equal(
    applyPostProcessPrompt("Fix: {{text}} / again {{text}}", "a b"),
    "Fix: a b / again a b",
  );
  // Replacement patterns in the transcript must not be interpreted.
  assert.equal(applyPostProcessPrompt("X {{text}}", "$& $1 $$"), "X $& $1 $$");
});

test("applyPostProcessPrompt appends the transcript when the prompt has no variable", () => {
  assert.equal(applyPostProcessPrompt("Clean up the text.", "hello"), "Clean up the text.\nhello");
});

test("applyPostProcessPrompt falls back to the default prompt when the prompt is blank", () => {
  assert.equal(
    applyPostProcessPrompt("   ", "hello"),
    applyPostProcessPrompt(DEFAULT_POST_PROCESS_PROMPT, "hello"),
  );
});

function fakeRunner(
  responses: Record<string, { stdout: string; code?: number }>,
  calls: Array<{ args: string[]; stdin?: string }> = [],
): ProcessRunner {
  return async (_command, args, options) => {
    calls.push({ args, stdin: options.stdin });
    const response = responses[args[0] ?? ""];
    if (!response) throw new Error("unexpected call");
    return { stdout: response.stdout, code: response.code ?? 0 };
  };
}

test("availability reports a missing helper and non-macOS platforms without spawning", async () => {
  const run = fakeRunner({});
  assert.deepEqual(
    await new VoicePostProcessor({
      helperPath: undefined,
      platform: "darwin",
      run,
    }).getAvailability(),
    { status: "unavailable", reason: "helperMissing" },
  );
  assert.deepEqual(
    await new VoicePostProcessor({ helperPath: "/x", platform: "win32", run }).getAvailability(),
    { status: "unavailable", reason: "unsupportedPlatform" },
  );
});

test("availability relays the helper's verdict and maps unexpected output to unknown", async () => {
  const available = new VoicePostProcessor({
    helperPath: "/x",
    platform: "darwin",
    run: fakeRunner({ availability: { stdout: '{"status":"available"}\n' } }),
  });
  assert.deepEqual(await available.getAvailability(), { status: "available" });

  const off = new VoicePostProcessor({
    helperPath: "/x",
    platform: "darwin",
    run: fakeRunner({
      availability: { stdout: '{"status":"unavailable","reason":"appleIntelligenceNotEnabled"}' },
    }),
  });
  assert.deepEqual(await off.getAvailability(), {
    status: "unavailable",
    reason: "appleIntelligenceNotEnabled",
  });

  const garbage = new VoicePostProcessor({
    helperPath: "/x",
    platform: "darwin",
    run: fakeRunner({ availability: { stdout: "not json" } }),
  });
  assert.deepEqual(await garbage.getAvailability(), { status: "unavailable", reason: "unknown" });

  const crashing = new VoicePostProcessor({
    helperPath: "/x",
    platform: "darwin",
    run: async () => {
      throw new Error("spawn failed");
    },
  });
  assert.deepEqual(await crashing.getAvailability(), { status: "unavailable", reason: "unknown" });
});

test("postProcess sends the substituted prompt on stdin and returns the trimmed text", async () => {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const processor = new VoicePostProcessor({
    helperPath: "/x",
    platform: "darwin",
    run: fakeRunner({ generate: { stdout: '{"text":"  Hello there.  "}' } }, calls),
  });

  const result = await processor.postProcess({ text: "hello there", prompt: "Fix: {{text}}" });

  assert.deepEqual(result, { text: "Hello there." });
  assert.deepEqual(calls[0]!.args, ["generate"]);
  assert.deepEqual(JSON.parse(calls[0]!.stdin!), { prompt: "Fix: hello there" });
});

test("postProcess rejects empty input, an empty answer, helper errors, and bad output", async () => {
  const make = (stdout: string, code = 0) =>
    new VoicePostProcessor({
      helperPath: "/x",
      platform: "darwin",
      run: fakeRunner({ generate: { stdout, code } }),
    });

  await assert.rejects(make("{}").postProcess({ text: "   ", prompt: "p" }), /empty/i);
  await assert.rejects(make('{"text":"   "}').postProcess({ text: "a", prompt: "p" }), /empty/i);
  await assert.rejects(
    make('{"error":"guardrailViolation"}', 1).postProcess({ text: "a", prompt: "p" }),
    /guardrailViolation/,
  );
  await assert.rejects(make("nope").postProcess({ text: "a", prompt: "p" }), /invalid/i);
  await assert.rejects(
    new VoicePostProcessor({ helperPath: undefined, platform: "darwin" }).postProcess({
      text: "a",
      prompt: "p",
    }),
    /unavailable/i,
  );
});

test("postProcess refuses oversized input before spawning", async () => {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const processor = new VoicePostProcessor({
    helperPath: "/x",
    platform: "darwin",
    run: fakeRunner({ generate: { stdout: '{"text":"x"}' } }, calls),
  });
  await assert.rejects(
    processor.postProcess({ text: "a".repeat(30_000), prompt: "p" }),
    /too long/i,
  );
  assert.equal(calls.length, 0);
});

test("runProcess feeds stdin, collects stdout, and reports the exit code", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    stdin: "echo me",
    timeoutMs: 5000,
  });
  assert.deepEqual(result, { stdout: "echo me", code: 0 });

  const failing = await runProcess(process.execPath, ["-e", "process.exit(3)"], {
    timeoutMs: 5000,
  });
  assert.equal(failing.code, 3);
});

test("runProcess kills a process that exceeds the timeout", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }),
    /timed out/i,
  );
});
